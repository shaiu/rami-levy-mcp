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

function fakeClient(overrides: Partial<RamiLevyClient> = {}): RamiLevyClient {
  return {
    searchProducts: async () => ({ ok: true, results: [] }),
    syncCart: async () => ({ ok: true }),
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
      return { ok: true };
    },
  });
  const h = ramiLevyToolHandlers(store, client);
  const out = textOf(await h.addItem({ productId: '1', name: 'Milk', price: 6.9, qty: 2 })) as { ok: boolean; cartTotal: number; itemCount: number };
  assert.equal(out.ok, true);
  assert.equal(out.cartTotal, 13.8);
  assert.equal(out.itemCount, 1);
  assert.deepEqual(syncedItems, { '1': '2.00' });
  store.close();
});

test('addItem surfaces a sync failure instead of hiding it', async () => {
  const store = tempStore();
  const client = fakeClient({ syncCart: async () => ({ ok: false, reason: 'auth_expired', status: 401 }) });
  const h = ramiLevyToolHandlers(store, client);
  const out = textOf(await h.addItem({ productId: '1', name: 'Milk', price: 6.9, qty: 1 }));
  assert.deepEqual(out, { ok: false, reason: 'auth_expired', status: 401, cartTotal: 6.9, itemCount: 1 });
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
  const client = fakeClient({ syncCart: async (items: Record<string, string>) => { syncedItems = items; return { ok: true }; } });
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
  const client = fakeClient({ syncCart: async () => { syncCalled = true; return { ok: true }; } });
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
  const client = fakeClient({ syncCart: async (items: Record<string, string>) => { syncedItems = items; return { ok: true }; } });
  const h = ramiLevyToolHandlers(store, client);
  await h.clearCart();
  assert.deepEqual(store.getItems(), []);
  assert.deepEqual(syncedItems, {});
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
    syncCart: async () => ({ ok: true }),
  });
  const h = ramiLevyToolHandlers(store, client);
  const out = textOf(await h.reorderFromHistory({ numOrders: 2, minOccurrences: 2 })) as { ok: boolean; added: unknown[] };
  assert.equal(out.ok, true);
  assert.equal(out.added.length, 1);
  const items = store.getItems();
  assert.equal(items.length, 1);
  assert.equal(items[0].qty, 3); // 1 (already there) + 2 (median from history)
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

test('checkStatus reports ok when the probe search succeeds', async () => {
  const store = tempStore();
  const client = fakeClient({ searchProducts: async () => ({ ok: true, results: [] }) });
  const h = ramiLevyToolHandlers(store, client);
  const out = textOf(await h.checkStatus()) as { ok: boolean; cartSize: number };
  assert.equal(out.ok, true);
  assert.equal(out.cartSize, 0);
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
