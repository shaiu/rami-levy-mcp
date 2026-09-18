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

test('syncCart posts the full item map and reports ok on success', async (t) => {
  let capturedBody = '';
  t.mock.method(globalThis, 'fetch', async (_url: string, init: RequestInit) => {
    capturedBody = init.body as string;
    return fakeResponse(200, { success: true });
  });
  const client = new RamiLevyClient(CONFIG);
  const result = await client.syncCart({ '1': '2.00', '2': '1.00' });
  assert.equal(result.ok, true);
  const sent = JSON.parse(capturedBody);
  assert.deepEqual(sent.items, { '1': '2.00', '2': '1.00' });
  assert.equal(sent.store, '412');
});

test('getOrderList parses the doubly-nested paginator shape', async (t) => {
  t.mock.method(globalThis, 'fetch', async () =>
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
  const result = await client.getOrderList(1);
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
  t.mock.method(globalThis, 'fetch', async () =>
    fakeResponse(200, {
      data: { id: 'o1', lines: [{ item_id: 456813, name: 'חלב', quantity: '2.00' }] },
    }),
  );
  const client = new RamiLevyClient(CONFIG);
  const result = await client.getOrderDetail('o1');
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.data, { id: 'o1', lines: [{ item_id: 456813, name: 'חלב', quantity: '2.00' }] });
});
