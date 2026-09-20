import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CartStore } from './store.js';
import type { ClientError, RamiLevyClient } from './client.js';
import { jerusalemLocalToUtcMs } from './time.js';

type Content = { content: { type: 'text'; text: string }[] };
const json = (v: unknown): Content => ({ content: [{ type: 'text', text: JSON.stringify(v, null, 2) }] });

const CHECKOUT_URL = 'https://www.rami-levy.co.il/he/dashboard/checkout';

function cartPayload(store: CartStore): Record<string, string> {
  const payload: Record<string, string> = {};
  for (const item of store.getItems()) {
    payload[item.productId] = item.qty.toFixed(2);
  }
  return payload;
}

// Order money and quantities arrive as numbers on some fields and strings on
// others ("4.9"), and older orders omit them outright — so anything shown to
// the user is coerced once here, and an unusable value is reported as null
// rather than as NaN or a silent 0.
function numberOrNull(value: unknown): number | null {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

const VIEW_CART_SCOPE =
  'Items this tool has added since the last checkout. Changes made on the Rami Levy website are not visible: ' +
  'the API has no way to read the cart back.';

// The merge into the browser's own cart runs on checkout page load, so a
// checkout tab that was already open when the cart changed keeps showing the
// pre-change contents — which reads like the change silently failed. Saying so
// in the payload, not just in the tool description, is what stops the agent
// from sending the user to a stale page.
const CHECKOUT_HINT =
  'The site merges this cart into the browser only when the checkout page loads, so a checkout page ' +
  'opened before the last change still shows the old contents — reload it.';

export interface ResetAfterOrder {
  orderId: string | number;
  createdAt: string;
}

// Rami Levy has no cart-read endpoint, so the local cart can't see a checkout
// made on the website. After one, the site's cart is empty but the local cart
// still holds everything that was bought, and the next full-replace sync would
// put the whole order back. This finds that case: an order created after the
// last successful sync means the local items were bought.
//
// - Empty local cart, or no sync ever recorded (a DB from before this check
//   existed): nothing to detect, and no network call.
// - Order-list failure: returned as-is, and the caller must not mutate. A
//   check that can't run is never treated as "no new order".
// - Comparison: last_synced_at is a UTC instant; created_at arrives either
//   zoned (ISO-8601 with Z, what the live API sends today) or as a naive
//   Israel-time string, and is resolved to a UTC instant either way (see
//   time.ts). A created_at that can't be parsed is an error, not a skip.
async function detectCheckout(
  store: CartStore,
  client: RamiLevyClient,
): Promise<{ ok: true; reset: ResetAfterOrder | null } | ClientError> {
  if (store.size === 0) return { ok: true, reset: null };
  const lastSyncedAt = store.getLastSyncedAt();
  if (lastSyncedAt === null) return { ok: true, reset: null };
  const lastSyncedMs = Date.parse(lastSyncedAt);
  if (!Number.isFinite(lastSyncedMs)) return { ok: true, reset: null };

  const list = await client.getOrderList(1);
  if (!list.ok) return list;

  let newest: { order: ResetAfterOrder; ms: number } | null = null;
  for (const order of list.data.orders) {
    const ms = typeof order.created_at === 'string' ? jerusalemLocalToUtcMs(order.created_at) : null;
    if (ms === null) {
      return {
        ok: false,
        reason: 'network_error',
        details: `order ${String(order.id)} has an unrecognized created_at ${JSON.stringify(order.created_at)}; cannot tell whether the cart was checked out`,
      };
    }
    // The API lists newest first, but that isn't relied on.
    if (ms > lastSyncedMs && (newest === null || ms > newest.ms)) {
      newest = { order: { orderId: order.id, createdAt: order.created_at }, ms };
    }
  }
  return { ok: true, reset: newest?.order ?? null };
}

// The one path every cart-mutating tool goes through. It first checks for a
// checkout since the last sync (detectCheckout) and, if there was one, clears
// the local cart before applying `mutate`. It then syncs the whole cart (the
// real /v2/cart is full-replace), and folds the outcome into
// {ok/reason..., resetAfterOrder?, ...extra, cartTotal, itemCount, serverTotal}.
//
// - The checkout check fails: its error is returned and nothing is mutated.
// - The reset is part of the mutation: `before` is taken ahead of it, so a
//   failed sync restores the pre-reset cart, and the next call re-detects the
//   same order (last_synced_at didn't move).
// - Transport failure (auth_expired / blocked_by_cloudflare / network_error),
//   or a throw: the local cart is restored to its pre-mutation snapshot, so
//   ok:false means nothing changed and a retry can't double-add.
// - The server dropped some sent products: they're removed locally too (local
//   mirrors the real cart) and the result is items_rejected, never ok:true.
// - An empty sync (clear) is accepted only if the server reports an empty cart.
async function mutateAndSync(
  store: CartStore,
  client: RamiLevyClient,
  mutate: () => void,
  extra: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  const checkout = await detectCheckout(store, client);
  if (!checkout.ok) return checkout;
  const reset = checkout.reset;
  if (reset) extra = { resetAfterOrder: reset, ...extra };

  const before = store.snapshot();
  let sync: Awaited<ReturnType<RamiLevyClient['syncCart']>>;
  let payload: Record<string, string>;
  try {
    if (reset) store.clear();
    mutate();
    payload = cartPayload(store);
    sync = await client.syncCart(payload);
  } catch (err) {
    store.replaceAll(before);
    throw err;
  }

  const totals = (serverTotal: number | null) => ({ cartTotal: store.getTotal(), itemCount: store.size, serverTotal });

  if (!sync.ok) {
    store.replaceAll(before);
    return { ...sync, ...totals(null) };
  }

  const sentIds = Object.keys(payload);
  if (sentIds.length === 0 && sync.acceptedIds.length > 0) {
    store.replaceAll(before);
    return {
      ok: false,
      reason: 'network_error',
      details: `cart not emptied: server still holds ${JSON.stringify(sync.acceptedIds).slice(0, 200)}`,
      ...totals(sync.serverTotal),
    };
  }

  // The server now holds exactly what was accepted from this payload.
  store.setLastSyncedAt(new Date().toISOString());

  const accepted = new Set(sync.acceptedIds);
  const rejected = store
    .getItems()
    .filter((item) => !accepted.has(item.productId))
    .map((item) => ({ productId: item.productId, name: item.name }));
  if (rejected.length > 0) {
    for (const r of rejected) store.removeItem(r.productId);
    return { ok: false, reason: 'items_rejected', rejected, ...extra, ...totals(sync.serverTotal) };
  }

  return { ok: true, ...extra, ...totals(sync.serverTotal) };
}

export function ramiLevyToolHandlers(store: CartStore, client: RamiLevyClient) {
  return {
    async searchProducts(args: { query: string; limit?: number }): Promise<Content> {
      const result = await client.searchProducts(args.query, args.limit ?? 5);
      return json(result);
    },

    async addItem(args: { productId: string; name: string; price: number; qty?: number }): Promise<Content> {
      const qty = args.qty ?? 1;
      return json(await mutateAndSync(store, client, () => store.addItem(args.productId, args.name, args.price, qty)));
    },

    async viewCart(): Promise<Content> {
      return json({
        ok: true,
        items: store.getItems(),
        total: store.getTotal(),
        scope: VIEW_CART_SCOPE,
        checkoutUrl: CHECKOUT_URL,
        checkoutHint: CHECKOUT_HINT,
      });
    },

    async removeItem(args: { productId: string }): Promise<Content> {
      // Controller ruling: removing a productId that isn't in the cart is
      // not a no-op success — it must say so and must never sync (nothing
      // changed locally, so there's nothing new to push to the account).
      // Checked before the checkout check: it needs no network, and if the
      // product isn't here, no reset could put it here either.
      if (!store.getItems().some((i) => i.productId === args.productId)) {
        return json({ ok: false, reason: 'not_in_cart', productId: args.productId });
      }
      return json(await mutateAndSync(store, client, () => store.removeItem(args.productId)));
    },

    async clearCart(): Promise<Content> {
      // Syncs the now-empty cart to the real account.
      return json(await mutateAndSync(store, client, () => store.clear()));
    },

    async listOrders(args: { page?: number }): Promise<Content> {
      const page = args.page ?? 1;
      if (!Number.isInteger(page) || page < 1) {
        return json({ ok: false, reason: 'invalid_args', message: 'page must be an integer of 1 or more' });
      }
      const result = await client.getOrderList(page);
      if (!result.ok) return json(result);
      return json({
        ok: true,
        page: result.data.currentPage,
        lastPage: result.data.lastPage,
        totalOrders: result.data.total,
        orders: result.data.orders.map((o) => ({
          orderId: o.id,
          createdAt: o.created_at,
          supplyAt: o.supply_at ?? null,
          status: o.status_api ?? null,
          total: numberOrNull(o.final_price),
        })),
      });
    },

    async viewOrder(args: { orderId: string }): Promise<Content> {
      const result = await client.getOrderDetail(args.orderId);
      if (!result.ok) return json(result);
      const order = result.data;
      return json({
        ok: true,
        orderId: args.orderId,
        createdAt: order.created_at ?? null,
        supplyAt: order.supply_at ?? null,
        status: order.status_api ?? null,
        total: numberOrNull(order.final_price),
        deliveryPrice: numberOrNull(order.delivery_price),
        lineCount: order.lines.length,
        lines: order.lines.map((line) => ({
          productId: String(line.item_id),
          name: line.name,
          price: numberOrNull(line.price),
          qty: numberOrNull(line.quantity),
          lineTotal: numberOrNull(line.total_price),
        })),
      });
    },

    async reorderFromHistory(args: { numOrders?: number; minOccurrences?: number }): Promise<Content> {
      const numOrders = args.numOrders ?? 10;
      const minOccurrences = args.minOccurrences ?? 3;
      if (numOrders < 1 || numOrders > 50) {
        return json({ ok: false, reason: 'invalid_args', message: 'numOrders must be between 1 and 50' });
      }
      if (minOccurrences < 1 || minOccurrences > numOrders) {
        return json({ ok: false, reason: 'invalid_args', message: `minOccurrences must be between 1 and ${numOrders}` });
      }

      const summaries: { id: string | number; created_at: string }[] = [];
      let page = 1;
      while (summaries.length < numOrders) {
        const result = await client.getOrderList(page);
        if (!result.ok) return json(result);
        summaries.push(...result.data.orders);
        if (page >= result.data.lastPage) break;
        page++;
      }
      summaries.sort((a, b) => b.created_at.localeCompare(a.created_at));
      const selected = summaries.slice(0, numOrders);

      // `selected` is sorted newest-first, so the first line seen for a given
      // item_id (across orders, in this loop's iteration order) always comes
      // from the most recent order that carried it — that's where `price`
      // is captured from.
      const stats = new Map<string, { name: string; qtys: number[]; orders: Set<string>; price?: number }>();
      for (const summary of selected) {
        const detail = await client.getOrderDetail(summary.id);
        if (!detail.ok) return json(detail);
        for (const line of detail.data.lines) {
          // A line whose quantity isn't a positive finite number can't be
          // reordered meaningfully, so it's skipped entirely rather than
          // polluting the median or counting as an occurrence.
          const qty = numberOrNull(line.quantity);
          if (qty === null || qty <= 0) continue;

          const id = String(line.item_id);
          let rec = stats.get(id);
          if (!rec) {
            rec = { name: line.name, qtys: [], orders: new Set() };
            stats.set(id, rec);
          }
          rec.qtys.push(qty);
          rec.orders.add(String(summary.id));
          if (rec.price === undefined) {
            const price = numberOrNull(line.price);
            if (price !== null) rec.price = price;
          }
        }
      }

      const added: { productId: string; name: string; qty: number; price?: number }[] = [];
      for (const [id, rec] of stats) {
        if (rec.orders.size < minOccurrences) continue;
        const sorted = [...rec.qtys].sort((a, b) => a - b);
        const median = sorted[Math.floor(sorted.length / 2)];
        added.push({ productId: id, name: rec.name, qty: median, price: rec.price });
      }

      if (added.length === 0) {
        return json({ ok: true, added: [], message: `No items appear in ${minOccurrences}+ of the last ${selected.length} orders` });
      }

      const apply = () => {
        for (const a of added) {
          // Price the reorder at the price from the most recent order line
          // that carried this product (a.price, computed above). Fall back
          // to whatever price this product already has in the cart, then 0,
          // only when no order line ever carried a finite price. The real
          // /cart endpoint prices server-side from productId anyway, so this
          // only affects the local cartTotal estimate; serverTotal (from the
          // sync response) is authoritative.
          const existing = store.getItems().find((i) => i.productId === a.productId);
          store.addItem(a.productId, a.name, a.price ?? existing?.price ?? 0, a.qty);
        }
      };
      return json(await mutateAndSync(store, client, apply, { added }));
    },

    async checkStatus(): Promise<Content> {
      // The real API has no dedicated health endpoint. Two read-only probes:
      // a catalog search (www host; also exercises the query-echo check) and
      // page 1 of the order list (www-api host, and it needs the logged-in
      // session — the catalog may well answer anonymous requests, so it alone
      // can't detect an expired session).
      const search = await client.searchProducts('חלב', 1);
      if (!search.ok) return json(search);
      const orders = await client.getOrderList(1);
      if (!orders.ok) return json(orders);
      return json({ ok: true, cartSize: store.size });
    },
  };
}

// Structural no-throw boundary: ramiLevyToolHandlers itself is left
// unwrapped (so tests exercise real behaviour), but every handler the SDK
// actually calls is wrapped once here, so a thrown error becomes the same
// JSON content shape the handlers already return on a known failure,
// instead of an uncaught exception escaping across the tool boundary.
export function withErrorBoundary<Args extends unknown[]>(
  fn: (...args: Args) => Promise<Content>,
): (...args: Args) => Promise<Content> {
  return async (...args: Args): Promise<Content> => {
    try {
      return await fn(...args);
    } catch (err) {
      return json({ ok: false, reason: 'internal_error', details: err instanceof Error ? err.message : String(err) });
    }
  };
}

const PRODUCT_ID = z.string().min(1);
const NAME = z.string().min(1);
const PRICE = z.number().nonnegative();
const QTY = z.number().positive().optional();
const LIMIT = z.number().int().min(1).max(50).optional();
const ORDER_ID = z.string().min(1);
// Unbounded above on purpose: the history is as long as it is (140 orders /
// 24 pages on a real account), and a page past the end comes back empty
// rather than as an error.
const PAGE = z.number().int().min(1).optional();

const CART_SYNC_NOTE =
  'Returns cartTotal (local estimate) and serverTotal (Rami Levy\'s own total — authoritative). ' +
  'ok:false with a transport reason means nothing changed. reason items_rejected means the server refused the listed products; ' +
  'they have been removed from the cart too, so tell the user and pick alternatives. ' +
  'If resetAfterOrder {orderId, createdAt} is present, an order was placed since the last sync, so the items from before it were ' +
  'treated as bought and cleared first; tell the user the cart started fresh after that order. ' +
  'A change made while the user already has the checkout page open is not visible there until they reload it — say so rather than ' +
  'letting them read a stale page as a failed change.';

export const RAMI_LEVY_TOOL_NAMES = [
  'rami_levy_list_orders',
  'rami_levy_view_order',
  'rami_levy_search_products',
  'rami_levy_add_item',
  'rami_levy_view_cart',
  'rami_levy_remove_item',
  'rami_levy_clear_cart',
  'rami_levy_reorder_from_history',
  'rami_levy_check_status',
] as const;

export function registerRamiLevyTools(server: McpServer, store: CartStore, client: RamiLevyClient): void {
  const h = ramiLevyToolHandlers(store, client);

  // McpServer.tool() is @deprecated in the installed SDK (1.30.x) in favor
  // of registerTool() — same names/descriptions/schemas, different call shape.
  server.registerTool(
    'rami_levy_search_products',
    {
      description: 'Search Rami Levy\'s real catalog. Returns productId, name, price for each hit. Call this before rami_levy_add_item — a productId is never invented.',
      inputSchema: { query: z.string().min(1), limit: LIMIT },
    },
    withErrorBoundary(h.searchProducts),
  );

  server.registerTool(
    'rami_levy_add_item',
    {
      description: 'Add a product to the shared cart. productId, name, and price all come from a prior rami_levy_search_products result — never guessed, and never re-fetched (there is no "get one product" endpoint). If this product is already in the cart, qty is ADDED to what\'s there, not overwritten. Syncs the whole cart to the real Rami Levy account immediately. ' + CART_SYNC_NOTE,
      inputSchema: { productId: PRODUCT_ID, name: NAME, price: PRICE, qty: QTY },
    },
    withErrorBoundary(h.addItem),
  );

  server.registerTool(
    'rami_levy_view_cart',
    {
      description: 'Show this tool\'s own list of what it has put in the cart since the last checkout, with a running total and the checkout URL. ' +
        'This is NOT a read of the Rami Levy website cart: the API has no way to read the cart back, so anything added, removed or emptied on the website is not visible here (see `scope`). ' +
        'Reads local state only — no network call. Give the user the checkout URL: the Rami Levy site shows these items once its checkout page loads, ' +
        'not on the home-page cart icon — and an already-open checkout page needs a reload (see `checkoutHint`).',
      inputSchema: {},
    },
    withErrorBoundary(h.viewCart),
  );

  server.registerTool(
    'rami_levy_remove_item',
    {
      description: 'Remove one product from the cart by productId, then re-syncs the remaining cart to the real account. ' + CART_SYNC_NOTE,
      inputSchema: { productId: PRODUCT_ID },
    },
    withErrorBoundary(h.removeItem),
  );

  server.registerTool(
    'rami_levy_clear_cart',
    {
      description: 'Empty the cart completely, both locally and on the real Rami Levy account. ' + CART_SYNC_NOTE,
      inputSchema: {},
    },
    withErrorBoundary(h.clearCart),
  );

  server.registerTool(
    'rami_levy_reorder_from_history',
    {
      description: 'Look at the last numOrders (default 10, max 50) real orders, find items that appear in at least minOccurrences (default 3) of them, and add each at its median past quantity. ADDS onto whatever is already in the cart — it does not replace it. ' + CART_SYNC_NOTE,
      inputSchema: { numOrders: z.number().int().min(1).max(50).optional(), minOccurrences: z.number().int().min(1).optional() },
    },
    withErrorBoundary(h.reorderFromHistory),
  );

  server.registerTool(
    'rami_levy_list_orders',
    {
      description: 'List one page of the account\'s past orders, newest first: orderId, createdAt (ISO-8601 UTC), supplyAt (the delivery slot, Israel local time), status and total (what was charged, delivery fee included). ' +
        'Paginated — the response carries page, lastPage and totalOrders, so ask for page 2, 3, … to go further back. Read-only: it never touches the cart. ' +
        'Pass an orderId to rami_levy_view_order to see what was in that order.',
      inputSchema: { page: PAGE },
    },
    withErrorBoundary(h.listOrders),
  );

  server.registerTool(
    'rami_levy_view_order',
    {
      description: 'Show one past order in full: every line with productId, name, unit price, qty and lineTotal, plus the order\'s own total, delivery fee, status and delivery slot. ' +
        'The orderId comes from rami_levy_list_orders. Read-only: it never touches the cart. ' +
        'A price, qty or total the order data does not carry is reported as null rather than 0. ' +
        'productId is the same id rami_levy_add_item takes, so a line can be re-added directly — but its price is what was paid then, not today\'s.',
      inputSchema: { orderId: ORDER_ID },
    },
    withErrorBoundary(h.viewOrder),
  );

  server.registerTool(
    'rami_levy_check_status',
    {
      description: 'Check whether the Rami Levy connection is working: probes the catalog search and the (session-authenticated) order history, returning the first failure if either fails, else the current cart size. Read-only.',
      inputSchema: {},
    },
    withErrorBoundary(h.checkStatus),
  );
}
