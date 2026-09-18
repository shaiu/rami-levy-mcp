export interface RamiLevyConfig {
  bearerToken: string;
  ecomToken: string;
  cookie: string;
  userAgent: string;
  store: string;
}

export interface SearchResult {
  productId: string;
  name: string;
  price: number;
}

export interface OrderSummary {
  id: string;
  created_at: string;
}

export interface OrderListResult {
  orders: OrderSummary[];
  currentPage: number;
  lastPage: number;
  total: number;
}

export interface OrderLine {
  item_id: string | number;
  name: string;
  quantity: string;
}

export interface OrderDetail {
  id: string;
  lines: OrderLine[];
}

export type ClientError =
  | { ok: false; reason: 'auth_expired'; status: number }
  | { ok: false; reason: 'blocked_by_cloudflare' }
  | { ok: false; reason: 'network_error'; details: string };

export type ClientResult<T> = ({ ok: true } & T) | ClientError;

const SEARCH_URL = 'https://www.rami-levy.co.il/api/catalog';
const CART_URL = 'https://www.rami-levy.co.il/api/v2/cart';
const ORDERS_URL = 'https://www-api.rami-levy.co.il/api/v3/site/orders';

export class RamiLevyClient {
  constructor(private config: RamiLevyConfig) {}

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return {
      accept: 'application/json, text/plain, */*',
      locale: 'he',
      origin: 'https://www.rami-levy.co.il',
      referer: 'https://www.rami-levy.co.il/',
      ecomtoken: this.config.ecomToken,
      cookie: this.config.cookie,
      'user-agent': this.config.userAgent,
      authorization: `Bearer ${this.config.bearerToken}`,
      ...extra,
    };
  }

  private async request<T>(url: string, init: RequestInit): Promise<ClientResult<T>> {
    let res: Response;
    try {
      res = await fetch(url, init);
    } catch (err) {
      return { ok: false, reason: 'network_error', details: (err as Error).message };
    }

    // Order matters here (controller ruling): a Cloudflare-mitigated response,
    // or any non-JSON body at any status, is a Cloudflare block — not an auth
    // failure and not a generic network error — because a challenge page can
    // come back with a 200 (no cf-mitigated header) just as easily as a 403.
    // Only once the body is known to be JSON do we look at 401/403 vs. other
    // non-2xx statuses, and only then do we risk `res.json()`, inside a
    // try/catch so a malformed body never throws across this boundary.
    if (res.headers.get('cf-mitigated')) {
      return { ok: false, reason: 'blocked_by_cloudflare' };
    }

    const contentType = res.headers.get('content-type') || '';
    if (!contentType.includes('json')) {
      return { ok: false, reason: 'blocked_by_cloudflare' };
    }

    if (res.status === 401 || res.status === 403) {
      return { ok: false, reason: 'auth_expired', status: res.status };
    }

    if (!res.ok) {
      return { ok: false, reason: 'network_error', details: `HTTP ${res.status}` };
    }

    let data: T;
    try {
      data = (await res.json()) as T;
    } catch (err) {
      return { ok: false, reason: 'network_error', details: `invalid JSON response: ${(err as Error).message}` };
    }

    // `ok` last: nothing in `data` can shadow it, even if the real API ever
    // returns a field literally named `ok`.
    return { ...data, ok: true };
  }

  async searchProducts(query: string, limit = 5): Promise<ClientResult<{ results: SearchResult[] }>> {
    const result = await this.request<{ data: Record<string, unknown>[] }>(SEARCH_URL, {
      method: 'POST',
      headers: this.headers({ 'content-type': 'application/json;charset=UTF-8' }),
      body: JSON.stringify({ q: query, store: this.config.store }),
    });
    if (!result.ok) return result;

    // A genuine no-match response from the real API carries `data: []`.
    // Anything that isn't an array — including a missing `data` key — means
    // the API shape changed or the request was misread; reporting that as
    // "no products found" would be a success that did nothing, so it's a
    // network_error instead, never a thrown TypeError out of .slice()/.map().
    if (!Array.isArray(result.data)) {
      return { ok: false, reason: 'network_error', details: `Unexpected search shape: ${JSON.stringify(result).slice(0, 200)}` };
    }

    // The API echoes the query it actually applied as `q`. The spec's live
    // probe saw HTTP 200 + real product data + `q: null` — the query was
    // dropped and a default listing came back. Returning those unrelated
    // products as ok:true is the worst failure class here, so a `q` echo that
    // differs from what was sent is an error. (No `q` key at all is not.)
    if (Object.prototype.hasOwnProperty.call(result, 'q')) {
      const echoed = (result as { q?: unknown }).q;
      const echoedStr = echoed == null ? '' : String(echoed);
      if (echoedStr.trim() !== query.trim()) {
        return {
          ok: false,
          reason: 'network_error',
          details: `search query not applied (response q=${JSON.stringify(echoed)}) — likely a request wire-format mismatch`,
        };
      }
    }

    const results: SearchResult[] = [];
    for (const p of result.data) {
      if (results.length >= limit) break;
      // A row with neither id nor barcode can't be added to the cart; handing
      // the agent productId "undefined" would only fail later, and silently.
      const rawId = p.id ?? p.barcode;
      if (rawId === undefined || rawId === null || rawId === '') continue;
      const price = p.price as { price?: number } | number | undefined;
      results.push({
        productId: String(rawId),
        name: (p.name as string) || (p.he as { name?: string } | undefined)?.name || (p.product_name as string) || '',
        price: typeof price === 'object' ? price?.price ?? 0 : price ?? 0,
      });
    }
    return { ok: true, results };
  }

  async syncCart(items: Record<string, string>): Promise<ClientResult<Record<string, never>>> {
    const supplyAt = new Date();
    supplyAt.setDate(supplyAt.getDate() + 1);
    supplyAt.setHours(0, 0, 0, 0);

    return this.request(CART_URL, {
      method: 'POST',
      headers: this.headers({ 'content-type': 'application/json;charset=UTF-8' }),
      body: JSON.stringify({ store: this.config.store, isClub: 0, supplyAt: supplyAt.toISOString(), items, meta: null }),
    });
  }

  async getOrderList(page = 1): Promise<ClientResult<{ data: OrderListResult }>> {
    const result = await this.request<{ data?: { data?: { current_page: number; last_page: number; total: number; data: OrderSummary[] } } }>(
      `${ORDERS_URL}?page=${page}&activeFilter=0`,
      { method: 'GET', headers: this.headers() },
    );
    if (!result.ok) return result;

    const paginator = result.data?.data;
    if (!paginator?.data) {
      return { ok: false, reason: 'network_error', details: `Unexpected order list shape: ${JSON.stringify(result).slice(0, 200)}` };
    }
    return {
      ok: true,
      data: {
        orders: paginator.data,
        currentPage: paginator.current_page,
        lastPage: paginator.last_page,
        total: paginator.total,
      },
    };
  }

  async getOrderDetail(orderId: string): Promise<ClientResult<{ data: OrderDetail }>> {
    const result = await this.request<{ data?: OrderDetail }>(`${ORDERS_URL}/${encodeURIComponent(orderId)}`, {
      method: 'GET',
      headers: this.headers(),
    });
    if (!result.ok) return result;

    if (!result.data?.lines) {
      return { ok: false, reason: 'network_error', details: `Unexpected order detail shape: ${JSON.stringify(result).slice(0, 200)}` };
    }
    return { ok: true, data: result.data };
  }
}
