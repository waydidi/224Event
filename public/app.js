// 224 Live House — customer QR ordering app (no framework, no inline scripts).
'use strict';

(() => {
  const $app = document.getElementById('app');
  const $banner = document.getElementById('banner');
  const $live = document.getElementById('live');
  const POLL_MS = 5000;

  const m = /^\/t\/([A-Za-z0-9_-]{1,128})\/?$/.exec(location.pathname);
  const qrToken = m ? m[1] : null;
  const storeKey = qrToken ? `224:visit:${qrToken}` : '';

  const state = {
    table: null, // { venue, table, session }
    token: null,
    status: null, // /session/status payload
    menu: null,
    view: 'loading', // waiting | join | main | ended | error | landing
    tab: 'menu', // menu | orders | bill
    category: 0,
    cart: new Map(), // menuItemId -> qty
    notes: '',
    showCart: false,
    pending: null, // { key, hash }
    busy: false,
    flash: null, // { kind, text }
    lastPlaced: null,
    joinError: null,
    pinDraft: '',
    pinFocused: false,
    lastVisit: null,
    detailId: null,
    detailQty: 1,
    detailNote: '',
    detailPushed: false,
    errorText: '',
  };

  // ---------- utilities ----------
  const storage = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
    del(k) { try { localStorage.removeItem(k); } catch { /* ignore */ } },
  };

  function baht(satang) {
    if (satang === null || satang === undefined) return '—';
    const neg = satang < 0;
    const abs = Math.abs(satang);
    const whole = Math.floor(abs / 100).toLocaleString('en-US');
    const st = abs % 100;
    return `${neg ? '-' : ''}฿${whole}${st ? '.' + String(st).padStart(2, '0') : ''}`;
  }

  function time(iso) {
    try { return new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Bangkok' }); } catch { return ''; }
  }

  function uuid() {
    if (crypto.randomUUID) return crypto.randomUUID();
    const b = crypto.getRandomValues(new Uint8Array(16));
    return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  }

  /** Tiny DOM builder; all text goes through textContent (no HTML injection). */
  function h(tag, attrs, ...children) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === false || v === null || v === undefined) continue;
      if (k === 'class') el.className = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (v === true) el.setAttribute(k, '');
      else el.setAttribute(k, String(v));
    }
    for (const c of children.flat(Infinity)) {
      if (c === null || c === undefined || c === false) continue;
      el.append(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return el;
  }

  function announce(text) { $live.textContent = text; }

  function banner(text, kind) {
    if (!text) { $banner.hidden = true; return; }
    $banner.hidden = false;
    $banner.className = `banner ${kind || ''}`;
    $banner.textContent = text;
  }

  class ApiError extends Error {
    constructor(status, code, message, details) { super(message); this.status = status; this.code = code; this.details = details; }
  }

  async function api(path, opts = {}) {
    const headers = { accept: 'application/json' };
    if (opts.body) headers['content-type'] = 'application/json';
    if (opts.auth !== false && state.token) headers.authorization = `Bearer ${state.token}`;
    let res;
    try {
      res = await fetch(path, { method: opts.method || 'GET', headers, body: opts.body ? JSON.stringify(opts.body) : undefined, cache: 'no-store' });
    } catch {
      banner('Connection lost — retrying…', 'error');
      throw new ApiError(0, 'NETWORK', 'Connection lost. Please check your internet and try again.');
    }
    banner(null);
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      const e = json.error || {};
      throw new ApiError(res.status, e.code || 'ERROR', e.message || 'Something went wrong.', e.details);
    }
    return json;
  }

  // ---------- cart ----------
  // A cart line is one drink with an optional note to staff. The same drink with a
  // different note is a separate line, so each note stays attached to its drink.
  const cartKey = () => (state.status ? `224:cart:${state.status.session.code}` : '');
  const lineKey = (id, note) => `${id}\u0000${note}`;
  const cleanNote = (v) => String(v || '').replace(/\s+/g, ' ').trim();
  function saveCart() {
    try { sessionStorage.setItem(cartKey(), JSON.stringify({ lines: [...state.cart.values()], notes: state.notes })); } catch { /* ignore */ }
  }
  function loadCart() {
    try {
      const raw = sessionStorage.getItem(cartKey());
      if (!raw) return;
      const c = JSON.parse(raw);
      const lines = c.lines || (c.items || []).map(([id, qty]) => ({ id, note: '', qty })); // carts saved by older versions
      state.cart = new Map(lines.filter((l) => l && l.qty > 0).map((l) => [lineKey(l.id, l.note || ''), { id: l.id, note: l.note || '', qty: l.qty }]));
      state.notes = c.notes || '';
    } catch { /* ignore */ }
  }
  function clearCart() {
    state.cart.clear();
    state.notes = '';
    state.pending = null;
    try { sessionStorage.removeItem(cartKey()); } catch { /* ignore */ }
  }
  const allItems = () => (state.menu ? state.menu.categories.flatMap((c) => c.items) : []);
  const itemById = (id) => allItems().find((i) => i.id === id);
  function cartLines() {
    return [...state.cart.values()].map((l) => ({ item: itemById(l.id), note: l.note, qty: l.qty })).filter((l) => l.item && l.qty > 0);
  }
  const itemQty = (id) => [...state.cart.values()].filter((l) => l.id === id).reduce((n, l) => n + l.qty, 0);
  const cartCount = () => cartLines().reduce((n, l) => n + l.qty, 0);
  const cartTotal = () => cartLines().reduce((n, l) => n + (l.item.priceSatang || 0) * l.qty, 0);
  function cartChanged() {
    state.pending = null; // cart changed: a new submission gets a new idempotency key
    saveCart();
    render();
  }
  /** Menu-card stepper. "+" adds to the plain (no-note) line; "−" removes from it first, then from the newest noted line. */
  function adjustItem(id, delta) {
    const plain = lineKey(id, '');
    if (delta > 0) {
      if (itemQty(id) >= 20) return;
      const l = state.cart.get(plain) || { id, note: '', qty: 0 };
      l.qty += 1;
      state.cart.set(plain, l);
    } else {
      const mine = [...state.cart.entries()].filter(([, l]) => l.id === id);
      if (!mine.length) return;
      const [key, l] = state.cart.has(plain) ? [plain, state.cart.get(plain)] : mine[mine.length - 1];
      l.qty -= 1;
      if (l.qty <= 0) state.cart.delete(key);
    }
    cartChanged();
  }
  /** Detail page "Add to Cart": merges with an existing line that has the same note. Max 20 of one drink. */
  function addWithNote(id, note, qty) {
    const add = Math.min(qty, 20 - itemQty(id));
    if (add <= 0) return;
    const key = lineKey(id, note);
    const l = state.cart.get(key) || { id, note, qty: 0 };
    l.qty += add;
    state.cart.set(key, l);
    cartChanged();
  }

  // ---------- data flow ----------
  async function boot() {
    if (!qrToken) { state.view = 'landing'; return render(); }
    try {
      state.table = await api(`/api/public/table/${qrToken}`, { auth: false });
    } catch (e) {
      state.view = 'error';
      state.errorText = e.status === 404 ? 'This QR code is not recognised. Please ask staff for help.' : e.message;
      return render();
    }
    state.token = storage.get(storeKey);
    try { state.lastVisit = JSON.parse(sessionStorage.getItem(lastKey) || 'null'); } catch { /* ignore */ }
    api('/api/public/menu', { auth: false }).then((menu) => { state.menu = menu; render(); }).catch(() => {});
    await refresh();
    setInterval(() => { if (!document.hidden) refresh(); }, POLL_MS);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
  }

  async function refreshTable() {
    try { state.table = await api(`/api/public/table/${qrToken}`, { auth: false }); } catch { /* keep last */ }
  }

  async function refresh() {
    if (state.token) {
      try {
        const prev = state.status;
        state.status = await api('/api/public/session/status');
        if (!prev || prev.session.code !== state.status.session.code) loadCart();
        onStatusChange(prev, state.status);
        if (state.status.session.isCurrent) {
          state.view = 'main';
          return render();
        }
        // Session is over (paid or closed): forget it and fall back to the table's default screen.
        rememberLastVisit(state.status);
        clearCart();
        storage.del(storeKey);
        state.token = null;
        state.status = null;
        state.tab = 'menu';
        state.showCart = false;
      } catch (e) {
        if (e.status === 401) {
          storage.del(storeKey);
          state.token = null;
          state.status = null;
        } else if (e.code === 'NETWORK') return; // keep current screen, banner shown
      }
    }
    await refreshTable();
    state.view = state.table && state.table.session ? 'join' : 'waiting';
    render();
  }

  const lastKey = qrToken ? `224:last:${qrToken}` : '';
  function rememberLastVisit(st) {
    state.lastVisit = {
      code: st.session.code,
      paid: st.session.status === 'PAID_CLOSED',
      amountSatang: st.payment ? st.payment.amountSatang : st.bill.totalSatang,
      method: st.payment ? st.payment.method : null,
      receipt: st.receipt,
    };
    try { sessionStorage.setItem(lastKey, JSON.stringify(state.lastVisit)); } catch { /* ignore */ }
  }
  function dismissLastVisit() {
    state.lastVisit = null;
    try { sessionStorage.removeItem(lastKey); } catch { /* ignore */ }
    render();
  }

  function lastVisitNote() {
    const v = state.lastVisit;
    if (!v) return null;
    const text = v.paid
      ? `Paid ${baht(v.amountSatang)}${v.method ? ` by ${v.method}` : ''} — thank you! Session ${v.code} is closed.`
      : `Session ${v.code} has ended.`;
    return h('div', { class: `alert ${v.paid ? 'ok' : ''} last-visit`, role: 'status' },
      h('span', {}, text,
        v.paid && v.receipt ? [' ', h('a', { href: v.receipt.url, target: '_blank', rel: 'noopener' }, `Receipt ${v.receipt.number || ''}`.trim())] : null),
      h('button', { type: 'button', class: 'dismiss', 'aria-label': 'Dismiss', onclick: dismissLastVisit }, '×'));
  }

  function onStatusChange(prev, next) {
    if (!prev || prev.session.code !== next.session.code) return;
    const prevServed = new Set(prev.orders.filter((o) => o.status === 'SERVED').map((o) => o.orderNumber));
    const newlyServed = next.orders.filter((o) => o.status === 'SERVED' && !prevServed.has(o.orderNumber));
    if (newlyServed.length) announce(`${newlyServed.map((o) => o.orderNumber).join(', ')} served`);
    if (prev.session.status === 'PAYMENT_REQUESTED' && next.session.status === 'OPEN') {
      state.flash = { kind: 'ok', text: 'Staff reopened your bill — you can order more drinks.' };
      state.tab = 'menu';
    }
    if (next.session.status === 'PAID_CLOSED' && prev.session.status !== 'PAID_CLOSED') {
      announce('Payment confirmed. Thank you!');
      clearCart();
    }
  }

  async function join(pin) {
    state.busy = true; state.joinError = null; render();
    try {
      const r = await api('/api/public/session/join', { method: 'POST', body: { qrToken, pin }, auth: false });
      state.token = r.visitToken;
      state.pinDraft = '';
      state.lastVisit = null;
      try { sessionStorage.removeItem(lastKey); } catch { /* ignore */ }
      storage.set(storeKey, r.visitToken);
      state.tab = 'menu';
      state.busy = false;
      await refresh();
    } catch (e) {
      state.busy = false;
      state.joinError = e.message;
      state.pinDraft = '';
      if (e.code === 'NO_ACTIVE_SESSION') await refreshTable();
      render();
    }
  }

  async function placeOrder() {
    const lines = cartLines();
    if (!lines.length || state.busy) return;
    const payload = { items: lines.map((l) => ({ menuItemId: l.item.id, quantity: l.qty, ...(l.note ? { note: l.note } : {}) })), notes: state.notes.trim() || null };
    const hash = JSON.stringify(payload);
    if (!state.pending || state.pending.hash !== hash) state.pending = { key: uuid(), hash };
    state.busy = true; state.flash = null; render();
    try {
      const r = await api('/api/public/orders', { method: 'POST', body: { ...payload, idempotencyKey: state.pending.key, expectedTotalSatang: cartTotal() } });
      state.lastPlaced = r.order;
      clearCart();
      state.showCart = false;
      state.tab = 'orders';
      announce(`Order ${r.order.orderNumber} received`);
      await refresh();
    } catch (e) {
      if (e.code === 'PRICE_CHANGED' || e.code === 'ITEM_UNAVAILABLE') {
        state.pending = null;
        state.menu = await api('/api/public/menu', { auth: false }).catch(() => state.menu);
        if (e.code === 'ITEM_UNAVAILABLE' && e.details) for (const [k, l] of [...state.cart]) if (l.id === e.details.menuItemId) state.cart.delete(k);
        saveCart();
      }
      state.flash = { kind: 'error', text: e.code === 'NETWORK' ? 'Could not reach the bar. Tap Place Order again — you will not be charged twice.' : e.message };
      if (e.status === 410 || e.code === 'PAYMENT_REQUESTED') await refresh();
    } finally {
      state.busy = false;
      render();
    }
  }

  async function requestPayment() {
    const bill = state.status && state.status.bill;
    if (!bill || state.busy) return;
    state.busy = true; state.flash = null; render();
    try {
      await api('/api/public/session/request-payment', { method: 'POST', body: { expectedTotalSatang: bill.totalSatang, expectedOrderCount: bill.orderNumbers.length } });
      announce('Payment requested. Please wait for staff.');
      await refresh();
    } catch (e) {
      state.flash = { kind: 'error', text: e.message };
      await refresh();
    } finally {
      state.busy = false;
      render();
    }
  }

  // ---------- views ----------
  function header() {
    const t = state.table;
    return h('header', { class: 'header' },
      h('div', { class: 'brand' },
        h('h1', {}, '224 ', h('span', {}, 'LIVE'), ' HOUSE'),
        h('span', { class: 'chip' }, 'Table ', h('strong', {}, t ? t.table.number : '–'))));
  }

  const scrollTop = () => { (document.querySelector('.phone-scroll') || document.scrollingElement).scrollTop = 0; };

  /** Floating bar at the bottom centre. The menu is home: tapping the active tab again returns to it. */
  function floatNav() {
    const waiting = state.status.orders.filter((o) => o.status === 'NEW').length;
    const btn = (id, label, badge) => h('button', { type: 'button', 'aria-current': state.tab === id ? 'page' : null,
      onclick: () => { state.tab = state.tab === id ? 'menu' : id; state.showCart = false; state.flash = null; render(); scrollTop(); } },
      label, badge ? h('span', { class: 'badge', 'aria-label': `${badge} waiting` }, badge) : null);
    return h('nav', { class: 'float-nav', 'aria-label': 'My orders and payment' }, btn('orders', 'My Orders', waiting || null), btn('bill', 'Pay'));
  }

  /** "‹ Menu" link at the top of the Orders and Pay pages (hidden while orders are paused for payment). */
  function menuLink() {
    if (state.status.session.status === 'PAYMENT_REQUESTED') return null;
    return h('button', { type: 'button', class: 'link-back', onclick: () => { state.tab = 'menu'; state.flash = null; render(); scrollTop(); } }, '‹ Menu');
  }

  function flash() {
    return state.flash ? h('div', { class: `alert ${state.flash.kind}`, role: 'alert' }, state.flash.text) : null;
  }

  function viewLanding() {
    return h('div', { class: 'center-screen' }, h('div', { class: 'hero' },
      h('div', { class: 'icon', 'aria-hidden': 'true' }, '🍸'), h('h2', {}, '224 LIVE HOUSE'), h('p', {}, 'Scan the QR code on your table to order cocktails.')));
  }

  function viewError() {
    return [header(), h('div', { class: 'hero' }, h('div', { class: 'icon', 'aria-hidden': 'true' }, '⚠️'), h('h2', {}, 'Something’s not right'), h('p', {}, state.errorText))];
  }

  /** 3D alarm clock (pure CSS) that hops top-left / top-right while the table waits. */
  function clock3d() {
    const rims = Array.from({ length: 8 }, () => h('i', { class: 'clock-rim' }));
    return h('div', { class: 'clock3d', 'aria-hidden': 'true' },
      h('div', { class: 'clock-shadow' }),
      h('div', { class: 'clock-hop' },
        h('div', { class: 'clock-body' },
          h('i', { class: 'clock-bell left' }), h('i', { class: 'clock-bell right' }), h('i', { class: 'clock-hammer' }),
          h('i', { class: 'clock-leg left' }), h('i', { class: 'clock-leg right' }),
          rims,
          h('div', { class: 'clock-face' },
            h('i', { class: 'tick t12' }), h('i', { class: 'tick t3' }), h('i', { class: 'tick t6' }), h('i', { class: 'tick t9' }),
            h('i', { class: 'clock-hand hour' }), h('i', { class: 'clock-hand minute' }), h('i', { class: 'clock-pin' })),
          h('i', { class: 'clock-glass' }))));
  }

  function viewWaiting() {
    return [header(), lastVisitNote(), h('div', { class: 'waiting-center' }, h('div', { class: 'hero' },
      clock3d(),
      h('h2', {}, 'Waiting for staff'),
      h('p', { class: 'small muted' }, h('span', { class: 'pulse', 'aria-hidden': 'true' }), ' Checking…')))];
  }

  function viewJoin() {
    const len = state.table.pinLength || 2;
    const input = h('input', { class: `pin pin-${len}`, id: 'pin', inputmode: 'numeric', autocomplete: 'one-time-code', pattern: '[0-9]*', maxlength: len, 'aria-describedby': 'pin-help', 'aria-label': 'Table PIN', required: true,
      oninput: (e) => {
        const v = e.target.value.replace(/\D/g, '').slice(0, len);
        e.target.value = v;
        state.pinDraft = v;
        if (v.length === len && !state.busy) join(v); // submit as soon as the PIN is complete
      } });
    input.value = state.pinDraft || '';
    const form = h('form', { class: 'section', onsubmit: (e) => { e.preventDefault(); const v = input.value.replace(/\D/g, ''); if (v.length === len) join(v); else { state.joinError = `Please enter the ${len}-digit PIN.`; render(); } } },
      h('label', { for: 'pin' }, 'Table PIN'),
      input,
      h('p', { id: 'pin-help', class: 'small muted' }, 'It keeps your table’s orders and bill private to your group.'),
      state.joinError ? h('div', { class: 'alert error', role: 'alert' }, state.joinError) : null,
      h('div', { class: 'btn-row' }, h('button', { class: 'btn', type: 'submit', disabled: state.busy }, state.busy ? 'Joining…' : 'Start ordering')));
    if (!state.pinFocused) { state.pinFocused = true; setTimeout(() => input.focus(), 50); }
    return [header(), lastVisitNote(), h('div', { class: 'hero' }, h('h2', {}, `Welcome to ${state.table.table.name || 'your table'}`), h('p', {}, `Session ${state.table.session.code}`)), form];
  }

  function itemCard(item, enabled) {
    const qty = itemQty(item.id);
    const orderable = enabled && item.available && item.priceSatang;
    const thumbSrc = item.thumbUrl || item.imageUrl;
    const thumb = thumbSrc
      ? h('img', { class: 'thumb photo', src: thumbSrc, alt: '', loading: 'lazy', width: 76, height: 114 })
      : h('div', { class: 'thumb', 'aria-hidden': 'true' }, '🍸');
    return h('article', { class: `item${item.available ? '' : ' unavailable'}`, 'aria-label': item.name,
      onclick: (e) => { if (!e.target.closest('.qty')) openDetail(item.id); } },
      thumb,
      h('div', {},
        h('h3', {}, h('button', { type: 'button', class: 'item-open', 'aria-label': `${item.name} — view ingredients` }, item.name)),
        item.description ? h('p', {}, item.description) : null,
        h('div', { class: 'item-foot' },
          item.available ? h('span', { class: 'price' }, item.priceSatang ? baht(item.priceSatang) : 'Price TBA') : h('span', { class: 'tag' }, 'Unavailable'),
          h('div', { class: 'qty', role: 'group', 'aria-label': `Quantity of ${item.name}` },
            h('button', { type: 'button', 'aria-label': `Remove one ${item.name}`, disabled: qty === 0, onclick: () => adjustItem(item.id, -1) }, '−'),
            h('output', { 'aria-live': 'polite' }, qty),
            h('button', { type: 'button', class: 'plus', 'aria-label': `Add one ${item.name}`, disabled: !orderable || qty >= 20, onclick: () => adjustItem(item.id, 1) }, '+')))));
  }

  // ---------- product detail ----------
  const SVGNS = 'http://www.w3.org/2000/svg';
  function svg(parts, cls) {
    const el = document.createElementNS(SVGNS, 'svg');
    el.setAttribute('viewBox', '0 0 24 24');
    el.setAttribute('aria-hidden', 'true');
    if (cls) el.setAttribute('class', cls);
    for (const [tag, attrs] of parts) {
      const c = document.createElementNS(SVGNS, tag);
      for (const [k, v] of Object.entries(attrs)) c.setAttribute(k, v);
      el.append(c);
    }
    return el;
  }
  function openDetail(id) {
    state.detailId = id;
    state.detailQty = 1;
    state.detailNote = '';
    try { history.pushState({ detail: id }, ''); state.detailPushed = true; } catch { state.detailPushed = false; }
    render();
    (document.querySelector('.phone-scroll') || document.scrollingElement).scrollTop = 0;
  }
  function closeDetail(viaHistory) {
    if (state.detailId === null) return;
    state.detailId = null;
    if (!viaHistory && state.detailPushed) { state.detailPushed = false; try { history.back(); } catch { /* ignore */ } }
    render();
  }
  window.addEventListener('popstate', () => closeDetail(true));

  function viewDetail(item) {
    const enabled = state.status.orderingEnabled && state.menu.orderingEnabled;
    const orderable = enabled && item.available && item.priceSatang;
    const inCart = itemQty(item.id);
    const maxAdd = Math.max(0, 20 - inCart);
    const qty = Math.min(state.detailQty, Math.max(1, maxAdd));
    const signature = state.menu.categories.find((c) => c.items.includes(item))?.code === 'signature';
    const ingredients = item.ingredients || [];
    const noteField = h('textarea', { id: 'detail-note', maxlength: 100, rows: 2, placeholder: 'e.g. less ice, no honey', 'aria-describedby': 'detail-note-help',
      oninput: (e) => { state.detailNote = e.target.value; } });
    noteField.value = state.detailNote;
    const label = !item.available ? 'Unavailable'
      : !enabled ? (state.status.session.status === 'PAYMENT_REQUESTED' ? 'Orders paused' : 'Ordering opens soon')
      : maxAdd === 0 ? 'Limit reached'
      : null;
    return [h('div', { class: 'detail' },
      h('div', { class: 'detail-hero' },
        item.imageUrl
          ? [h('img', { class: 'hero-bg', src: item.imageUrl, alt: '', 'aria-hidden': 'true' }), h('img', { class: 'hero-img', src: item.imageUrl, alt: item.name })]
          : svg([['path', { d: 'M4 4h16l-8 9z' }], ['path', { d: 'M12 13v7M8 20.5h8' }], ['circle', { cx: 17.5, cy: 5.5, r: 1.6 }]], 'hero-glass'),
        h('button', { type: 'button', class: 'detail-back', 'aria-label': 'Back to menu', onclick: () => closeDetail(false) },
          svg([['path', { d: 'M19 12H5M11 6l-6 6 6 6' }]]))),
      h('section', { class: 'detail-sheet', 'aria-labelledby': 'detail-name' },
        h('div', { class: 'detail-title' },
          h('h2', { id: 'detail-name' }, item.name),
          signature ? h('span', { class: 'badge-sig' }, svg([['path', { d: 'M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8-4.3-4.1 5.9-.9z' }]]), 'Signature') : null),
        item.description ? h('p', { class: 'detail-desc' }, item.description) : null,
        h('div', { class: 'detail-price' }, item.priceSatang ? baht(item.priceSatang) : 'Price TBA'),
        h('h3', { class: 'detail-label' }, 'Ingredients'),
        ingredients.length
          ? h('ul', { class: 'ing-list' }, ingredients.map((n) => h('li', { class: 'ing' }, n)))
          : h('p', { class: 'muted small' }, 'Ask our bartenders what goes into this one.'),
        h('div', { class: 'detail-notes' },
          h('label', { for: 'detail-note' }, 'Note to staff'),
          noteField,
          h('p', { id: 'detail-note-help', class: 'small muted' }, 'Allergies or preferences for this drink (optional).'))),
      h('div', { class: 'cta-bar' }, h('div', { class: 'detail-cta' },
        h('div', { class: 'qty', role: 'group', 'aria-label': `Quantity of ${item.name}` },
          h('button', { type: 'button', 'aria-label': 'One less', disabled: !orderable || qty <= 1, onclick: () => { state.detailQty = qty - 1; render(); } }, '−'),
          h('output', { 'aria-live': 'polite' }, qty),
          h('button', { type: 'button', class: 'plus', 'aria-label': 'One more', disabled: !orderable || qty >= maxAdd, onclick: () => { state.detailQty = qty + 1; render(); } }, '+')),
        h('button', { type: 'button', class: 'btn', disabled: !orderable || maxAdd === 0, onclick: () => {
          addWithNote(item.id, cleanNote(state.detailNote), qty);
          announce(`Added ${qty} ${item.name} to cart`);
          closeDetail(false);
        } }, label || `Add to Cart (${baht(item.priceSatang * qty)})`))))];
  }

  function viewMenu() {
    const st = state.status;
    if (!state.menu) return [h('div', { class: 'center-screen' }, h('div', { class: 'spinner', 'aria-label': 'Loading menu' }))];
    const enabled = st.orderingEnabled && state.menu.orderingEnabled;
    const cats = state.menu.categories;
    const cat = cats[state.category] || cats[0];
    const tabs = h('div', { class: 'tabs', role: 'tablist' }, cats.map((c, i) =>
      h('button', { type: 'button', role: 'tab', 'aria-selected': i === state.category ? 'true' : 'false', onclick: () => { state.category = i; state.revealTab = true; render(); } }, c.name)));
    const notice = !state.menu.orderingEnabled
      ? h('div', { class: 'alert' }, 'Ordering opens soon — our prices are being finalised. Please ask staff.')
      : st.session.status === 'PAYMENT_REQUESTED' ? h('div', { class: 'alert' }, 'Payment has been requested, so new orders are paused.') : null;
    const count = cartCount();
    return [
      tabs, notice, flash(),
      h('section', { class: 'section', role: 'tabpanel', 'aria-label': cat.name }, h('div', { class: 'items' }, cat.items.map((i) => itemCard(i, enabled)))),
      count ? h('div', { class: 'cta-bar' }, h('button', { class: 'btn', type: 'button', onclick: () => { state.showCart = true; state.flash = null; render(); scrollTo(0, 0); } },
        h('span', {}, `View Cart · ${count} item${count > 1 ? 's' : ''}`), h('span', { class: 'spread' }, baht(cartTotal())))) : null,
    ];
  }

  function viewCart() {
    const lines = cartLines();
    const notes = h('textarea', { id: 'notes', maxlength: 200, placeholder: 'e.g. less ice, no garnish', oninput: (e) => { state.notes = e.target.value; state.pending = null; saveCart(); } });
    notes.value = state.notes;
    return [
      h('div', { class: 'section' }, h('h2', {}, 'Your order'), flash(),
        h('div', { class: 'card' },
          lines.length ? lines.map((l) => [h('div', { class: 'line' },
            h('span', {}, h('span', { class: 'q' }, `${l.qty} ×`), l.item.name, h('span', { class: 'small muted' }, ` @ ${baht(l.item.priceSatang)}`)),
            h('span', {}, baht(l.item.priceSatang * l.qty))),
            l.note ? h('div', { class: 'line-note' }, `Note: ${l.note}`) : null]) : h('p', { class: 'muted' }, 'Your cart is empty.'),
          h('div', { class: 'line total' }, h('span', {}, 'Total'), h('span', {}, baht(cartTotal())))),
        h('label', { for: 'notes' }, 'Note to staff for the whole order (optional)'), notes,
        h('p', { class: 'small muted' }, 'Prices are final and shown in Thai Baht. You pay for the whole table at the end.')),
      h('div', { class: 'cta-bar' }, h('div', { class: 'btn-row' },
        h('button', { class: 'btn', type: 'button', disabled: !lines.length || state.busy || !state.status.orderingEnabled, onclick: placeOrder },
          state.busy ? 'Sending to the bar…' : h('span', {}, 'Place Order'), state.busy ? null : h('span', { class: 'spread' }, baht(cartTotal()))),
        h('button', { class: 'btn ghost', type: 'button', onclick: () => { state.showCart = false; state.flash = null; render(); } }, 'Keep browsing'))),
    ];
  }

  function orderCard(o) {
    return h('div', { class: 'card' },
      h('div', { class: 'card-head' }, h('strong', {}, `${o.orderNumber} · ${time(o.createdAt)}`),
        o.status === 'SERVED' ? h('span', { class: 'status served' }, '✓ Served') : h('span', { class: 'status new' }, h('span', { class: 'pulse', 'aria-hidden': 'true' }), 'Waiting to be served')),
      o.items.map((i) => [h('div', { class: 'line' }, h('span', {}, h('span', { class: 'q' }, `${i.quantity} ×`), i.name), h('span', {}, baht(i.lineTotalSatang))),
        i.note ? h('div', { class: 'line-note' }, `Note: ${i.note}`) : null]),
      h('div', { class: 'line sub' }, h('span', {}, 'Order total'), h('span', {}, baht(o.totalSatang))),
      o.notes ? h('div', { class: 'note' }, `Note: ${o.notes}`) : null);
  }

  function viewOrders() {
    const orders = state.status.orders.slice().reverse();
    const placed = state.lastPlaced && orders.find((o) => o.orderNumber === state.lastPlaced.orderNumber);
    return [h('div', { class: 'section' }, menuLink(),
      placed ? h('div', { class: 'alert ok', role: 'status' }, `Order received · ${placed.orderNumber}. We’ll bring it to your table.`) : null,
      h('h2', {}, `Orders for ${state.status.session.code}`),
      orders.length ? orders.map(orderCard) : h('p', { class: 'muted' }, 'No orders yet. Everyone at your table can order from their own phone — all orders go on one bill.'))];
  }

  function billLines(bill) {
    const groups = [];
    for (const l of bill.lines) {
      let g = groups.find((x) => x.no === l.orderNumber);
      if (!g) groups.push((g = { no: l.orderNumber, lines: [] }));
      g.lines.push(l);
    }
    return h('div', { class: 'card' },
      groups.map((g) => [h('div', { class: 'small muted' }, g.no),
        g.lines.map((l) => h('div', { class: 'line' },
          h('span', {}, h('span', { class: 'q' }, `${l.quantity} ×`), l.itemName, h('span', { class: 'small muted' }, ` @ ${baht(l.unitPriceSatang)}`)),
          h('span', {}, baht(l.lineTotalSatang))))]),
      h('div', { class: 'line sub' }, h('span', {}, 'Subtotal'), h('span', {}, baht(bill.subtotalSatang))),
      bill.adjustments.map((a) => h('div', { class: 'line sub' }, h('span', {}, a.label), h('span', {}, baht(a.amountSatang)))),
      h('div', { class: 'line total' }, h('span', {}, 'Total to Pay'), h('span', {}, baht(bill.totalSatang))));
  }

  function viewBill() {
    const st = state.status;
    const bill = st.bill;
    if (st.session.status === 'PAYMENT_REQUESTED') return viewPending();
    return [h('div', { class: 'section' }, menuLink(),
      h('h2', {}, `Table bill · ${st.session.code}`), flash(),
      bill.lines.length ? billLines(bill) : h('p', { class: 'muted' }, 'Nothing to pay yet.'),
      bill.lines.length ? h('p', { class: 'small muted' }, 'Includes every order placed by your table in this session. Requesting payment pauses new orders and lets staff know you’re ready to pay.') : null),
    bill.lines.length ? h('div', { class: 'cta-bar' }, h('button', { class: 'btn', type: 'button', disabled: state.busy, onclick: requestPayment },
      state.busy ? 'Requesting…' : h('span', {}, 'Confirm & Request Payment'), state.busy ? null : h('span', { class: 'spread' }, baht(bill.totalSatang)))) : null];
  }

  function viewPending() {
    const bill = state.status.bill;
    return [h('div', { class: 'hero', role: 'status' },
      h('div', { class: 'icon', 'aria-hidden': 'true' }, '🧾'),
      h('h2', {}, 'Payment requested'),
      h('p', {}, 'Please wait — a staff member will come to your table to collect payment.'),
      h('div', { class: 'amount' }, baht(bill.totalSatang)),
      h('p', { class: 'small' }, h('span', { class: 'pulse', 'aria-hidden': 'true' }), ' Awaiting payment confirmation')),
    h('div', { class: 'section' }, flash(), h('h2', {}, bill.billNumber ? `Bill ${bill.billNumber}` : 'Bill'), billLines(bill),
      h('p', { class: 'small muted' }, 'Want another drink? Ask staff to reopen your bill.'))];
  }

  function viewMain() {
    const st = state.status;
    if (st.session.status === 'PAYMENT_REQUESTED' && state.tab !== 'orders') state.tab = 'bill';
    let body;
    const detail = state.detailId !== null && state.tab === 'menu' && !state.showCart && state.menu ? itemById(state.detailId) : null;
    if (detail) return viewDetail(detail);
    if (state.tab === 'orders') body = viewOrders();
    else if (state.tab === 'bill') body = viewBill();
    else body = state.showCart ? viewCart() : viewMenu();
    return [header(), ...body, state.showCart ? null : floatNav()]; // the cart is a focused step with its own buttons
  }

  function render() {
    let nodes;
    switch (state.view) {
      case 'landing': nodes = [viewLanding()]; break;
      case 'error': nodes = viewError(); break;
      case 'waiting': nodes = viewWaiting(); break;
      case 'join': nodes = viewJoin(); break;
      case 'main': nodes = viewMain(); break;
      default: return;
    }
    // Preserve focus/caret in the notes field across re-renders (polling).
    const active = document.activeElement;
    const focusId = active && active.id;
    const sel = active && 'selectionStart' in active ? [active.selectionStart, active.selectionEnd] : null;
    const tabsScroll = document.querySelector('.tabs')?.scrollLeft ?? 0; // keep pill row position across re-renders
    $app.replaceChildren(...nodes.flat().filter(Boolean));
    $app.classList.toggle('is-waiting', state.view === 'waiting');
    $app.classList.toggle('is-detail', !!$app.querySelector('.detail'));
    $app.classList.toggle('has-nav', !!$app.querySelector('.float-nav'));
    $app.classList.toggle('has-cta', !!$app.querySelector('.cta-bar'));
    const tabs = document.querySelector('.tabs');
    if (tabs) {
      tabs.scrollLeft = tabsScroll;
      if (state.revealTab) {
        state.revealTab = false;
        tabs.querySelector('[aria-selected="true"]')?.scrollIntoView({ inline: 'nearest', block: 'nearest', behavior: 'smooth' });
      }
    }
    $app.setAttribute('aria-busy', 'false');
    if (focusId) {
      const el = document.getElementById(focusId);
      if (el && el !== document.activeElement) {
        el.focus({ preventScroll: true });
        if (sel && 'setSelectionRange' in el) try { el.setSelectionRange(sel[0], sel[1]); } catch { /* ignore */ }
      }
    }
  }

  window.addEventListener('online', () => refresh());
  window.addEventListener('offline', () => banner('You are offline — orders will not be sent until you reconnect.', 'error'));
  boot();
})();
