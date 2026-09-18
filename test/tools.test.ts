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
    checkoutUrl: 'https://www.rami-levy.co.il/he/dashboard/checkout',
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
