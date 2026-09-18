# rami-levy-mcp

An MCP server that lets an LLM agent shop at [Rami Levy](https://www.rami-levy.co.il)
(an Israeli supermarket chain): search products, manage a cart, and reorder
from purchase history — talking to Rami Levy's real API directly.

## The one thing this package does NOT solve

Rami Levy's site is behind Cloudflare, which blocks requests that don't look
like they're coming from a real Israeli browser. This package makes the
*request*; getting that request to actually reach Rami Levy's origin without
being challenged is **your** infrastructure's job — a residential/mobile
proxy, a VPN, a box that's actually in Israel, whatever gets you there. If
`rami_levy_check_status` reports `blocked_by_cloudflare`, that's an egress
problem, not a config problem in this package.

## Requirements

Node >= 22.13. The cart store uses Node's built-in `node:sqlite` — there is
no native addon to compile. Build with:

```bash
npm ci && npm run build
```

## What you need to configure

Four required, two optional:

| Env var | What it is |
|---|---|
| `RAMI_LEVY_BEARER_TOKEN` | The `Authorization: Bearer` token from a logged-in browser session |
| `RAMI_LEVY_ECOM_TOKEN` | A separate JWT, sent as the `ecomtoken` header |
| `RAMI_LEVY_COOKIE` | The full cookie string, including Cloudflare's `cf_clearance` |
| `RAMI_LEVY_USER_AGENT` | Must match whatever browser the above were captured from |
| `RAMI_LEVY_STORE` | Store id (default `412`) |
| `RAMI_LEVY_DB_PATH` | Where the cart's SQLite file lives (default `./cart.db`) |

**Capturing the bundle:** log into rami-levy.co.il in a real browser, open
DevTools → Network, search for any product, click the `/api/catalog`
request, and copy `Authorization`, `ecomtoken`, and `Cookie` from its request
headers, plus the browser's own User-Agent.

**These expire.** `cf_clearance` in particular is a short-lived anti-bot
cookie (hours to a few days). When `rami_levy_check_status` reports
`auth_expired`, repeat the capture above.

## The 7 tools

- `rami_levy_search_products(query, limit?)`
- `rami_levy_add_item(productId, name, price, qty?)`
- `rami_levy_view_cart()`
- `rami_levy_remove_item(productId)`
- `rami_levy_clear_cart()`
- `rami_levy_reorder_from_history(numOrders?, minOccurrences?)` — adds onto
  whatever is already in the cart, it does not replace it. A newly reordered
  product is stored at price 0 until it's re-searched (a past order line
  carries no current price), so `rami_levy_view_cart`'s total under-counts it
  until then.
- `rami_levy_check_status()`

## Errors

Every tool responds with `{ ok: false, reason, ... }` instead of throwing.
Reasons and what to do about each:

| Reason | When | What to do |
|---|---|---|
| `auth_expired` | A JSON response came back 401/403 | Re-capture the token bundle above |
| `blocked_by_cloudflare` | The response wasn't JSON, at any HTTP status | Fix your egress (proxy/VPN/Israeli IP) — not a token problem |
| `network_error` | Fetch failed, the body was invalid JSON, or the response shape was unexpected | Check connectivity; if it persists, the API may have changed |
| `not_in_cart` | `remove_item` was called for a product not currently in the cart (nothing was synced) | Check `view_cart` for the current contents |
| `invalid_args` | `reorder_from_history`'s `numOrders`/`minOccurrences` were out of bounds | Pass `numOrders` 1–50 and `minOccurrences` between 1 and `numOrders` |
| `internal_error` | An unexpected exception was caught at the tool boundary | Inspect the `details` field; likely a bug worth reporting |

## Manual smoke test (not part of automated tests — needs a real, live bundle)

```bash
curl -s -o /dev/null -w "%{http_code}\n" -X POST "https://www.rami-levy.co.il/api/catalog?" \
  -H "Authorization: Bearer $RAMI_LEVY_BEARER_TOKEN" \
  -H "ecomtoken: $RAMI_LEVY_ECOM_TOKEN" \
  -H "Cookie: $RAMI_LEVY_COOKIE" \
  -H "User-Agent: $RAMI_LEVY_USER_AGENT" \
  -d '{"q":"milk","store":"412"}'
```

`200` with a JSON body means it's working. An HTML body (even with a `200`
or `403`) means Cloudflare is challenging your egress, not your tokens.

## Installing into NanoClaw

This ships as an [Agent Plugins 1.0.0](https://agent-plugins.org) plugin
(`plugin.json` + `mcp.json`) — copy this directory into a group's
`plugins/rami-levy/`, fill in the real values for the placeholder env vars
in that group's stored MCP server config, and restart the group.
