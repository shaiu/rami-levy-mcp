import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CartStore } from './store.js';
import type { RamiLevyClient } from './client.js';

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

// The one path every cart-mutating tool goes through. It applies `mutate`
// locally, syncs the whole cart (the real /v2/cart is full-replace), and folds
// the outcome into {ok/reason..., ...extra, cartTotal, itemCount, serverTotal}.
//
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
  const before = store.snapshot();
  let sync: Awaited<ReturnType<RamiLevyClient['syncCart']>>;
  let payload: Record<string, string>;
  try {
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
        checkoutUrl: CHECKOUT_URL,
      });
    },

    async removeItem(args: { productId: string }): Promise<Content> {
      // Controller ruling: removing a productId that isn't in the cart is
      // not a no-op success — it must say so and must never sync (nothing
      // changed locally, so there's nothing new to push to the account).
      if (!store.getItems().some((i) => i.productId === args.productId)) {
        return json({ ok: false, reason: 'not_in_cart', productId: args.productId });
      }
      return json(await mutateAndSync(store, client, () => store.removeItem(args.productId)));
    },

    async clearCart(): Promise<Content> {
      // Syncs the now-empty cart to the real account.
      return json(await mutateAndSync(store, client, () => store.clear()));
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

      const summaries: { id: string; created_at: string }[] = [];
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

      const stats = new Map<string, { name: string; qtys: number[]; orders: Set<string> }>();
      for (const summary of selected) {
        const detail = await client.getOrderDetail(summary.id);
        if (!detail.ok) return json(detail);
        for (const line of detail.data.lines) {
          const id = String(line.item_id);
          let rec = stats.get(id);
          if (!rec) {
            rec = { name: line.name, qtys: [], orders: new Set() };
            stats.set(id, rec);
          }
          rec.qtys.push(parseFloat(line.quantity));
          rec.orders.add(summary.id);
        }
      }

      const added: { productId: string; name: string; qty: number }[] = [];
      for (const [id, rec] of stats) {
        if (rec.orders.size < minOccurrences) continue;
        const sorted = [...rec.qtys].sort((a, b) => a - b);
        const median = sorted[Math.floor(sorted.length / 2)];
        added.push({ productId: id, name: rec.name, qty: median });
      }

      if (added.length === 0) {
        return json({ ok: true, added: [], message: `No items appear in ${minOccurrences}+ of the last ${selected.length} orders` });
      }

      const apply = () => {
        for (const a of added) {
          // A past order line carries no current price, and the real /cart
          // endpoint prices server-side from productId anyway — reuse whatever
          // price this product already has in the cart, or 0 if it's new.
          // cartTotal under-counts a freshly-reordered item; serverTotal is
          // the authoritative number.
          const existing = store.getItems().find((i) => i.productId === a.productId);
          store.addItem(a.productId, a.name, existing?.price ?? 0, a.qty);
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

const CART_SYNC_NOTE =
  'Returns cartTotal (local estimate) and serverTotal (Rami Levy\'s own total — authoritative). ' +
  'ok:false with a transport reason means nothing changed. reason items_rejected means the server refused the listed products; ' +
  'they have been removed from the cart too, so tell the user and pick alternatives.';

export const RAMI_LEVY_TOOL_NAMES = [
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
      description: 'Show everything currently in the cart, with the running total and the checkout URL. Reads local state only — no network call.',
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
    'rami_levy_check_status',
    {
      description: 'Check whether the Rami Levy connection is working: probes the catalog search and the (session-authenticated) order history, returning the first failure if either fails, else the current cart size. Read-only.',
      inputSchema: {},
    },
    withErrorBoundary(h.checkStatus),
  );
}
