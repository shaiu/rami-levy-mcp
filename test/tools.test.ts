import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CartStore } from '../src/store.js';
import { ramiLevyToolHandlers, withErrorBoundary } from '../src/tools.js';
import type { RamiLevyClient } from '../src/client.js';

function tempStore(): CartStore {
  return new CartStore(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rl-tools-')), 'cart.db'));
}

function textOf(result: { content: { type: 'text'; text: string }[] }): unknown {
  return JSON.parse(result.content[0].text);
}

// A server that accepts every product it's sent.
const acceptAll = (items: Record<string, string>, serverTotal: number | null = null) =>
  ({ ok: true as const, acceptedIds: Object.keys(items), serverTotal });

function fakeClient(overrides: Partial<RamiLevyClient> = {}): RamiLevyClient {
  return {
    searchProducts: async () => ({ ok: true, results: [] }),
    syncCart: async (items: Record<string, string>) => acceptAll(items),
    getOrderList: async () => ({ ok: true, data: { orders: [], currentPage: 1, lastPage: 1, total: 0 } }),
    getOrderDetail: async () => ({ ok: true, data: { id: '1', lines: [] } }),
    ...overrides,
  } as unknown as RamiLevyClient;
}

test('searchProducts returns the client results as-is', async () => {
  const store = tempStore();
  const client = fakeClient({
    searchProducts: async () => ({ ok: true, results: [{ productId: '1', name: 'Milk', price: 6.9 }] }),
  });
  const h = ramiLevyToolHandlers(store, client);
  const out = textOf(await h.searchProducts({ query: 'milk' }));
  assert.deepEqual(out, { ok: true, results: [{ productId: '1', name: 'Milk', price: 6.9 }] });
  store.close();
});

test('addItem stores the item and syncs the full cart', async () => {
  const store = tempStore();
  let syncedItems: Record<string, string> | undefined;
  const client = fakeClient({
    syncCart: async (items: Record<string, string>) => {
      syncedItems = items;
      return acceptAll(items, 13.5);
    },
  });
  const h = ramiLevyToolHandlers(store, client);
  const out = textOf(await h.addItem({ productId: '1', name: 'Milk', price: 6.9, qty: 2 })) as { ok: boolean; cartTotal: number; itemCount: number; serverTotal: number };
  assert.equal(out.ok, true);
  assert.equal(out.cartTotal, 13.8);
  assert.equal(out.itemCount, 1);
  assert.equal(out.serverTotal, 13.5);
  assert.deepEqual(syncedItems, { '1': '2.00' });
  store.close();
});

test('addItem surfaces a sync failure and leaves the local cart unchanged', async () => {
  const store = tempStore();
  store.addItem('2', 'Bread', 8.5, 1);
  const client = fakeClient({ syncCart: async () => ({ ok: false, reason: 'auth_expired', status: 401 }) });
  const h = ramiLevyToolHandlers(store, client);
  const out = textOf(await h.addItem({ productId: '1', name: 'Milk', price: 6.9, qty: 1 }));
  assert.deepEqual(out, { ok: false, reason: 'auth_expired', status: 401, cartTotal: 8.5, itemCount: 1, serverTotal: null });
  assert.deepEqual(store.getItems(), [{ productId: '2', name: 'Bread', price: 8.5, qty: 1 }]);
  store.close();
});

test('addItem retried after a failed sync does not double-add', async () => {
  const store = tempStore();
  let fail = true;
  const client = fakeClient({
    syncCart: async (items: Record<string, string>) => (fail ? { ok: false, reason: 'blocked_by_cloudflare' } : acceptAll(items)),
  });
  const h = ramiLevyToolHandlers(store, client);
  await h.addItem({ productId: '1', name: 'Milk', price: 6.9, qty: 2 });
  fail = false;
  await h.addItem({ productId: '1', name: 'Milk', price: 6.9, qty: 2 });
  assert.deepEqual(store.getItems(), [{ productId: '1', name: 'Milk', price: 6.9, qty: 2 }]);
  store.close();
});

test('addItem whose product the server rejects removes it locally and reports items_rejected', async () => {
  const store = tempStore();
  store.addItem('1', 'Milk', 6.9, 1);
  const client = fakeClient({ syncCart: async () => ({ ok: true, acceptedIds: ['1'], serverTotal: 6.9 }) });
  const h = ramiLevyToolHandlers(store, client);
  const out = textOf(await h.addItem({ productId: '2', name: 'Bread', price: 8.5, qty: 1 }));
  assert.deepEqual(out, {
    ok: false,
    reason: 'items_rejected',
    rejected: [{ productId: '2', name: 'Bread' }],
    cartTotal: 6.9,
    itemCount: 1,
    serverTotal: 6.9,
  });
  assert.deepEqual(store.getItems(), [{ productId: '1', name: 'Milk', price: 6.9, qty: 1 }]);
  store.close();
});

test('addItem ignores the server-added delivery-fee line in the sync response (real shape, 2026-09-18)', async () => {
  const store = tempStore();
  const client = fakeClient({
    // Real syncCart output for a one-item sync: acceptedIds carries both the
    // product's id and the delivery-fee line's id, and serverTotal (7.1) is
    // the product total, excluding the 35.9 delivery fee.
    syncCart: async () => ({ ok: true, acceptedIds: ['419939', '164854'], serverTotal: 7.1 }),
  });
  const h = ramiLevyToolHandlers(store, client);
  const out = textOf(await h.addItem({ productId: '419939', name: 'Milk', price: 7.1, qty: 1 }));
  assert.deepEqual(out, { ok: true, cartTotal: 7.1, itemCount: 1, serverTotal: 7.1 });
  // The delivery line was never reported (no items_rejected, no `added`) and
  // never stored locally — the cart holds only the product that was added.
  assert.deepEqual(store.getItems(), [{ productId: '419939', name: 'Milk', price: 7.1, qty: 1 }]);
  store.close();
});

test('an unrecognized cart response shape (network_error from the client) leaves the local cart unchanged', async () => {
  const store = tempStore();
  const client = fakeClient({
    syncCart: async () => ({ ok: false, reason: 'network_error', details: 'Unexpected cart response shape: {"success":true,"ok":true}' }),
  });
  const h = ramiLevyToolHandlers(store, client);
  const out = textOf(await h.addItem({ productId: '1', name: 'Milk', price: 6.9 })) as { ok: boolean; reason: string };
  assert.equal(out.ok, false);
  assert.equal(out.reason, 'network_error');
  assert.deepEqual(store.getItems(), []);
  store.close();
});

test('viewCart reads local state only, no client call', async () => {
  const store = tempStore();
  store.addItem('1', 'Milk', 6.9, 1);
  let clientCalled = false;
  const client = fakeClient({ searchProducts: async () => { clientCalled = true; return { ok: true, results: [] }; } });
  const h = ramiLevyToolHandlers(store, client);
  const out = textOf(await h.viewCart());
  assert.equal(clientCalled, false);
  assert.deepEqual(out, {
    ok: true,
    items: [{ productId: '1', name: 'Milk', price: 6.9, qty: 1 }],
    total: 6.9,
    scope: 'Items this tool has added since the last checkout. Changes made on the Rami Levy website are not visible: the API has no way to read the cart back.',
    checkoutUrl: 'https://www.rami-levy.co.il/he/dashboard/checkout',
    checkoutHint: 'The site merges this cart into the browser only when the checkout page loads, so a checkout page opened before the last change still shows the old contents — reload it.',
  });
  store.close();
});

test('removeItem removes locally and re-syncs the remaining cart', async () => {
  const store = tempStore();
  store.addItem('1', 'Milk', 6.9, 1);
  store.addItem('2', 'Bread', 8.5, 1);
  let syncedItems: Record<string, string> | undefined;
  const client = fakeClient({ syncCart: async (items: Record<string, string>) => { syncedItems = items; return acceptAll(items); } });
  const h = ramiLevyToolHandlers(store, client);
  await h.removeItem({ productId: '1' });
  assert.deepEqual(store.getItems(), [{ productId: '2', name: 'Bread', price: 8.5, qty: 1 }]);
  assert.deepEqual(syncedItems, { '2': '1.00' });
  store.close();
});

test('removeItem on a product not in the cart reports not_in_cart and does not sync', async () => {
  const store = tempStore();
  store.addItem('2', 'Bread', 8.5, 1);
  let syncCalled = false;
  const client = fakeClient({ syncCart: async (items: Record<string, string>) => { syncCalled = true; return acceptAll(items); } });
  const h = ramiLevyToolHandlers(store, client);
  const out = textOf(await h.removeItem({ productId: '1' }));
  assert.deepEqual(out, { ok: false, reason: 'not_in_cart', productId: '1' });
  assert.equal(syncCalled, false);
  assert.deepEqual(store.getItems(), [{ productId: '2', name: 'Bread', price: 8.5, qty: 1 }]);
  store.close();
});

test('clearCart empties locally AND syncs the empty cart to the real account', async () => {
  const store = tempStore();
  store.addItem('1', 'Milk', 6.9, 1);
  let syncedItems: Record<string, string> | undefined;
  const client = fakeClient({ syncCart: async (items: Record<string, string>) => { syncedItems = items; return acceptAll(items, 0); } });
  const h = ramiLevyToolHandlers(store, client);
  const out = textOf(await h.clearCart());
  assert.deepEqual(out, { ok: true, cartTotal: 0, itemCount: 0, serverTotal: 0 });
  assert.deepEqual(store.getItems(), []);
  assert.deepEqual(syncedItems, {});
  store.close();
});

test('clearCart fails, and restores the local cart, when the server still holds items after the empty sync', async () => {
  const store = tempStore();
  store.addItem('1', 'Milk', 6.9, 1);
  const client = fakeClient({ syncCart: async () => ({ ok: true, acceptedIds: ['1'], serverTotal: 6.9 }) });
  const h = ramiLevyToolHandlers(store, client);
  const out = textOf(await h.clearCart()) as { ok: boolean; reason: string; details: string };
  assert.equal(out.ok, false);
  assert.equal(out.reason, 'network_error');
  assert.ok(out.details.startsWith('cart not emptied'), out.details);
  assert.deepEqual(store.getItems(), [{ productId: '1', name: 'Milk', price: 6.9, qty: 1 }]);
  store.close();
});

test('clearCart with a failing sync leaves the local cart unchanged', async () => {
  const store = tempStore();
  store.addItem('1', 'Milk', 6.9, 1);
  const client = fakeClient({ syncCart: async () => ({ ok: false, reason: 'auth_expired', status: 403 }) });
  const h = ramiLevyToolHandlers(store, client);
  const out = textOf(await h.clearCart()) as { ok: boolean; reason: string };
  assert.equal(out.reason, 'auth_expired');
  assert.deepEqual(store.getItems(), [{ productId: '1', name: 'Milk', price: 6.9, qty: 1 }]);
  store.close();
});

test('removeItem with a failing sync leaves the item in the local cart', async () => {
  const store = tempStore();
  store.addItem('1', 'Milk', 6.9, 1);
  const client = fakeClient({ syncCart: async () => ({ ok: false, reason: 'network_error', details: 'ECONNRESET' }) });
  const h = ramiLevyToolHandlers(store, client);
  const out = textOf(await h.removeItem({ productId: '1' })) as { ok: boolean };
  assert.equal(out.ok, false);
  assert.deepEqual(store.getItems(), [{ productId: '1', name: 'Milk', price: 6.9, qty: 1 }]);
  store.close();
});

test('reorderFromHistory increments an existing item rather than replacing the cart', async () => {
  const store = tempStore();
  store.addItem('1', 'Milk', 6.9, 1); // already in cart before reorder runs

  const client = fakeClient({
    getOrderList: async () => ({
      ok: true,
      data: { orders: [{ id: 'o1', created_at: '2026-09-01' }, { id: 'o2', created_at: '2026-09-08' }], currentPage: 1, lastPage: 1, total: 2 },
    }),
    getOrderDetail: async (id: string) => ({
      ok: true,
      data: { id, lines: [{ item_id: '1', name: 'Milk', quantity: '2.00' }] },
    }),
    syncCart: async (items: Record<string, string>) => acceptAll(items, 20.7),
  });
  const h = ramiLevyToolHandlers(store, client);
  const out = textOf(await h.reorderFromHistory({ numOrders: 2, minOccurrences: 2 })) as { ok: boolean; added: unknown[]; serverTotal: number };
  assert.equal(out.ok, true);
  assert.equal(out.added.length, 1);
  assert.equal(out.serverTotal, 20.7);
  const items = store.getItems();
  assert.equal(items.length, 1);
  assert.equal(items[0].qty, 3); // 1 (already there) + 2 (median from history)
  store.close();
});

test('reorderFromHistory prices a newly reordered item from the most recent order line, not 0', async () => {
  const store = tempStore();

  const client = fakeClient({
    getOrderList: async () => ({
      ok: true,
      data: {
        orders: [
          { id: 'o1', created_at: '2026-09-01 10:00:00' },
          { id: 'o2', created_at: '2026-09-08 10:00:00' },
        ],
        currentPage: 1,
        lastPage: 1,
        total: 2,
      },
    }),
    getOrderDetail: async (id: string) => {
      // o2 (2026-09-08) is more recent than o1 (2026-09-01); its price
      // (7.50) must win over o1's stale price (6.90).
      const price = id === 'o2' ? '7.50' : '6.90';
      return { ok: true, data: { id, lines: [{ item_id: '1', name: 'Milk', quantity: '2.00', price }] } };
    },
    syncCart: async (items: Record<string, string>) => acceptAll(items, 15),
  });
  const h = ramiLevyToolHandlers(store, client);
  const out = textOf(await h.reorderFromHistory({ numOrders: 2, minOccurrences: 2 })) as { ok: boolean };
  assert.equal(out.ok, true);
  assert.deepEqual(store.getItems(), [{ productId: '1', name: 'Milk', price: 7.5, qty: 2 }]);
  store.close();
});

test('reorderFromHistory falls back to the existing cart price when no order line has a finite price', async () => {
  const store = tempStore();
  store.addItem('1', 'Milk', 5.25, 1); // already in cart at this price

  const client = fakeClient({
    getOrderList: async () => ({
      ok: true,
      data: { orders: [{ id: 'o1', created_at: '2026-09-01' }, { id: 'o2', created_at: '2026-09-08' }], currentPage: 1, lastPage: 1, total: 2 },
    }),
    getOrderDetail: async (id: string) => ({
      ok: true,
      // No `price` field at all, and a non-numeric one on the other order.
      data: { id, lines: [{ item_id: '1', name: 'Milk', quantity: '2.00', price: id === 'o1' ? 'N/A' : undefined }] },
    }),
    syncCart: async (items: Record<string, string>) => acceptAll(items, 15.75),
  });
  const h = ramiLevyToolHandlers(store, client);
  const out = textOf(await h.reorderFromHistory({ numOrders: 2, minOccurrences: 2 })) as { ok: boolean };
  assert.equal(out.ok, true);
  assert.deepEqual(store.getItems(), [{ productId: '1', name: 'Milk', price: 5.25, qty: 3 }]);
  store.close();
});

test('reorderFromHistory falls back to 0 when there is no order-line price and nothing already in the cart', async () => {
  const store = tempStore();

  const client = fakeClient({
    getOrderList: async () => ({
      ok: true,
      data: { orders: [{ id: 'o1', created_at: '2026-09-01' }, { id: 'o2', created_at: '2026-09-08' }], currentPage: 1, lastPage: 1, total: 2 },
    }),
    getOrderDetail: async (id: string) => ({
      ok: true,
      data: { id, lines: [{ item_id: '1', name: 'Milk', quantity: '2.00' }] },
    }),
    syncCart: async (items: Record<string, string>) => acceptAll(items, 0),
  });
  const h = ramiLevyToolHandlers(store, client);
  const out = textOf(await h.reorderFromHistory({ numOrders: 2, minOccurrences: 2 })) as { ok: boolean };
  assert.equal(out.ok, true);
  assert.deepEqual(store.getItems(), [{ productId: '1', name: 'Milk', price: 0, qty: 2 }]);
  store.close();
});

test('reorderFromHistory handles numeric item_id, quantity, and order id from the real API', async () => {
  const store = tempStore();

  const client = fakeClient({
    getOrderList: async () => ({
      ok: true,
      data: {
        orders: [
          { id: 101, created_at: '2026-09-01 10:00:00' },
          { id: 102, created_at: '2026-09-08 10:00:00' },
        ],
        currentPage: 1,
        lastPage: 1,
        total: 2,
      },
    }),
    getOrderDetail: async (id: number) => ({
      ok: true,
      data: { id, lines: [{ item_id: 456813, name: 'חלב', quantity: 2, price: '6.90' }] },
    }),
    syncCart: async (items: Record<string, string>) => acceptAll(items, 13.8),
  });
  const h = ramiLevyToolHandlers(store, client);
  const out = textOf(await h.reorderFromHistory({ numOrders: 2, minOccurrences: 2 })) as { ok: boolean };
  assert.equal(out.ok, true);
  assert.deepEqual(store.getItems(), [{ productId: '456813', name: 'חלב', price: 6.9, qty: 2 }]);
  store.close();
});

test('reorderFromHistory skips a line whose quantity is not a positive finite number', async () => {
  const store = tempStore();

  const client = fakeClient({
    getOrderList: async () => ({
      ok: true,
      data: { orders: [{ id: 'o1', created_at: '2026-09-01' }, { id: 'o2', created_at: '2026-09-08' }], currentPage: 1, lastPage: 1, total: 2 },
    }),
    getOrderDetail: async (id: string) => ({
      ok: true,
      data: { id, lines: [{ item_id: '1', name: 'Milk', quantity: id === 'o1' ? 'not-a-number' : '0', price: '6.90' }] },
    }),
    syncCart: async () => acceptAll({}, 0),
  });
  const h = ramiLevyToolHandlers(store, client);
  const out = textOf(await h.reorderFromHistory({ numOrders: 2, minOccurrences: 1 })) as { ok: boolean; added: unknown[] };
  assert.equal(out.ok, true);
  assert.deepEqual(out.added, []);
  store.close();
});

test('reorderFromHistory with a failing sync leaves the local cart unchanged', async () => {
  const store = tempStore();
  store.addItem('1', 'Milk', 6.9, 1);
  const client = fakeClient({
    getOrderList: async () => ({
      ok: true,
      data: { orders: [{ id: 'o1', created_at: '2026-09-01' }], currentPage: 1, lastPage: 1, total: 1 },
    }),
    getOrderDetail: async (id: string) => ({
      ok: true,
      data: { id, lines: [{ item_id: '1', name: 'Milk', quantity: '2.00' }, { item_id: '9', name: 'Eggs', quantity: '1.00' }] },
    }),
    syncCart: async () => ({ ok: false, reason: 'blocked_by_cloudflare' }),
  });
  const h = ramiLevyToolHandlers(store, client);
  const out = textOf(await h.reorderFromHistory({ numOrders: 1, minOccurrences: 1 }));
  assert.deepEqual(out, { ok: false, reason: 'blocked_by_cloudflare', cartTotal: 6.9, itemCount: 1, serverTotal: null });
  assert.deepEqual(store.getItems(), [{ productId: '1', name: 'Milk', price: 6.9, qty: 1 }]);
  store.close();
});

test('reorderFromHistory rejects numOrders out of the 1-50 range', async () => {
  const store = tempStore();
  const client = fakeClient();
  const h = ramiLevyToolHandlers(store, client);
  const out = textOf(await h.reorderFromHistory({ numOrders: 100 }));
  assert.equal((out as { ok: boolean }).ok, false);
  store.close();
});

test('checkStatus reports ok when both the search and the order-list probes succeed', async () => {
  const store = tempStore();
  let ordersProbed = false;
  const client = fakeClient({
    searchProducts: async () => ({ ok: true, results: [] }),
    getOrderList: async () => { ordersProbed = true; return { ok: true, data: { orders: [], currentPage: 1, lastPage: 1, total: 0 } }; },
  });
  const h = ramiLevyToolHandlers(store, client);
  const out = textOf(await h.checkStatus());
  assert.deepEqual(out, { ok: true, cartSize: 0 });
  assert.equal(ordersProbed, true);
  store.close();
});

test('checkStatus surfaces an order-list failure even when search succeeds (expired session)', async () => {
  const store = tempStore();
  const client = fakeClient({ getOrderList: async () => ({ ok: false, reason: 'auth_expired', status: 401 }) });
  const h = ramiLevyToolHandlers(store, client);
  const out = textOf(await h.checkStatus());
  assert.deepEqual(out, { ok: false, reason: 'auth_expired', status: 401 });
  store.close();
});

test('checkStatus surfaces the underlying error when the probe fails', async () => {
  const store = tempStore();
  const client = fakeClient({ searchProducts: async () => ({ ok: false, reason: 'blocked_by_cloudflare' }) });
  const h = ramiLevyToolHandlers(store, client);
  const out = textOf(await h.checkStatus());
  assert.deepEqual(out, { ok: false, reason: 'blocked_by_cloudflare' });
  store.close();
});

test('withErrorBoundary turns a thrown error into a structured internal_error result', async () => {
  const throwingHandler = async (_args: { productId: string }) => {
    throw new Error('boom');
  };
  const wrapped = withErrorBoundary(throwingHandler);
  const out = textOf(await wrapped({ productId: '1' }));
  assert.deepEqual(out, { ok: false, reason: 'internal_error', details: 'boom' });
});

// ---- Reset after checkout -------------------------------------------------

const orderList = (orders: { id: string | number; created_at: string }[]) =>
  async () => ({ ok: true as const, data: { orders, currentPage: 1, lastPage: 1, total: orders.length } });

test('a successful sync records last_synced_at as a UTC instant', async () => {
  const store = tempStore();
  const h = ramiLevyToolHandlers(store, fakeClient());
  const t0 = Date.now();
  await h.addItem({ productId: '1', name: 'Milk', price: 6.9 });
  const recorded = store.getLastSyncedAt();
  assert.ok(recorded?.endsWith('Z'), String(recorded));
  const ms = Date.parse(recorded!);
  assert.ok(ms >= t0 - 1000 && ms <= Date.now() + 1000, recorded!);
  store.close();
});

test('a failed sync does not move last_synced_at', async () => {
  const store = tempStore();
  store.setLastSyncedAt('2026-09-01T07:00:00.000Z');
  const h = ramiLevyToolHandlers(store, fakeClient({ syncCart: async () => ({ ok: false, reason: 'blocked_by_cloudflare' }) }));
  await h.addItem({ productId: '1', name: 'Milk', price: 6.9 });
  assert.equal(store.getLastSyncedAt(), '2026-09-01T07:00:00.000Z');
  store.close();
});

test('an order newer than the last sync clears the local cart before the add, and says so', async () => {
  const store = tempStore();
  store.addItem('1', 'Milk', 6.9, 2); // bought in order 555
  store.addItem('2', 'Bread', 8.5, 1);
  store.setLastSyncedAt('2026-09-08T07:00:00.000Z'); // 10:00 Israel (IDT, UTC+3)
  let synced: Record<string, string> | undefined;
  const client = fakeClient({
    // Oldest first on purpose: the newest order is found without relying on API order.
    getOrderList: orderList([
      { id: 500, created_at: '2026-09-01 09:00:00' },
      { id: 555, created_at: '2026-09-08 12:30:00' },
      { id: 554, created_at: '2026-09-08 11:00:00' },
    ]),
    syncCart: async (items: Record<string, string>) => { synced = items; return acceptAll(items, 4.5); },
  });
  const h = ramiLevyToolHandlers(store, client);
  const out = textOf(await h.addItem({ productId: '3', name: 'Eggs', price: 4.5 }));
  assert.deepEqual(out, {
    ok: true,
    resetAfterOrder: { orderId: 555, createdAt: '2026-09-08 12:30:00' },
    cartTotal: 4.5,
    itemCount: 1,
    serverTotal: 4.5,
  });
  assert.deepEqual(synced, { '3': '1.00' }); // the previous order is not resurrected
  assert.deepEqual(store.getItems(), [{ productId: '3', name: 'Eggs', price: 4.5, qty: 1 }]);
  store.close();
});

test('an order older than the last sync leaves the local cart alone', async () => {
  const store = tempStore();
  store.addItem('1', 'Milk', 6.9, 1);
  store.setLastSyncedAt('2026-09-08T07:00:00.000Z'); // 10:00 Israel
  const client = fakeClient({ getOrderList: orderList([{ id: 554, created_at: '2026-09-08 09:59:00' }]) });
  const h = ramiLevyToolHandlers(store, client);
  const out = textOf(await h.addItem({ productId: '3', name: 'Eggs', price: 4.5 })) as Record<string, unknown>;
  assert.equal(out.ok, true);
  assert.equal('resetAfterOrder' in out, false);
  assert.equal(store.size, 2);
  store.close();
});

test('an empty local cart skips the order fetch entirely', async () => {
  const store = tempStore();
  store.setLastSyncedAt('2026-09-08T07:00:00.000Z');
  let fetched = false;
  const client = fakeClient({ getOrderList: async () => { fetched = true; return { ok: false, reason: 'blocked_by_cloudflare' }; } });
  const h = ramiLevyToolHandlers(store, client);
  const out = textOf(await h.addItem({ productId: '1', name: 'Milk', price: 6.9 })) as { ok: boolean };
  assert.equal(out.ok, true);
  assert.equal(fetched, false);
  store.close();
});

test('no recorded sync (a pre-upgrade cart) skips the order fetch', async () => {
  const store = tempStore();
  store.addItem('1', 'Milk', 6.9, 1);
  let fetched = false;
  const client = fakeClient({ getOrderList: async () => { fetched = true; return { ok: false, reason: 'blocked_by_cloudflare' }; } });
  const h = ramiLevyToolHandlers(store, client);
  const out = textOf(await h.addItem({ productId: '2', name: 'Bread', price: 8.5 })) as { ok: boolean };
  assert.equal(out.ok, true);
  assert.equal(fetched, false);
  store.close();
});

test('an order-list failure aborts the mutation: ok:false, no sync, cart untouched', async () => {
  const store = tempStore();
  store.addItem('1', 'Milk', 6.9, 1);
  store.setLastSyncedAt('2026-09-08T07:00:00.000Z');
  let synced = false;
  const client = fakeClient({
    getOrderList: async () => ({ ok: false, reason: 'auth_expired', status: 401 }),
    syncCart: async (items: Record<string, string>) => { synced = true; return acceptAll(items); },
  });
  const h = ramiLevyToolHandlers(store, client);
  for (const call of [
    () => h.addItem({ productId: '2', name: 'Bread', price: 8.5 }),
    () => h.removeItem({ productId: '1' }),
    () => h.clearCart(),
  ]) {
    assert.deepEqual(textOf(await call()), { ok: false, reason: 'auth_expired', status: 401 });
  }
  assert.equal(synced, false);
  assert.deepEqual(store.getItems(), [{ productId: '1', name: 'Milk', price: 6.9, qty: 1 }]);
  assert.equal(store.getLastSyncedAt(), '2026-09-08T07:00:00.000Z');
  store.close();
});

test('an unparseable created_at aborts the mutation rather than skipping the check', async () => {
  const store = tempStore();
  store.addItem('1', 'Milk', 6.9, 1);
  store.setLastSyncedAt('2026-09-08T07:00:00.000Z');
  let synced = false;
  const client = fakeClient({
    getOrderList: orderList([{ id: 9, created_at: 'yesterday' }]),
    syncCart: async (items: Record<string, string>) => { synced = true; return acceptAll(items); },
  });
  const h = ramiLevyToolHandlers(store, client);
  const out = textOf(await h.addItem({ productId: '2', name: 'Bread', price: 8.5 })) as { ok: boolean; reason: string };
  assert.equal(out.ok, false);
  assert.equal(out.reason, 'network_error');
  assert.equal(synced, false);
  assert.equal(store.size, 1);
  store.close();
});

test('a reset whose sync then fails restores the pre-reset cart (ok:false means nothing changed)', async () => {
  const store = tempStore();
  store.addItem('1', 'Milk', 6.9, 1);
  store.setLastSyncedAt('2026-09-08T07:00:00.000Z');
  const client = fakeClient({
    getOrderList: orderList([{ id: 555, created_at: '2026-09-08 12:30:00' }]),
    syncCart: async () => ({ ok: false, reason: 'network_error', details: 'ECONNRESET' }),
  });
  const h = ramiLevyToolHandlers(store, client);
  const out = textOf(await h.addItem({ productId: '3', name: 'Eggs', price: 4.5 })) as { ok: boolean };
  assert.equal(out.ok, false);
  assert.deepEqual(store.getItems(), [{ productId: '1', name: 'Milk', price: 6.9, qty: 1 }]);
  store.close();
});

test('clearCart and reorderFromHistory also reset after a checkout', async () => {
  const newer = orderList([{ id: 555, created_at: '2026-09-08 12:30:00' }]);

  const s1 = tempStore();
  s1.addItem('1', 'Milk', 6.9, 1);
  s1.setLastSyncedAt('2026-09-08T07:00:00.000Z');
  const cleared = textOf(await ramiLevyToolHandlers(s1, fakeClient({ getOrderList: newer })).clearCart()) as Record<string, unknown>;
  assert.equal(cleared.ok, true);
  assert.deepEqual(cleared.resetAfterOrder, { orderId: 555, createdAt: '2026-09-08 12:30:00' });
  s1.close();

  const s2 = tempStore();
  s2.addItem('1', 'Milk', 6.9, 1); // bought in 555 — must not be carried into the reorder
  s2.setLastSyncedAt('2026-09-08T07:00:00.000Z');
  const client = fakeClient({
    getOrderList: newer,
    getOrderDetail: async (id: number) => ({ ok: true, data: { id, lines: [{ item_id: '2', name: 'Bread', quantity: 1, price: '8.50' }] } }),
  });
  const out = textOf(await ramiLevyToolHandlers(s2, client).reorderFromHistory({ numOrders: 1, minOccurrences: 1 })) as Record<string, unknown>;
  assert.equal(out.ok, true);
  assert.deepEqual(out.resetAfterOrder, { orderId: 555, createdAt: '2026-09-08 12:30:00' });
  assert.deepEqual(s2.getItems(), [{ productId: '2', name: 'Bread', price: 8.5, qty: 1 }]);
  s2.close();
});

// Israel is UTC+2 in winter and UTC+3 in summer. Each case is chosen so that
// the wrong fixed offset would get the answer backwards.
test('checkout detection uses Israel winter time (UTC+2) for a January order', async () => {
  const store = tempStore();
  store.addItem('1', 'Milk', 6.9, 1);
  store.setLastSyncedAt('2026-01-15T08:30:00.000Z'); // 10:30 Israel (IST)
  // 11:15 IST = 09:15Z, after the sync. A fixed +03:00 would read 08:15Z: before it.
  const client = fakeClient({ getOrderList: orderList([{ id: 1, created_at: '2026-01-15 11:15:00' }]) });
  const out = textOf(await ramiLevyToolHandlers(store, client).addItem({ productId: '2', name: 'Bread', price: 8.5 })) as Record<string, unknown>;
  assert.deepEqual(out.resetAfterOrder, { orderId: 1, createdAt: '2026-01-15 11:15:00' });
  assert.deepEqual(store.getItems().map((i) => i.productId), ['2']);
  store.close();
});

test('checkout detection uses Israel summer time (UTC+3) for a July order', async () => {
  const store = tempStore();
  store.addItem('1', 'Milk', 6.9, 1);
  store.setLastSyncedAt('2026-07-15T08:30:00.000Z'); // 11:30 Israel (IDT)
  // 11:15 IDT = 08:15Z, before the sync. A fixed +02:00 would read 09:15Z: after it.
  const client = fakeClient({ getOrderList: orderList([{ id: 1, created_at: '2026-07-15 11:15:00' }]) });
  const out = textOf(await ramiLevyToolHandlers(store, client).addItem({ productId: '2', name: 'Bread', price: 8.5 })) as Record<string, unknown>;
  assert.equal(out.ok, true);
  assert.equal('resetAfterOrder' in out, false);
  assert.deepEqual(store.getItems().map((i) => i.productId), ['1', '2']);
  store.close();
});

// --- listOrders / viewOrder: read-only windows onto the purchase history ---

test('listOrders maps a page of summaries and its pagination', async () => {
  const store = tempStore();
  const client = fakeClient({
    getOrderList: async (page: number) => ({
      ok: true,
      data: {
        orders: [
          { id: 9197912, created_at: '2026-09-08T05:59:37.000000Z', supply_at: '2026-09-09 12:00:00', status_api: 'done', final_price: 1313.13 },
        ],
        currentPage: page,
        lastPage: 24,
        total: 140,
      },
    }),
  });
  const h = ramiLevyToolHandlers(store, client);
  const out = textOf(await h.listOrders({ page: 3 }));
  assert.deepEqual(out, {
    ok: true,
    page: 3,
    lastPage: 24,
    totalOrders: 140,
    orders: [{ orderId: 9197912, createdAt: '2026-09-08T05:59:37.000000Z', supplyAt: '2026-09-09 12:00:00', status: 'done', total: 1313.13 }],
  });
  store.close();
});

test('listOrders defaults to page 1 and asks the client for it', async () => {
  const store = tempStore();
  let askedFor: number | undefined;
  const client = fakeClient({
    getOrderList: async (page: number) => {
      askedFor = page;
      return { ok: true, data: { orders: [], currentPage: page, lastPage: 1, total: 0 } };
    },
  });
  const h = ramiLevyToolHandlers(store, client);
  const out = textOf(await h.listOrders({}));
  assert.equal(askedFor, 1);
  assert.equal(out.ok, true);
  assert.deepEqual(out.orders, []);
  store.close();
});

test('listOrders rejects a page below 1 without calling the client', async () => {
  const store = tempStore();
  let called = false;
  const client = fakeClient({
    getOrderList: async () => { called = true; return { ok: true, data: { orders: [], currentPage: 1, lastPage: 1, total: 0 } }; },
  });
  const h = ramiLevyToolHandlers(store, client);
  const out = textOf(await h.listOrders({ page: 0 }));
  assert.equal(called, false);
  assert.equal(out.ok, false);
  assert.equal(out.reason, 'invalid_args');
  store.close();
});

test('listOrders passes a client failure straight through', async () => {
  const store = tempStore();
  const client = fakeClient({ getOrderList: async () => ({ ok: false, reason: 'auth_expired', status: 401 }) });
  const h = ramiLevyToolHandlers(store, client);
  const out = textOf(await h.listOrders({}));
  assert.deepEqual(out, { ok: false, reason: 'auth_expired', status: 401 });
  store.close();
});

test('listOrders fills missing optional summary fields with null', async () => {
  const store = tempStore();
  const client = fakeClient({
    getOrderList: async () => ({ ok: true, data: { orders: [{ id: 'o1', created_at: '2026-09-01' }], currentPage: 1, lastPage: 1, total: 1 } }),
  });
  const h = ramiLevyToolHandlers(store, client);
  const out = textOf(await h.listOrders({}));
  assert.deepEqual(out.orders, [{ orderId: 'o1', createdAt: '2026-09-01', supplyAt: null, status: null, total: null }]);
  store.close();
});

test('viewOrder returns the order lines with numeric price and qty', async () => {
  const store = tempStore();
  const client = fakeClient({
    getOrderDetail: async (orderId: string | number) => ({
      ok: true,
      data: {
        id: String(orderId),
        created_at: '2026-09-08T05:59:37.000000Z',
        supply_at: '2026-09-09 12:00:00',
        status_api: 'done',
        final_price: 1313.13,
        delivery_price: '35.9',
        lines: [
          { id: 1, item_id: 2, name: 'עגבניה', price: '4.9', quantity: 2, total_price: '9.8' },
        ],
      },
    }),
  });
  const h = ramiLevyToolHandlers(store, client);
  const out = textOf(await h.viewOrder({ orderId: '9197912' }));
  assert.deepEqual(out, {
    ok: true,
    orderId: '9197912',
    createdAt: '2026-09-08T05:59:37.000000Z',
    supplyAt: '2026-09-09 12:00:00',
    status: 'done',
    total: 1313.13,
    deliveryPrice: 35.9,
    lineCount: 1,
    lines: [{ productId: '2', name: 'עגבניה', price: 4.9, qty: 2, lineTotal: 9.8 }],
  });
  store.close();
});

test('viewOrder nulls a line price that the old order data lacks', async () => {
  const store = tempStore();
  const client = fakeClient({
    getOrderDetail: async () => ({ ok: true, data: { id: 'o1', lines: [{ id: 1, item_id: 7, name: 'Old item', quantity: 1 }] } }),
  });
  const h = ramiLevyToolHandlers(store, client);
  const out = textOf(await h.viewOrder({ orderId: 'o1' }));
  assert.deepEqual(out.lines, [{ productId: '7', name: 'Old item', price: null, qty: 1, lineTotal: null }]);
  assert.equal(out.total, null);
  store.close();
});

test('viewOrder passes a client failure straight through', async () => {
  const store = tempStore();
  const client = fakeClient({ getOrderDetail: async () => ({ ok: false, reason: 'blocked_by_cloudflare' }) });
  const h = ramiLevyToolHandlers(store, client);
  const out = textOf(await h.viewOrder({ orderId: 'o1' }));
  assert.deepEqual(out, { ok: false, reason: 'blocked_by_cloudflare' });
  store.close();
});

// --- suggestReorder: the reorder selection, without touching the cart ---

// Two orders: milk in both, bread in one only.
function historyClient(overrides: Partial<RamiLevyClient> = {}): RamiLevyClient {
  return fakeClient({
    getOrderList: async () => ({
      ok: true,
      data: {
        orders: [
          { id: 'o2', created_at: '2026-09-08T05:00:00.000000Z' },
          { id: 'o1', created_at: '2026-09-01T05:00:00.000000Z' },
        ],
        currentPage: 1,
        lastPage: 1,
        total: 2,
      },
    }),
    getOrderDetail: async (orderId: string | number) => ({
      ok: true,
      data: orderId === 'o2'
        ? { id: 'o2', lines: [{ item_id: 1, name: 'Milk', price: '7.1', quantity: 2 }, { item_id: 2, name: 'Bread', price: '8.3', quantity: 1 }] }
        : { id: 'o1', lines: [{ item_id: 1, name: 'Milk', price: '6.9', quantity: 4 }] },
    }),
    ...overrides,
  });
}

test('suggestReorder reports each candidate with its occurrences, median qty and last price paid', async () => {
  const store = tempStore();
  const h = ramiLevyToolHandlers(store, historyClient());
  const out = textOf(await h.suggestReorder({ numOrders: 2, minOccurrences: 2 }));
  assert.deepEqual(out, {
    ok: true,
    ordersConsidered: 2,
    minOccurrences: 2,
    candidates: [{ productId: '1', name: 'Milk', qty: 4, lastPrice: 7.1, occurrences: 2 }],
  });
  store.close();
});

test('suggestReorder never syncs and never changes the cart', async () => {
  const store = tempStore();
  store.addItem('9', 'Pre-existing', 1, 1);
  let synced = false;
  const h = ramiLevyToolHandlers(store, historyClient({ syncCart: async (items: Record<string, string>) => { synced = true; return acceptAll(items); } }));
  await h.suggestReorder({ numOrders: 2, minOccurrences: 1 });
  assert.equal(synced, false);
  assert.deepEqual(store.getItems().map((i) => i.productId), ['9']);
  store.close();
});

test('suggestReorder includes a one-off item once minOccurrences drops to 1', async () => {
  const store = tempStore();
  const h = ramiLevyToolHandlers(store, historyClient());
  const out = textOf(await h.suggestReorder({ numOrders: 2, minOccurrences: 1 }));
  assert.deepEqual(out.candidates.map((c: { productId: string; occurrences: number }) => [c.productId, c.occurrences]), [['1', 2], ['2', 1]]);
  store.close();
});

test('suggestReorder says so when nothing clears the threshold', async () => {
  const store = tempStore();
  const h = ramiLevyToolHandlers(store, historyClient());
  const out = textOf(await h.suggestReorder({ numOrders: 2, minOccurrences: 2 }));
  const empty = textOf(await ramiLevyToolHandlers(tempStore(), fakeClient()).suggestReorder({ numOrders: 1, minOccurrences: 1 }));
  assert.equal(out.ok, true);
  assert.deepEqual(empty.candidates, []);
  assert.match(empty.message, /No items appear/);
  store.close();
});

test('suggestReorder validates its bounds without calling the client', async () => {
  const store = tempStore();
  let called = false;
  const client = historyClient({ getOrderList: async () => { called = true; return { ok: true, data: { orders: [], currentPage: 1, lastPage: 1, total: 0 } }; } });
  const h = ramiLevyToolHandlers(store, client);
  const tooMany = textOf(await h.suggestReorder({ numOrders: 51 }));
  const impossible = textOf(await h.suggestReorder({ numOrders: 3, minOccurrences: 4 }));
  assert.equal(called, false);
  assert.equal(tooMany.reason, 'invalid_args');
  assert.equal(impossible.reason, 'invalid_args');
  store.close();
});

test('suggestReorder passes a client failure straight through', async () => {
  const store = tempStore();
  const h = ramiLevyToolHandlers(store, historyClient({ getOrderDetail: async () => ({ ok: false, reason: 'auth_expired', status: 401 }) }));
  const out = textOf(await h.suggestReorder({ numOrders: 2, minOccurrences: 1 }));
  assert.deepEqual(out, { ok: false, reason: 'auth_expired', status: 401 });
  store.close();
});

test('suggestReorder and reorderFromHistory select the same products', async () => {
  const store = tempStore();
  const h = ramiLevyToolHandlers(store, historyClient());
  const suggested = textOf(await h.suggestReorder({ numOrders: 2, minOccurrences: 2 }));
  const applied = textOf(await h.reorderFromHistory({ numOrders: 2, minOccurrences: 2 }));
  assert.deepEqual(
    suggested.candidates.map((c: { productId: string; qty: number }) => [c.productId, c.qty]),
    applied.added.map((a: { productId: string; qty: number }) => [a.productId, a.qty]),
  );
  store.close();
});

// --- money rounding: the API's own floats are not shown raw ---

test('listOrders rounds a float-artifact total to agorot', async () => {
  const store = tempStore();
  const client = fakeClient({
    getOrderList: async () => ({ ok: true, data: { orders: [{ id: 'o1', created_at: '2020-12-21', final_price: 442.22999999999996 }], currentPage: 1, lastPage: 1, total: 1 } }),
  });
  const out = textOf(await ramiLevyToolHandlers(store, client).listOrders({}));
  assert.equal(out.orders[0].total, 442.23);
  store.close();
});

test('viewOrder rounds money but leaves a weight-based qty alone', async () => {
  const store = tempStore();
  const client = fakeClient({
    getOrderDetail: async () => ({
      ok: true,
      data: { id: 'o1', final_price: 10.000000000000002, lines: [{ item_id: 4, name: 'גזר ארוז', price: '2.9', quantity: 1.234, total_price: 3.5779999999999994 }] },
    }),
  });
  const out = textOf(await ramiLevyToolHandlers(store, client).viewOrder({ orderId: 'o1' }));
  assert.equal(out.total, 10);
  assert.deepEqual(out.lines, [{ productId: '4', name: 'גזר ארוז', price: 2.9, qty: 1.234, lineTotal: 3.58 }]);
  store.close();
});
