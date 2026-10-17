import type { Config } from "../config.ts";
import {
  AppError,
  badRequest,
  conflict,
  gone,
  notFound,
  unauthorized,
} from "../lib/errors.ts";
import {
  randomPin,
  randomToken,
  safeEqual,
  sha256,
  padNumber,
} from "../lib/ids.ts";
import { computeAdjustments, type BillView } from "../domain/billing.ts";
import {
  normalize,
  type OrderRow,
  type OrderItemRow,
} from "../domain/orders.ts";
import type { CustomerAuth } from "../domain/access.ts";
import { can, type StaffRow, type Permission } from "../domain/staff.ts";
import type { Actor } from "../domain/audit.ts";
import type { SessionRow, TableRow } from "../domain/tables.ts";
import type { MenuItemRow } from "../domain/menu.ts";
import type { BillRow } from "../domain/billing.ts";
import type { PaymentRow } from "../domain/payments.ts";
import { Store, Transaction, type Row } from "./database.ts";

export interface Ctx {
  db: Store;
  config: Config;
  now: () => Date;
}
export const stamp = (c: Ctx) => c.now().toISOString();
export function audit(
  tx: Transaction,
  c: Ctx,
  actor: Actor,
  action: string,
  entity: string,
  id: number | string | null,
  data = {},
) {
  const actorId =
    actor.type === "staff"
      ? `staff:${actor.staff.id}`
      : actor.type === "customer"
        ? `access:${actor.accessId}`
        : actor.type === "unknown"
          ? `telegram:${actor.telegramUserId}`
          : null;
  tx.run(
    "INSERT INTO audit_events(actor_type,actor_id,action,entity_type,entity_id,timestamp,metadata) VALUES (?,?,?,?,?,?,?)",
    [
      actor.type,
      actorId,
      action,
      entity,
      id === null ? null : String(id),
      stamp(c),
      JSON.stringify(data),
    ],
  );
}
export function enqueue(
  tx: Transaction,
  c: Ctx,
  type: string,
  data: object,
  key?: string,
) {
  tx.run(
    "INSERT INTO outbox_events(event_type,payload,dedupe_key,next_retry_at,created_at) VALUES (?,?,?,?,?) ON CONFLICT(dedupe_key) DO NOTHING",
    [type, JSON.stringify(data), key ?? null, stamp(c), stamp(c)],
  );
}
export function action(
  tx: Transaction,
  c: Ctx,
  kind: string,
  entity: string,
  id: number,
  payload = {},
) {
  const token = randomToken(15);
  tx.run(
    "INSERT INTO callback_actions(id,action,entity_type,entity_id,payload,created_at) VALUES (?,?,?,?,?,?)",
    [token, kind, entity, id, JSON.stringify(payload), stamp(c)],
  );
  return token;
}
export const getSession = (db: Store, id: number) =>
  db.get<SessionRow>("SELECT * FROM table_sessions WHERE id=?", [id]);
export const getTableByNumber = (db: Store, n: number) =>
  db.get<TableRow>("SELECT * FROM tables WHERE display_number=?", [n]);
export const getTableById = (db: Store, n: number) =>
  db.get<TableRow>("SELECT * FROM tables WHERE id=?", [n]);
export const getTableByQrToken = (db: Store, token: string) =>
  db.get<TableRow>("SELECT * FROM tables WHERE permanent_qr_token=?", [token]);
export const getActiveSession = async (db: Store, t: TableRow) =>
  t.current_session_id ? await getSession(db, t.current_session_id) : undefined;
export const getBill = (db: Store, id: number) =>
  db.get<BillRow>("SELECT * FROM bills WHERE id=?", [id]);
export const findActiveStaff = (db: Store, id: string | number) =>
  db.get<StaffRow>(
    "SELECT * FROM staff WHERE telegram_user_id=? AND active=1",
    [String(id)],
  );
export const findAction = (db: Store, id: string) =>
  db.get<Row>("SELECT * FROM callback_actions WHERE id=?", [id]);
export const findActionsFor = (db: Store, type: string, id: number) =>
  db.all<Row>(
    "SELECT * FROM callback_actions WHERE entity_type=? AND entity_id=? ORDER BY rowid",
    [type, id],
  );
export const listTables = (db: Store) =>
  db.all<Row>(
    `SELECT t.*,s.session_code,s.status AS session_status,s.join_pin,(SELECT MAX(round_number) FROM table_sessions WHERE table_id=t.id) AS last_round FROM tables t LEFT JOIN table_sessions s ON s.id=t.current_session_id ORDER BY t.display_number`,
  );
export const nextSessionCode = async (db: Store, t: TableRow) =>
  `TABLE${t.display_number}-${(await db.get<{ n: number }>("SELECT COALESCE(MAX(round_number),0) AS n FROM table_sessions WHERE table_id=?", [t.id]))!.n + 1}`;
export async function getMenu(db: Store) {
  const cats = await db.all<{ id: number; code: string; name: string }>(
    "SELECT * FROM menu_categories ORDER BY sort_order",
  );
  const items = await db.all<MenuItemRow>(
    "SELECT * FROM menu_items ORDER BY category_id,sort_order",
  );
  return cats.map((c) => ({
    ...c,
    items: items.filter((i) => i.category_id === c.id),
  }));
}
export async function menuReadiness(db: Store) {
  const rows = await db.all<{ name: string }>(
    "SELECT name FROM menu_items WHERE price_satang IS NULL",
  );
  return { ready: rows.length === 0, missing: rows.map((r) => r.name) };
}
export async function authenticate(
  c: Ctx,
  bearer?: string,
): Promise<CustomerAuth> {
  if (!bearer)
    throw unauthorized("NO_VISIT_TOKEN", "Please join the table first.");
  const access = await c.db.get<any>(
    "SELECT * FROM session_access WHERE hashed_visit_token=?",
    [sha256(bearer)],
  );
  if (!access || access.revoked_at)
    throw unauthorized("INVALID_VISIT_TOKEN", "Please scan the QR again.");
  if (access.expires_at <= stamp(c))
    throw unauthorized("VISIT_TOKEN_EXPIRED", "Your table access has expired.");
  const session = (await getSession(c.db, access.session_id))!;
  const table = (await getTableById(c.db, session.table_id))!;
  return {
    access,
    session,
    table,
    isCurrent:
      table.current_session_id === session.id &&
      ["OPEN", "PAYMENT_REQUESTED"].includes(session.status),
  };
}
export function requireCurrent(auth: CustomerAuth) {
  if (!auth.isCurrent)
    throw gone(
      "SESSION_ENDED",
      `Session ${auth.session.session_code} has ended.`,
    );
}
export async function joinSession(c: Ctx, qr: string, pin: string) {
  const result = await c.db.transaction(async (tx) => {
    const table = await getTableByQrToken(c.db, qr);
    if (!table) throw notFound("TABLE_NOT_FOUND", "Unknown table");
    const session = await getActiveSession(c.db, table);
    if (!session)
      throw conflict(
        "NO_ACTIVE_SESSION",
        "Please ask staff to open this table.",
      );
    if (session.pin_failed_attempts >= c.config.access.pinMaxFailedAttempts)
      throw new AppError(423, "PIN_LOCKED", "Please ask staff for a new PIN.");
    if (!/^\d+$/.test(pin) || !safeEqual(pin, session.join_pin)) {
      tx.run(
        "UPDATE table_sessions SET pin_failed_attempts=pin_failed_attempts+1 WHERE id=?",
        [session.id],
      );
      audit(
        tx,
        c,
        { type: "system" },
        "session.join_failed",
        "session",
        session.id,
      );
      return { error: true as const };
    }
    const token = randomToken(32),
      expiresAt = new Date(
        c.now().getTime() + c.config.access.visitTokenTtlHours * 3600000,
      ).toISOString();
    const id = await tx.id("session_access");
    tx.run(
      "INSERT INTO session_access(id,session_id,hashed_visit_token,issued_at,expires_at) VALUES (?,?,?,?,?)",
      [id, session.id, sha256(token), stamp(c), expiresAt],
    );
    audit(
      tx,
      c,
      { type: "customer", accessId: id },
      "session.join",
      "session",
      session.id,
    );
    return { visitToken: token, sessionCode: session.session_code, expiresAt };
  });
  if ("error" in result)
    throw unauthorized(
      "INVALID_PIN",
      "Incorrect PIN. Please check with staff.",
    );
  return result;
}
async function current(c: Ctx, auth: CustomerAuth) {
  // Revalidate token expiration and revocation in the same optimistic transaction.
  const access = await c.db.get<any>(
    "SELECT * FROM session_access WHERE id=?",
    [auth.access.id],
  );
  if (!access || access.revoked_at || access.expires_at <= stamp(c))
    throw unauthorized("INVALID_VISIT_TOKEN", "Please join again.");
  const s = (await getSession(c.db, access.session_id))!;
  const t = (await getTableById(c.db, s.table_id))!;
  if (
    t.current_session_id !== s.id ||
    !["OPEN", "PAYMENT_REQUESTED"].includes(s.status)
  )
    throw gone("SESSION_ENDED", `Session ${s.session_code} has ended.`);
  return s;
}
export const orderItems = (db: Store, id: number) =>
  db.all<OrderItemRow>(
    "SELECT * FROM order_items WHERE order_id=? ORDER BY id",
    [id],
  );
export async function sessionOrders(db: Store, id: number) {
  const orders = await db.all<OrderRow>(
    "SELECT * FROM orders WHERE session_id=? ORDER BY id",
    [id],
  );
  const items = await db.all<OrderItemRow>(
    "SELECT i.* FROM order_items i JOIN orders o ON o.id=i.order_id WHERE o.session_id=? ORDER BY i.id",
    [id],
  );
  return orders.map((o) => ({
    ...o,
    items: items.filter((i) => i.order_id === o.id),
  }));
}
export async function placeOrder(c: Ctx, auth: CustomerAuth, raw: unknown) {
  const input = normalize(raw),
    hash = sha256(JSON.stringify({ items: input.items, notes: input.notes }));
  return c.db.transaction(async (tx) => {
    const s = await current(c, auth);
    const existing = await tx.get<OrderRow & { request_hash: string }>(
      "SELECT * FROM orders WHERE session_id=? AND idempotency_key=?",
      [s.id, input.idempotencyKey],
    );
    if (existing) {
      if (existing.request_hash !== hash)
        throw conflict(
          "IDEMPOTENCY_MISMATCH",
          "This key was submitted with different contents.",
        );
      return {
        order: existing,
        items: await orderItems(c.db, existing.id),
        replayed: true,
      };
    }
    if (s.status !== "OPEN")
      throw conflict(
        "PAYMENT_REQUESTED",
        "New orders are paused while payment is requested.",
      );
    if (!(await menuReadiness(c.db)).ready)
      throw conflict("MENU_NOT_READY", "Ordering is not open yet.");
    const menu = await tx.all<MenuItemRow>("SELECT * FROM menu_items");
    const lines = input.items.map((l) => {
      const item = menu.find((i) => i.id === l.menuItemId);
      if (!item) throw badRequest("INVALID_ITEM", "Invalid menu item");
      if (!item.available)
        throw conflict("ITEM_UNAVAILABLE", `${item.name} is unavailable`);
      return {
        menu_item_id: item.id,
        item_name_snapshot: item.name,
        unit_price_satang: item.price_satang!,
        quantity: l.quantity,
        line_total_satang: item.price_satang! * l.quantity,
        note: l.note,
      };
    });
    const total = lines.reduce((s, l) => s + l.line_total_satang, 0);
    if (
      input.expectedTotalSatang !== undefined &&
      input.expectedTotalSatang !== total
    )
      throw conflict("PRICE_CHANGED", "Please review the new price.", {
        totalSatang: total,
      });
    const id = await tx.id("orders"),
      number = padNumber("ORD-", await tx.counter("order"), 4),
      time = stamp(c);
    const serve = action(tx, c, "order.serve", "order", id);
    tx.run(
      `INSERT INTO orders(id,order_number,session_id,status,notes,total_satang,created_at,idempotency_key,request_hash,serve_action_id) VALUES (?,?,?,'NEW',?,?,?,?,?,?)`,
      [
        id,
        number,
        s.id,
        input.notes,
        total,
        time,
        input.idempotencyKey,
        hash,
        serve,
      ],
    );
    for (const l of lines)
      tx.run(
        "INSERT INTO order_items(order_id,menu_item_id,item_name_snapshot,unit_price_satang,quantity,line_total_satang,note) VALUES (?,?,?,?,?,?,?)",
        [
          id,
          l.menu_item_id,
          l.item_name_snapshot,
          l.unit_price_satang,
          l.quantity,
          l.line_total_satang,
          l.note,
        ],
      );
    audit(
      tx,
      c,
      { type: "customer", accessId: auth.access.id },
      "order.create",
      "order",
      id,
      { orderNumber: number, total, session: s.session_code },
    );
    enqueue(
      tx,
      c,
      "telegram.order_card",
      { orderId: id },
      `order_card:new:${id}`,
    );
    return {
      order: {
        id,
        order_number: number,
        session_id: s.id,
        status: "NEW" as const,
        notes: input.notes,
        total_satang: total,
        created_at: time,
        served_at: null,
        served_by: null,
        serve_action_id: serve,
      },
      items: lines.map((l, i) => ({ ...l, id: i, order_id: id })),
      replayed: false,
    };
  });
}
export async function draftBill(
  db: Store,
  config: Config,
  s: SessionRow,
): Promise<BillView> {
  const orders = await sessionOrders(db, s.id);
  const lines = orders.flatMap((o) =>
    o.items.map((i) => ({
      orderId: o.id,
      orderNumber: o.order_number,
      itemName: i.item_name_snapshot,
      unitPriceSatang: i.unit_price_satang,
      quantity: i.quantity,
      lineTotalSatang: i.line_total_satang,
    })),
  );
  const subtotalSatang = lines.reduce((sum, l) => sum + l.lineTotalSatang, 0),
    adjustments = computeAdjustments(config, subtotalSatang);
  return {
    status: "DRAFT",
    billId: null,
    billNumber: null,
    version: null,
    sessionCode: s.session_code,
    orderNumbers: orders.map((o) => o.order_number),
    lines,
    subtotalSatang,
    adjustments,
    totalSatang:
      subtotalSatang + adjustments.reduce((s, a) => s + a.amountSatang, 0),
    requestedAt: null,
    paidAt: null,
  };
}
export async function frozenBillView(db: Store, b: BillRow): Promise<BillView> {
  const s = (await getSession(db, b.session_id))!;
  const rows = await db.all<any>(
    "SELECT * FROM bill_lines WHERE bill_id=? ORDER BY id",
    [b.id],
  );
  const lines = rows.map((l) => ({
    orderId: l.order_id,
    orderNumber: l.order_number,
    itemName: l.item_name,
    unitPriceSatang: l.unit_price_satang,
    quantity: l.quantity,
    lineTotalSatang: l.line_total_satang,
  }));
  return {
    status: b.status,
    billId: b.id,
    billNumber: b.bill_number,
    version: b.version,
    sessionCode: s.session_code,
    orderNumbers: [...new Set<string>(lines.map((l) => l.orderNumber))],
    lines,
    subtotalSatang: b.subtotal_satang,
    adjustments: JSON.parse(b.adjustments_json),
    totalSatang: b.total_satang,
    requestedAt: b.requested_at,
    paidAt: b.paid_at,
  };
}
export async function currentBillView(
  db: Store,
  config: Config,
  s: SessionRow,
) {
  const b = ["OPEN", "VOIDED"].includes(s.status)
    ? undefined
    : await db.get<BillRow>(
        "SELECT * FROM bills WHERE session_id=? AND version=?",
        [s.id, s.bill_version],
      );
  return b ? frozenBillView(db, b) : draftBill(db, config, s);
}
export async function requestPayment(c: Ctx, auth: CustomerAuth, body: any) {
  if (
    !Number.isSafeInteger(body?.expectedTotalSatang) ||
    !Number.isSafeInteger(body?.expectedOrderCount)
  )
    throw badRequest("INVALID_REQUEST", "Please review the bill first.");
  return c.db.transaction(async (tx) => {
    const s = await current(c, auth);
    if (s.status === "PAYMENT_REQUESTED")
      return { bill: await currentBillView(c.db, c.config, s), created: false };
    const d = await draftBill(c.db, c.config, s);
    if (!d.lines.length) throw conflict("NOTHING_TO_PAY", "No orders yet.");
    if (
      d.totalSatang !== body.expectedTotalSatang ||
      d.orderNumbers.length !== body.expectedOrderCount
    )
      throw conflict("BILL_CHANGED", "Please review the bill again.", {
        totalSatang: d.totalSatang,
      });
    const id = await tx.id("bills"),
      number = padNumber("BILL-", await tx.counter("bill"), 4),
      version = s.bill_version + 1,
      time = stamp(c);
    tx.run(
      `INSERT INTO bills(id,bill_number,session_id,version,subtotal_satang,adjustments_satang,adjustments_json,total_satang,status,requested_at) VALUES (?,?,?,?,?,?,?,?,'REQUESTED',?)`,
      [
        id,
        number,
        s.id,
        version,
        d.subtotalSatang,
        d.totalSatang - d.subtotalSatang,
        JSON.stringify(d.adjustments),
        d.totalSatang,
        time,
      ],
    );
    for (const l of d.lines)
      tx.run(
        "INSERT INTO bill_lines(bill_id,order_id,order_number,item_name,unit_price_satang,quantity,line_total_satang) VALUES (?,?,?,?,?,?,?)",
        [
          id,
          l.orderId,
          l.orderNumber,
          l.itemName,
          l.unitPriceSatang,
          l.quantity,
          l.lineTotalSatang,
        ],
      );
    tx.run(
      `UPDATE table_sessions SET status='PAYMENT_REQUESTED',bill_version=? WHERE id=?`,
      [version, s.id],
    );
    for (const method of c.config.billing.paymentMethods)
      action(tx, c, "payment.confirm", "bill", id, { method });
    action(tx, c, "bill.reopen", "bill", id);
    audit(
      tx,
      c,
      { type: "customer", accessId: auth.access.id },
      "bill.request_payment",
      "bill",
      id,
      { billNumber: number, total: d.totalSatang },
    );
    enqueue(
      tx,
      c,
      "telegram.payment_card",
      { billId: id },
      `payment_card:new:${id}`,
    );
    return {
      bill: {
        ...d,
        status: "REQUESTED" as const,
        billId: id,
        billNumber: number,
        version,
        requestedAt: time,
      },
      created: true,
    };
  });
}
async function staffAllowed(
  c: Ctx,
  actor: Actor & { type: "staff" },
  permission: Permission,
) {
  const staff = await findActiveStaff(c.db, actor.staff.telegram_user_id);
  if (!can(staff, permission))
    throw new AppError(403, "FORBIDDEN", "Not authorized for this action.");
}
export async function markServed(
  c: Ctx,
  id: number,
  actor: Actor & { type: "staff" },
) {
  return c.db.transaction(async (tx) => {
    await staffAllowed(c, actor, "order.serve");
    const o = await tx.get<OrderRow>("SELECT * FROM orders WHERE id=?", [id]);
    if (!o) throw badRequest("ORDER_NOT_FOUND", "Order not found");
    if (o.status === "SERVED") return { changed: false, order: o };
    const s = (await getSession(c.db, o.session_id))!;
    if (["PAID_CLOSED", "VOIDED"].includes(s.status))
      throw conflict("SESSION_CLOSED", "This session is closed.");
    const order = {
      ...o,
      status: "SERVED" as const,
      served_at: stamp(c),
      served_by: actor.staff.id,
    };
    tx.run(
      `UPDATE orders SET status='SERVED',served_at=?,served_by=? WHERE id=?`,
      [order.served_at, order.served_by, id],
    );
    audit(tx, c, actor, "order.served", "order", id);
    enqueue(
      tx,
      c,
      "telegram.order_card",
      { orderId: id },
      `order_card:served:${id}`,
    );
    return { changed: true, order };
  });
}
export async function confirmPayment(
  c: Ctx,
  id: number,
  method: string,
  actor: Actor & { type: "staff" },
) {
  if (!c.config.billing.paymentMethods.includes(method))
    throw badRequest("INVALID_METHOD", "Invalid payment method");
  return c.db.transaction(async (tx) => {
    await staffAllowed(c, actor, "payment.confirm");
    const b = await getBill(c.db, id);
    if (!b) throw badRequest("BILL_NOT_FOUND", "Bill not found");
    const existing = await tx.get<PaymentRow>(
      "SELECT * FROM payments WHERE bill_id=?",
      [id],
    );
    if (existing) return { changed: false, payment: existing, bill: b };
    if (b.status !== "REQUESTED")
      throw conflict("BILL_NOT_PAYABLE", "This bill cannot be paid.");
    const s = (await getSession(c.db, b.session_id))!,
      t = (await getTableById(c.db, s.table_id))!;
    if (
      s.status !== "PAYMENT_REQUESTED" ||
      s.bill_version !== b.version ||
      t.current_session_id !== s.id
    )
      throw conflict("BILL_STALE", "This bill is no longer active.");
    const sum = (await tx.get<{ s: number }>(
      "SELECT COALESCE(SUM(line_total_satang),0) AS s FROM bill_lines WHERE bill_id=?",
      [id],
    ))!.s;
    if (
      sum !== b.subtotal_satang ||
      sum + b.adjustments_satang !== b.total_satang
    )
      throw conflict("BILL_INTEGRITY", "Bill totals do not match.");
    const paymentId = await tx.id("payments"),
      receiptId = await tx.id("receipts"),
      number = padNumber("R-", await tx.counter("receipt"), 6),
      time = stamp(c);
    tx.run(
      `INSERT INTO payments(id,bill_id,amount_satang,method,status,confirmed_by,confirmed_at,idempotency_key) VALUES (?,?,?,?,'CONFIRMED',?,?,?)`,
      [
        paymentId,
        id,
        b.total_satang,
        method,
        actor.staff.id,
        time,
        `bill:${id}`,
      ],
    );
    tx.run(`UPDATE bills SET status='PAID',paid_at=? WHERE id=?`, [time, id]);
    tx.run(
      `UPDATE table_sessions SET status='PAID_CLOSED',closed_at=? WHERE id=?`,
      [time, s.id],
    );
    tx.run(
      `UPDATE tables SET status='AVAILABLE',current_session_id=NULL WHERE id=?`,
      [t.id],
    );
    tx.run(
      "INSERT INTO receipts(id,payment_id,receipt_number,lookup_token,width_mm) VALUES (?,?,?,?,?)",
      [receiptId, paymentId, number, randomToken(24), c.config.receipt.widthMm],
    );
    action(tx, c, "table.open", "bill", id, { tableNumber: t.display_number });
    audit(tx, c, actor, "payment.confirm", "bill", id, {
      paymentId,
      amount: b.total_satang,
      method,
      receiptNumber: number,
    });
    audit(tx, c, actor, "session.close", "session", s.id, {
      status: "PAID_CLOSED",
    });
    enqueue(
      tx,
      c,
      "telegram.payment_card",
      { billId: id },
      `payment_card:paid:${id}`,
    );
    enqueue(
      tx,
      c,
      "receipt.generate",
      { receiptId, send: true },
      `receipt:generate:${receiptId}`,
    );
    return {
      changed: true,
      payment: {
        id: paymentId,
        bill_id: id,
        amount_satang: b.total_satang,
        method,
        status: "CONFIRMED" as const,
        confirmed_by: actor.staff.id,
        confirmed_at: time,
        idempotency_key: `bill:${id}`,
      },
      bill: { ...b, status: "PAID" as const, paid_at: time },
    };
  });
}
export async function reopenBill(
  c: Ctx,
  target: { billId: number } | { tableNumber: number },
  actor: Actor & { type: "staff" },
) {
  return c.db.transaction(async (tx) => {
    await staffAllowed(c, actor, "bill.reopen");
    const b =
      "billId" in target
        ? await getBill(c.db, target.billId)
        : await tx.get<BillRow>(
            `SELECT b.* FROM bills b JOIN tables t ON t.current_session_id=b.session_id WHERE t.display_number=? AND b.status='REQUESTED'`,
            [target.tableNumber],
          );
    if (!b) throw conflict("NO_PENDING_BILL", "No bill to reopen.");
    if (b.status === "CANCELLED") return { changed: false, bill: b };
    if (b.status === "PAID") throw conflict("BILL_PAID", "This bill is paid.");
    const s = (await getSession(c.db, b.session_id))!;
    if (s.status !== "PAYMENT_REQUESTED" || s.bill_version !== b.version)
      throw conflict("BILL_STALE", "This bill is no longer active.");
    tx.run(
      `UPDATE bills SET status='CANCELLED',cancelled_at=?,cancelled_by=? WHERE id=?`,
      [stamp(c), actor.staff.id, b.id],
    );
    tx.run(`UPDATE table_sessions SET status='OPEN' WHERE id=?`, [s.id]);
    audit(tx, c, actor, "bill.reopen", "bill", b.id);
    enqueue(
      tx,
      c,
      "telegram.payment_card",
      { billId: b.id },
      `payment_card:cancelled:${b.id}`,
    );
    return { changed: true, bill: { ...b, status: "CANCELLED" as const } };
  });
}
export async function openSession(
  c: Ctx,
  n: number,
  actor: Actor & { type: "staff" },
) {
  return c.db.transaction(async (tx) => {
    await staffAllowed(c, actor, "table.open");
    const t = await getTableByNumber(c.db, n);
    if (!t) throw notFound("TABLE_NOT_FOUND", "Unknown table");
    if (t.current_session_id)
      throw conflict(
        "TABLE_ALREADY_OPEN",
        "Table already has an active session.",
      );
    const code = await nextSessionCode(c.db, t),
      round = Number(code.split("-").at(-1)),
      id = await tx.id("table_sessions"),
      pin = randomPin(c.config.access.pinLength),
      time = stamp(c);
    tx.run(
      `INSERT INTO table_sessions(id,table_id,round_number,session_code,status,join_pin,opened_at,opened_by) VALUES (?,?,?,?,'OPEN',?,?,?)`,
      [id, t.id, round, code, pin, time, actor.staff.id],
    );
    tx.run(
      `UPDATE tables SET current_session_id=?,status='OCCUPIED' WHERE id=?`,
      [id, t.id],
    );
    audit(tx, c, actor, "session.open", "session", id, { table: n, code });
    const pinAction = action(tx, c, "table.pin", "table", n);
    enqueue(tx, c, "telegram.text", {
      text: `🟢 <b>TABLE ${n} OPENED</b>\nSession: ${code}\nJoin PIN: <code>${pin}</code>\nGive the PIN only to seated guests.`,
      buttons: [[{ text: "🔁 New PIN", actionId: pinAction }]],
    });
    const previous = await tx.get<{ id: number }>(
      `SELECT b.id FROM bills b JOIN table_sessions s ON s.id=b.session_id WHERE s.table_id=? AND b.status='PAID' ORDER BY b.id DESC LIMIT 1`,
      [t.id],
    );
    if (previous)
      enqueue(tx, c, "telegram.payment_card", { billId: previous.id });
    return {
      id,
      table_id: t.id,
      round_number: round,
      session_code: code,
      status: "OPEN" as const,
      join_pin: pin,
      pin_failed_attempts: 0,
      opened_at: time,
      opened_by: actor.staff.id,
      closed_at: null,
      bill_version: 0,
    };
  });
}
export async function rotatePin(
  c: Ctx,
  n: number,
  actor: Actor & { type: "staff" },
) {
  return c.db.transaction(async (tx) => {
    await staffAllowed(c, actor, "table.pin");
    const t = await getTableByNumber(c.db, n),
      s = t && (await getActiveSession(c.db, t));
    if (!s) throw conflict("NO_ACTIVE_SESSION", "No active session.");
    const pin = randomPin(c.config.access.pinLength);
    tx.run(
      "UPDATE table_sessions SET join_pin=?,pin_failed_attempts=0 WHERE id=?",
      [pin, s.id],
    );
    audit(tx, c, actor, "session.pin_rotate", "session", s.id);
    enqueue(tx, c, "telegram.text", {
      text: `🔁 <b>NEW PIN · TABLE ${n}</b>\n${s.session_code}\nJoin PIN: <code>${pin}</code>`,
    });
    return { ...s, join_pin: pin, pin_failed_attempts: 0 };
  });
}
export async function voidSession(
  c: Ctx,
  n: number,
  actor: Actor & { type: "staff" },
  opts: { onlyIfEmpty: boolean; reason: string },
) {
  return c.db.transaction(async (tx) => {
    await staffAllowed(
      c,
      actor,
      opts.onlyIfEmpty ? "table.close_empty" : "session.void",
    );
    const t = await getTableByNumber(c.db, n),
      s = t && (await getActiveSession(c.db, t));
    if (!s) throw conflict("NO_ACTIVE_SESSION", "No active session.");
    const orderCount = (await tx.get<{ n: number }>(
      "SELECT COUNT(*) AS n FROM orders WHERE session_id=?",
      [s.id],
    ))!.n;
    if (opts.onlyIfEmpty && orderCount)
      throw conflict("SESSION_HAS_ORDERS", "This session has orders.");
    const b = await tx.get<{ id: number }>(
      `SELECT id FROM bills WHERE session_id=? AND status='REQUESTED'`,
      [s.id],
    );
    if (b) {
      tx.run(
        `UPDATE bills SET status='CANCELLED',cancelled_at=?,cancelled_by=? WHERE id=?`,
        [stamp(c), actor.staff.id, b.id],
      );
      enqueue(tx, c, "telegram.payment_card", { billId: b.id });
    }
    tx.run(`UPDATE table_sessions SET status='VOIDED',closed_at=? WHERE id=?`, [
      stamp(c),
      s.id,
    ]);
    tx.run(
      `UPDATE tables SET status='AVAILABLE',current_session_id=NULL WHERE id=?`,
      [t!.id],
    );
    audit(
      tx,
      c,
      actor,
      opts.onlyIfEmpty ? "session.close_empty" : "session.void",
      "session",
      s.id,
      opts,
    );
    return {
      session: { ...s, status: "VOIDED" as const },
      orderCount,
      next: await nextSessionCode(c.db, t!),
    };
  });
}
export async function setAvailability(
  c: Ctx,
  q: string,
  available: boolean,
  actor: Actor,
) {
  return c.db.transaction(async (tx) => {
    if (actor.type === "staff")
      await staffAllowed(c, actor, "menu.availability");
    const items = await tx.all<MenuItemRow>("SELECT * FROM menu_items"),
      query = q.toLowerCase().trim();
    const exact = items.find(
        (i) =>
          i.code === query ||
          i.name.toLowerCase() === query ||
          String(i.id) === query,
      ),
      matches = items.filter((i) => i.name.toLowerCase().includes(query));
    const i = exact ?? (matches.length === 1 ? matches[0] : undefined);
    if (!i) throw notFound("ITEM_NOT_FOUND", "Unknown or ambiguous menu item.");
    tx.run("UPDATE menu_items SET available=?,updated_at=? WHERE id=?", [
      available ? 1 : 0,
      stamp(c),
      i.id,
    ]);
    audit(
      tx,
      c,
      actor,
      available ? "menu.restock" : "menu.sold_out",
      "menu_item",
      i.id,
    );
    return { ...i, available: available ? 1 : 0 };
  });
}
/** Authenticated operations endpoint replaces the local-only CLI; no customer dashboard. */
export async function provision(c: Ctx, b: any) {
  return c.db.transaction(async (tx) => {
    if (b.operation === "tables") {
      if (!Number.isSafeInteger(b.count) || b.count < 1 || b.count > 100)
        throw badRequest("INVALID_COUNT", "Table count must be 1–100.");
      const existing = await tx.all<TableRow>("SELECT * FROM tables");
      for (let n = 1; n <= b.count; n++)
        if (!existing.some((t) => t.display_number === n))
          tx.run(
            "INSERT INTO tables(display_number,name,permanent_qr_token,status,created_at) VALUES (?,?,?,'AVAILABLE',?)",
            [n, `Table ${n}`, randomToken(12), stamp(c)],
          );
    } else if (b.operation === "staff") {
      if (
        !/^\d{1,20}$/.test(String(b.telegramUserId)) ||
        !["server", "cashier", "lead"].includes(b.role) ||
        typeof b.name !== "string" ||
        !b.name.trim()
      )
        throw badRequest("INVALID_STAFF", "Invalid staff details.");
      tx.run(
        "INSERT INTO staff(telegram_user_id,display_name,role,active,created_at) VALUES (?,?,?,?,?) ON CONFLICT(telegram_user_id) DO UPDATE SET display_name=excluded.display_name,role=excluded.role,active=excluded.active",
        [
          String(b.telegramUserId),
          b.name,
          b.role,
          b.active === false ? 0 : 1,
          stamp(c),
        ],
      );
    } else if (b.operation === "price") {
      if (
        typeof b.code !== "string" ||
        !Number.isSafeInteger(b.priceSatang) ||
        b.priceSatang <= 0 ||
        b.priceSatang > 100000000
      )
        throw badRequest("INVALID_PRICE", "Invalid price.");
      if (!(await tx.get("SELECT id FROM menu_items WHERE code=?", [b.code])))
        throw notFound("ITEM_NOT_FOUND", "Unknown menu code.");
      tx.run("UPDATE menu_items SET price_satang=?,updated_at=? WHERE code=?", [
        b.priceSatang,
        stamp(c),
        b.code,
      ]);
    } else throw badRequest("INVALID_OPERATION", "Unknown operation.");
    audit(
      tx,
      c,
      { type: "system" },
      "configuration.update",
      "configuration",
      null,
      { operation: b.operation },
    );
    return { ok: true };
  });
}
