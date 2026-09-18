import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { RamiLevyClient } from '../src/client.js';

const CONFIG = {
  bearerToken: 'test-bearer',
  ecomToken: 'test-ecom',
  cookie: 'test-cookie',
  userAgent: 'test-agent',
  store: '412',
};

function fakeResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  const isJson = typeof body !== 'string';
  return new Response(isJson ? JSON.stringify(body) : (body as string), {
    status,
    headers: { 'content-type': isJson ? 'application/json' : 'text/html', ...headers },
  });
}

type Captured = { url: string; init: RequestInit };

// Mocks fetch to return `response` and records every call's (url, init).
function captureFetch(t: { mock: { method: Function } }, response: () => Response): Captured[] {
  const calls: Captured[] = [];
  t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return response();
  });
  return calls;
}

function assertAuthHeaders(init: RequestInit): void {
  const h = init.headers as Record<string, string>;
  assert.equal(h.authorization, 'Bearer test-bearer');
  assert.equal(h.ecomtoken, 'test-ecom');
  assert.equal(h.cookie, 'test-cookie');
  assert.equal(h['user-agent'], 'test-agent');
}

test('searchProducts POSTs {q, store} as JSON to /api/catalog with the full auth bundle', async (t) => {
  const calls = captureFetch(t, () => fakeResponse(200, { q: 'milk', data: [] }));
  const client = new RamiLevyClient(CONFIG);
  const result = await client.searchProducts('milk');
  assert.equal(result.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://www.rami-levy.co.il/api/catalog');
  assert.equal(calls[0].init.method, 'POST');
  assertAuthHeaders(calls[0].init);
  assert.equal((calls[0].init.headers as Record<string, string>)['content-type'], 'application/json;charset=UTF-8');
  assert.deepEqual(JSON.parse(calls[0].init.body as string), { q: 'milk', store: '412' });
});

test('a search response echoing q:null alongside real product data is network_error, not ok', async (t) => {
  t.mock.method(globalThis, 'fetch', async () =>
    fakeResponse(200, { q: null, data: [{ id: 1, name: 'Unrelated default listing', price: 3 }] }),
  );
  const client = new RamiLevyClient(CONFIG);
  const result = await client.searchProducts('milk');
  assert.deepEqual(result, {
    ok: false,
    reason: 'network_error',
    details: 'search query not applied (response q=null) — likely a request wire-format mismatch',
  });
});

test('a search response echoing a different q is network_error', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => fakeResponse(200, { q: 'bread', data: [{ id: 1, name: 'Bread', price: 3 }] }));
  const client = new RamiLevyClient(CONFIG);
  const result = await client.searchProducts('milk');
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.ok('details' in result && result.details.startsWith('search query not applied (response q="bread")'), JSON.stringify(result));
});

test('a search response echoing the sent q (modulo surrounding whitespace) is ok', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => fakeResponse(200, { q: 'milk ', data: [{ id: 1, name: 'Milk', price: 6.9 }] }));
  const client = new RamiLevyClient(CONFIG);
  const result = await client.searchProducts(' milk');
  assert.deepEqual(result, { ok: true, results: [{ productId: '1', name: 'Milk', price: 6.9 }] });
});

test('searchProducts drops rows with neither id nor barcode instead of emitting productId "undefined"', async (t) => {
  t.mock.method(globalThis, 'fetch', async () =>
    fakeResponse(200, { data: [{ name: 'No id', price: 1 }, { id: 7, name: 'Has id', price: 2 }, { barcode: 8, name: 'Has barcode', price: 3 }] }),
  );
  const client = new RamiLevyClient(CONFIG);
  const result = await client.searchProducts('x', 2);
  assert.deepEqual(result, {
    ok: true,
    results: [
      { productId: '7', name: 'Has id', price: 2 },
      { productId: '8', name: 'Has barcode', price: 3 },
    ],
  });
});

test('searchProducts maps the real API shape into SearchResult[]', async (t) => {
  t.mock.method(globalThis, 'fetch', async () =>
    fakeResponse(200, {
      data: [
        { id: 456813, name: 'חלב 3%', price: { price: 6.9 } },
        { barcode: 789, product_name: 'Fallback Name', price: 4.5 },
      ],
    }),
  );
  const client = new RamiLevyClient(CONFIG);
  const result = await client.searchProducts('חלב', 5);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.results, [
    { productId: '456813', name: 'חלב 3%', price: 6.9 },
    { productId: '789', name: 'Fallback Name', price: 4.5 },
  ]);
});

test('an unexpected search response shape (non-array data) is classified as network_error, not thrown', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => fakeResponse(200, { data: { foo: 1 } }));
  const client = new RamiLevyClient(CONFIG);
  const result = await client.searchProducts('milk');
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, 'network_error');
  assert.ok('details' in result && result.details.startsWith('Unexpected search shape'), `unexpected details: ${JSON.stringify(result)}`);
});

test('a search response with no data key at all is classified as network_error, not "no results found"', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => fakeResponse(200, { q: null }));
  const client = new RamiLevyClient(CONFIG);
  const result = await client.searchProducts('milk');
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, 'network_error');
  assert.ok('details' in result && result.details.startsWith('Unexpected search shape'), `unexpected details: ${JSON.stringify(result)}`);
});

test('a JSON 401/403 response is classified as auth_expired', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => fakeResponse(401, { error: 'unauthenticated' }));
  const client = new RamiLevyClient(CONFIG);
  const result = await client.searchProducts('milk');
  assert.deepEqual(result, { ok: false, reason: 'auth_expired', status: 401 });
});

test('an HTML 403 (Cloudflare challenge page) is classified as blocked_by_cloudflare, not auth_expired', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => fakeResponse(403, '<html>Just a moment...</html>'));
  const client = new RamiLevyClient(CONFIG);
  const result = await client.searchProducts('milk');
  assert.deepEqual(result, { ok: false, reason: 'blocked_by_cloudflare' });
});

test('a cf-mitigated header is classified as blocked_by_cloudflare even on a 200', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => fakeResponse(200, { data: [] }, { 'cf-mitigated': 'challenge' }));
  const client = new RamiLevyClient(CONFIG);
  const result = await client.searchProducts('milk');
  assert.deepEqual(result, { ok: false, reason: 'blocked_by_cloudflare' });
});

test('an HTML 200 without cf-mitigated is classified as blocked_by_cloudflare', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => fakeResponse(200, '<html>Just a moment...</html>'));
  const client = new RamiLevyClient(CONFIG);
  const result = await client.searchProducts('milk');
  assert.deepEqual(result, { ok: false, reason: 'blocked_by_cloudflare' });
});

test('a malformed JSON body is classified as network_error, not thrown', async (t) => {
  t.mock.method(globalThis, 'fetch', async () =>
    new Response('{not json', { status: 200, headers: { 'content-type': 'application/json' } }),
  );
  const client = new RamiLevyClient(CONFIG);
  const result = await client.searchProducts('milk');
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, 'network_error');
  assert.ok('details' in result && result.details.startsWith('invalid JSON response'), `unexpected details: ${JSON.stringify(result)}`);
});

test('fetch throwing (network down) is classified as network_error', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => {
    throw new Error('ECONNREFUSED');
  });
  const client = new RamiLevyClient(CONFIG);
  const result = await client.searchProducts('milk');
  assert.deepEqual(result, { ok: false, reason: 'network_error', details: 'ECONNREFUSED' });
});

test('syncCart POSTs the full item map to /api/v2/cart and returns the accepted ids and server total', async (t) => {
  const calls = captureFetch(t, () => fakeResponse(200, { items: [{ id: 1, quantity: '2.00' }, { id: '2', quantity: '1.00' }], price: 21.4 }));
  const client = new RamiLevyClient(CONFIG);
  const result = await client.syncCart({ '1': '2.00', '2': '1.00' });
  assert.deepEqual(result, { ok: true, acceptedIds: ['1', '2'], serverTotal: 21.4 });
  assert.equal(calls[0].url, 'https://www.rami-levy.co.il/api/v2/cart');
  assert.equal(calls[0].init.method, 'POST');
  assertAuthHeaders(calls[0].init);
  const sent = JSON.parse(calls[0].init.body as string);
  assert.deepEqual(sent.items, { '1': '2.00', '2': '1.00' });
  assert.equal(sent.store, '412');
  assert.equal(sent.isClub, 0);
  assert.equal(sent.meta, null);
});

test('syncCart reports only what the server kept, so the caller can see a rejection', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => fakeResponse(200, { items: [{ item_id: 1 }], price: '13.80' }));
  const client = new RamiLevyClient(CONFIG);
  const result = await client.syncCart({ '1': '2.00', '2': '1.00' });
  assert.deepEqual(result, { ok: true, acceptedIds: ['1'], serverTotal: 13.8 });
});

test('syncCart of an empty cart accepts an empty items array', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => fakeResponse(200, { items: [], price: 0 }));
  const client = new RamiLevyClient(CONFIG);
  const result = await client.syncCart({});
  assert.deepEqual(result, { ok: true, acceptedIds: [], serverTotal: 0 });
});

test('syncCart with no price in the response reports serverTotal null, not 0', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => fakeResponse(200, { items: [{ id: 1 }] }));
  const client = new RamiLevyClient(CONFIG);
  const result = await client.syncCart({ '1': '1.00' });
  assert.deepEqual(result, { ok: true, acceptedIds: ['1'], serverTotal: null });
});

test('an unrecognized cart response shape is network_error, not ok', async (t) => {
  for (const body of [{ success: true }, { data: { items: [] } }, { items: [{ name: 'no id field' }] }, { items: { 1: '2.00' } }]) {
    t.mock.method(globalThis, 'fetch', async () => fakeResponse(200, body));
    const client = new RamiLevyClient(CONFIG);
    const result = await client.syncCart({ '1': '2.00' });
    assert.equal(result.ok, false, JSON.stringify(body));
    if (result.ok) return;
    assert.equal(result.reason, 'network_error');
    assert.ok('details' in result && result.details.startsWith('Unexpected cart response shape'), JSON.stringify(result));
  }
});

test('getOrderList parses the doubly-nested paginator shape', async (t) => {
  const calls = captureFetch(t, () =>
    fakeResponse(200, {
      data: {
        data: {
          current_page: 1,
          last_page: 3,
          total: 25,
          data: [{ id: 'o1', created_at: '2026-09-01' }],
        },
      },
    }),
  );
  const client = new RamiLevyClient(CONFIG);
  const result = await client.getOrderList(2);
  assert.equal(calls[0].url, 'https://www-api.rami-levy.co.il/api/v3/site/orders?page=2&activeFilter=0');
  assert.equal(calls[0].init.method, 'GET');
  assertAuthHeaders(calls[0].init);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.data, {
    orders: [{ id: 'o1', created_at: '2026-09-01' }],
    currentPage: 1,
    lastPage: 3,
    total: 25,
  });
});

test('getOrderDetail parses the singly-nested order shape', async (t) => {
  const calls = captureFetch(t, () =>
    fakeResponse(200, {
      data: { id: 'o1', lines: [{ item_id: 456813, name: 'חלב', quantity: '2.00' }] },
    }),
  );
  const client = new RamiLevyClient(CONFIG);
  const result = await client.getOrderDetail('o1');
  assert.equal(calls[0].url, 'https://www-api.rami-levy.co.il/api/v3/site/orders/o1');
  assert.equal(calls[0].init.method, 'GET');
  assertAuthHeaders(calls[0].init);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.data, { id: 'o1', lines: [{ item_id: 456813, name: 'חלב', quantity: '2.00' }] });
});

test('getOrderDetail URL-encodes the order id', async (t) => {
  const calls = captureFetch(t, () => fakeResponse(200, { data: { id: 'a/b c', lines: [] } }));
  const client = new RamiLevyClient(CONFIG);
  await client.getOrderDetail('a/b c');
  assert.equal(calls[0].url, 'https://www-api.rami-levy.co.il/api/v3/site/orders/a%2Fb%20c');
});

test('getOrderDetail accepts a numeric order id (the real API returns OrderSummary.id as a number)', async (t) => {
  const calls = captureFetch(t, () =>
    fakeResponse(200, { data: { id: 12345, lines: [{ item_id: 1, name: 'Milk', quantity: 2, price: '6.90' }] } }),
  );
  const client = new RamiLevyClient(CONFIG);
  const result = await client.getOrderDetail(12345);
  assert.equal(calls[0].url, 'https://www-api.rami-levy.co.il/api/v3/site/orders/12345');
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.data, { id: 12345, lines: [{ item_id: 1, name: 'Milk', quantity: 2, price: '6.90' }] });
});

test('getOrderList parses a numeric OrderSummary.id and a numeric OrderLine.quantity', async (t) => {
  captureFetch(t, () =>
    fakeResponse(200, {
      data: { data: { current_page: 1, last_page: 1, total: 1, data: [{ id: 999, created_at: '2026-09-08 10:00:00' }] } },
    }),
  );
  const client = new RamiLevyClient(CONFIG);
  const result = await client.getOrderList(1);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.data.orders, [{ id: 999, created_at: '2026-09-08 10:00:00' }]);
});
