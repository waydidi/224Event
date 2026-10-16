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
  const cartKey = () => (state.status ? `224:cart:${state.status.session.code}` : '');
  function saveCart() {
    try { sessionStorage.setItem(cartKey(), JSON.stringify({ items: [...state.cart], notes: state.notes })); } catch { /* ignore */ }
  }
  function loadCart() {
    try {
      const raw = sessionStorage.getItem(cartKey());
      if (!raw) return;
      const c = JSON.parse(raw);
      state.cart = new Map(c.items || []);
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
    return [...state.cart].map(([id, qty]) => ({ item: itemById(id), qty })).filter((l) => l.item && l.qty > 0);
  }
  const cartCount = () => cartLines().reduce((s, l) => s + l.qty, 0);
  const cartTotal = () => cartLines().reduce((s, l) => s + (l.item.priceSatang || 0) * l.qty, 0);
  function setQty(id, qty) {
    const next = Math.max(0, Math.min(20, qty));
    if (next === 0) state.cart.delete(id); else state.cart.set(id, next);
    state.pending = null; // cart changed: a new submission gets a new idempotency key
    saveCart();
    render();
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
        if (!state.status.session.isCurrent) {
          await refreshTable();
          state.view = 'ended';
        } else state.view = 'main';
        return render();
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
      storage.set(storeKey, r.visitToken);
      state.tab = 'menu';
      state.busy = false;
      await refresh();
    } catch (e) {
      state.busy = false;
      state.joinError = e.message;
      if (e.code === 'NO_ACTIVE_SESSION') await refreshTable();
      render();
    }
  }

  async function placeOrder() {
    const lines = cartLines();
    if (!lines.length || state.busy) return;
    const payload = { items: lines.map((l) => ({ menuItemId: l.item.id, quantity: l.qty })), notes: state.notes.trim() || null };
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
        if (e.code === 'ITEM_UNAVAILABLE' && e.details) state.cart.delete(e.details.menuItemId);
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
    const s = state.status && state.status.session;
    const t = state.table;
    return h('header', { class: 'header' },
      h('div', { class: 'brand' },
        h('h1', {}, '224 ', h('span', {}, 'LIVE'), ' HOUSE'),
        h('span', { class: 'chip' }, 'Table ', h('strong', {}, t ? t.table.number : '–'), s ? ` · ${s.code}` : (t && t.session ? ` · ${t.session.code}` : ''))),
      state.view === 'main' ? nav() : null);
  }

  function nav() {
    const st = state.status;
    const pendingOrders = st.orders.filter((o) => o.status === 'NEW').length;
    const btn = (id, label, badge) => h('button', { type: 'button', 'aria-current': state.tab === id ? 'page' : null, onclick: () => { state.tab = id; state.showCart = false; state.flash = null; render(); scrollTo(0, 0); } },
      label, badge ? h('span', { class: 'badge', 'aria-label': `${badge} waiting` }, badge) : null);
    return h('nav', { class: 'nav', 'aria-label': 'Sections' },
      btn('menu', 'Menu'), btn('orders', 'My Orders', pendingOrders || null), btn('bill', 'Pay Table'));
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

  function viewWaiting() {
    return [header(), h('div', { class: 'hero' },
      h('div', { class: 'icon', 'aria-hidden': 'true' }, '🎶'),
      h('h2', {}, 'Waiting for staff to open this table'),
      h('p', {}, 'Please let our staff know you have arrived. This page will update automatically.'),
      h('p', { class: 'small muted' }, h('span', { class: 'pulse', 'aria-hidden': 'true' }), ' Checking…'))];
  }

  function viewJoin() {
    const input = h('input', { class: 'pin', id: 'pin', inputmode: 'numeric', autocomplete: 'one-time-code', pattern: '[0-9]*', maxlength: 6, 'aria-describedby': 'pin-help', 'aria-label': 'Table PIN', required: true,
      oninput: (e) => { state.pinDraft = e.target.value; } });
    input.value = state.pinDraft || '';
    const form = h('form', { class: 'section', onsubmit: (e) => { e.preventDefault(); const v = input.value.replace(/\D/g, ''); if (v.length === 6) join(v); else { state.joinError = 'Please enter the 6-digit PIN.'; render(); } } },
      h('label', { for: 'pin' }, 'Table PIN'),
      input,
      h('p', { id: 'pin-help', class: 'small muted' }, 'Staff will give you a 6-digit PIN for this table. It keeps your table’s orders and bill private to your group.'),
      state.joinError ? h('div', { class: 'alert error', role: 'alert' }, state.joinError) : null,
      h('div', { class: 'btn-row' }, h('button', { class: 'btn', type: 'submit', disabled: state.busy }, state.busy ? 'Joining…' : 'Start ordering')));
    if (!state.pinFocused) { state.pinFocused = true; setTimeout(() => input.focus(), 50); }
    return [header(), h('div', { class: 'hero' }, h('div', { class: 'icon', 'aria-hidden': 'true' }, '🍒'), h('h2', {}, `Welcome to ${state.table.table.name || 'your table'}`), h('p', {}, `Session ${state.table.session.code}`)), form];
  }

  function itemCard(item, enabled) {
    const qty = state.cart.get(item.id) || 0;
    const orderable = enabled && item.available && item.priceSatang;
    const thumb = item.imageUrl
      ? h('img', { class: 'thumb', src: item.imageUrl, alt: '', loading: 'lazy', width: 76, height: 76 })
      : h('div', { class: 'thumb', 'aria-hidden': 'true' }, '🍸');
    return h('article', { class: `item${item.available ? '' : ' unavailable'}`, 'aria-label': item.name },
      thumb,
      h('div', {},
        h('h3', {}, item.name),
        item.description ? h('p', {}, item.description) : null,
        h('div', { class: 'item-foot' },
          item.available ? h('span', { class: 'price' }, item.priceSatang ? baht(item.priceSatang) : 'Price TBA') : h('span', { class: 'tag' }, 'Unavailable'),
          h('div', { class: 'qty', role: 'group', 'aria-label': `Quantity of ${item.name}` },
            h('button', { type: 'button', 'aria-label': `Remove one ${item.name}`, disabled: qty === 0, onclick: () => setQty(item.id, qty - 1) }, '−'),
            h('output', { 'aria-live': 'polite' }, qty),
            h('button', { type: 'button', class: 'plus', 'aria-label': `Add one ${item.name}`, disabled: !orderable || qty >= 20, onclick: () => setQty(item.id, qty + 1) }, '+')))));
  }

  function viewMenu() {
    const st = state.status;
    if (!state.menu) return [h('div', { class: 'center-screen' }, h('div', { class: 'spinner', 'aria-label': 'Loading menu' }))];
    const enabled = st.orderingEnabled && state.menu.orderingEnabled;
    const cats = state.menu.categories;
    const cat = cats[state.category] || cats[0];
    const tabs = h('div', { class: 'tabs', role: 'tablist' }, cats.map((c, i) =>
      h('button', { type: 'button', role: 'tab', 'aria-selected': i === state.category ? 'true' : 'false', onclick: () => { state.category = i; render(); } }, c.name)));
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
          lines.length ? lines.map((l) => h('div', { class: 'line' },
            h('span', {}, h('span', { class: 'q' }, `${l.qty} ×`), l.item.name, h('span', { class: 'small muted' }, ` @ ${baht(l.item.priceSatang)}`)),
            h('span', {}, baht(l.item.priceSatang * l.qty)))) : h('p', { class: 'muted' }, 'Your cart is empty.'),
          h('div', { class: 'line total' }, h('span', {}, 'Total'), h('span', {}, baht(cartTotal())))),
        h('label', { for: 'notes' }, 'Special instructions (optional)'), notes,
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
      o.items.map((i) => h('div', { class: 'line' }, h('span', {}, h('span', { class: 'q' }, `${i.quantity} ×`), i.name), h('span', {}, baht(i.lineTotalSatang)))),
      h('div', { class: 'line sub' }, h('span', {}, 'Order total'), h('span', {}, baht(o.totalSatang))),
      o.notes ? h('div', { class: 'note' }, `Note: ${o.notes}`) : null);
  }

  function viewOrders() {
    const orders = state.status.orders.slice().reverse();
    const placed = state.lastPlaced && orders.find((o) => o.orderNumber === state.lastPlaced.orderNumber);
    return [h('div', { class: 'section' },
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
    return [h('div', { class: 'section' },
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

  function viewPaid(st) {
    const r = st.receipt;
    return [h('div', { class: 'hero', role: 'status' },
      h('div', { class: 'icon', 'aria-hidden': 'true' }, '🎉'),
      h('h2', {}, 'Paid — Thank you!'),
      h('div', { class: 'amount' }, baht(st.payment ? st.payment.amountSatang : st.bill.totalSatang)),
      h('p', {}, st.payment ? `Paid by ${st.payment.method} · ${time(st.payment.confirmedAt)}` : ''),
      h('p', { class: 'small muted' }, `Session ${st.session.code} is now closed. See you again at 224 Live House!`)),
    h('div', { class: 'section' },
      r ? (r.ready
        ? h('a', { class: 'btn secondary', href: r.url, target: '_blank', rel: 'noopener' }, `Download receipt ${r.number || ''}`)
        : h('p', { class: 'small muted' }, 'Your receipt is being prepared…')) : null,
      h('h2', {}, 'Your bill'), billLines(st.bill))];
  }

  function viewEnded() {
    const st = state.status;
    const t = state.table;
    const canJoin = t && t.session && t.session.code !== st.session.code;
    const joinBtn = canJoin ? h('div', { class: 'section' }, h('button', { class: 'btn ghost', type: 'button', onclick: () => { storage.del(storeKey); state.token = null; state.status = null; state.view = 'join'; render(); } }, 'I’m a new guest at this table')) : null;
    if (st.session.status === 'PAID_CLOSED') return [header(), ...viewPaid(st), joinBtn];
    return [header(), h('div', { class: 'hero' },
      h('div', { class: 'icon', 'aria-hidden': 'true' }, '🔒'),
      h('h2', {}, 'This table session has ended'),
      h('p', {}, `Session ${st.session.code} is closed. Please ask staff if you need help.`)), joinBtn];
  }

  function viewMain() {
    const st = state.status;
    if (st.session.status === 'PAYMENT_REQUESTED' && state.tab !== 'orders') state.tab = 'bill';
    let body;
    if (state.tab === 'orders') body = viewOrders();
    else if (state.tab === 'bill') body = viewBill();
    else body = state.showCart ? viewCart() : viewMenu();
    return [header(), ...body];
  }

  function render() {
    let nodes;
    switch (state.view) {
      case 'landing': nodes = [viewLanding()]; break;
      case 'error': nodes = viewError(); break;
      case 'waiting': nodes = viewWaiting(); break;
      case 'join': nodes = viewJoin(); break;
      case 'ended': nodes = viewEnded(); break;
      case 'main': nodes = viewMain(); break;
      default: return;
    }
    // Preserve focus/caret in the notes field across re-renders (polling).
    const active = document.activeElement;
    const focusId = active && active.id;
    const sel = active && 'selectionStart' in active ? [active.selectionStart, active.selectionEnd] : null;
    $app.replaceChildren(...nodes.flat().filter(Boolean));
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
