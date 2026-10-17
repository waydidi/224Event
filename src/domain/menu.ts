import type { Ctx } from '../context.ts';
import type { Database } from '../db/database.ts';
import { notFound } from '../lib/errors.ts';
import { audit, type Actor } from './audit.ts';

export interface MenuItemRow {
  id: number;
  category_id: number;
  code: string;
  name: string;
  description: string | null;
  price_satang: number | null;
  image_url: string | null;
  thumb_url: string | null;
  /** Full-resolution picture opened by tapping the photo; falls back to image_url. */
  full_url: string | null;
  available: number;
  prep_note: string | null;
  /** JSON array of ingredient names shown on the item's detail page. */
  ingredients: string;
  sort_order: number;
}

export function getMenu(db: Database) {
  const categories = db.all<{ id: number; code: string; name: string }>('SELECT id, code, name FROM menu_categories ORDER BY sort_order');
  const items = db.all<MenuItemRow>('SELECT * FROM menu_items ORDER BY category_id, sort_order');
  return categories.map((c) => ({ ...c, items: items.filter((i) => i.category_id === c.id) }));
}

/** Ordering is blocked until every menu item has an approved price. */
export function menuReadiness(db: Database) {
  const missing = db.all<{ name: string }>(`SELECT m.name FROM menu_items m JOIN menu_categories c ON c.id = m.category_id
     WHERE m.price_satang IS NULL ORDER BY c.sort_order, m.sort_order`).map((r) => r.name);
  return { ready: missing.length === 0, missing };
}

export function findMenuItem(db: Database, query: string): MenuItemRow {
  const q = query.trim().toLowerCase();
  const items = db.all<MenuItemRow>('SELECT * FROM menu_items');
  const exact = items.find((i) => i.code === q || i.name.toLowerCase() === q || String(i.id) === q);
  if (exact) return exact;
  const partial = items.filter((i) => i.name.toLowerCase().includes(q));
  if (partial.length === 1) return partial[0];
  if (partial.length > 1) throw notFound('AMBIGUOUS_ITEM', `"${query}" matches: ${partial.map((p) => p.name).join(', ')}`);
  throw notFound('ITEM_NOT_FOUND', `No menu item matches "${query}"`);
}

export function setPrice(ctx: Ctx, query: string, priceSatang: number, actor: Actor) {
  if (!Number.isSafeInteger(priceSatang) || priceSatang <= 0) throw new Error('Price must be a positive amount');
  return ctx.db.tx(() => {
    const item = findMenuItem(ctx.db, query);
    ctx.db.run('UPDATE menu_items SET price_satang = ?, updated_at = ? WHERE id = ?', [priceSatang, ctx.now().toISOString(), item.id]);
    audit(ctx, actor, 'menu.set_price', 'menu_item', item.id, { from: item.price_satang, to: priceSatang });
    return { ...item, price_satang: priceSatang };
  });
}

export function setAvailability(ctx: Ctx, query: string, available: boolean, actor: Actor) {
  return ctx.db.tx(() => {
    const item = findMenuItem(ctx.db, query);
    ctx.db.run('UPDATE menu_items SET available = ?, updated_at = ? WHERE id = ?', [available ? 1 : 0, ctx.now().toISOString(), item.id]);
    audit(ctx, actor, available ? 'menu.restock' : 'menu.sold_out', 'menu_item', item.id);
    return { ...item, available: available ? 1 : 0 };
  });
}

export function updateItemDetails(ctx: Ctx, query: string, fields: { description?: string | null; image_url?: string | null; thumb_url?: string | null; full_url?: string | null; prep_note?: string | null; ingredients?: string[] }) {
  return ctx.db.tx(() => {
    const item = findMenuItem(ctx.db, query);
    const { ingredients: list, ...rest } = fields;
    const next = { description: item.description, image_url: item.image_url, thumb_url: item.thumb_url, full_url: item.full_url, prep_note: item.prep_note, ...rest };
    const ingredients = list ? JSON.stringify(list.map((s) => s.trim()).filter(Boolean).slice(0, 12)) : item.ingredients;
    for (const [k, v] of [['image_url', next.image_url], ['thumb_url', next.thumb_url], ['full_url', next.full_url]] as const) {
      if (v && !/^(https:\/\/|\/)/.test(v)) throw new Error(`${k} must be https:// or a site-relative path`);
    }
    ctx.db.run('UPDATE menu_items SET description = ?, image_url = ?, thumb_url = ?, full_url = ?, prep_note = ?, ingredients = ?, updated_at = ? WHERE id = ?', [
      next.description, next.image_url, next.thumb_url, next.full_url, next.prep_note, ingredients, ctx.now().toISOString(), item.id,
    ]);
    audit(ctx, { type: 'system' }, 'menu.update_details', 'menu_item', item.id, fields);
    return { ...item, ...next, ingredients };
  });
}
