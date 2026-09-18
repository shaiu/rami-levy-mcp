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
`rami_levy_check_status` reports `blocked_by_cloudflare`, see the error table
below: recapture first, suspect your egress only if a fresh capture still fails.

## Requirements

Node >= 22.13. The cart store uses Node's built-in `node:sqlite` — there is
no native addon to compile. Build with:

```bash
npm ci && npm run build
```

## What you need to configure

Three required, three optional:

| Env var | What it is |
|---|---|
| `RAMI_LEVY_BEARER_TOKEN` | The `Authorization: Bearer` token from a logged-in browser session |
| `RAMI_LEVY_ECOM_TOKEN` | A separate JWT, sent as the `ecomtoken` header |
| `RAMI_LEVY_USER_AGENT` | Must match whatever browser the above were captured from |
| `RAMI_LEVY_COOKIE` *(optional)* | The full cookie string. Measured live (2026-09-18) from an Israeli residential IP: neither the orders API (`www-api`) nor search (`www`) needed a cookie at all — bearer + ecomtoken + user-agent were enough. It only helps once Cloudflare starts challenging your egress; in that case, include at least `cf_clearance`. |
| `RAMI_LEVY_STORE` *(optional)* | Store id (default `412`) |
| `RAMI_LEVY_DB_PATH` *(optional)* | Where the cart's SQLite file lives (default `./cart.db`) |

**Capturing the bundle:** log into rami-levy.co.il in a real browser, go to
`/he/dashboard/orders`, open DevTools → Network, find the request to
`www-api.rami-levy.co.il/api/v3/site/orders`, right-click it → Copy → Copy as
cURL, and pull `Authorization`, `ecomtoken`, and `User-Agent` out of the
copied headers. That single request carries everything needed — no separate
capture of the catalog search is required. Only add `RAMI_LEVY_COOKIE` if you
later see `blocked_by_cloudflare` and need to supply `cf_clearance`.

**These expire.** An expired bearer/ecom session shows up as `auth_expired`.
If you do supply a cookie with `cf_clearance`, that's a short-lived anti-bot
cookie (hours to a few days) and an expired one most likely shows up as
`blocked_by_cloudflare` (a challenge page). Either way, repeat the capture
above first.

## The 7 tools

- `rami_levy_search_products(query, limit?)`
- `rami_levy_add_item(productId, name, price, qty?)`
- `rami_levy_view_cart()`
- `rami_levy_remove_item(productId)`
- `rami_levy_clear_cart()`
- `rami_levy_reorder_from_history(numOrders?, minOccurrences?)` — adds onto
  whatever is already in the cart, it does not replace it. A newly reordered
  product is priced at the last price paid — the price from the most recent
  order line that carried it — which may differ from today's price. `view_cart`'s
  `total` is therefore only an estimate until the cart is synced; `serverTotal`
  (returned by every cart-mutating tool) is the authoritative number.
- `rami_levy_check_status()` — probes both the catalog search and page 1 of
  the order history (which needs the logged-in session); returns the first
  failure, else `{ ok: true, cartSize }`.

Every cart-mutating tool (`add_item`, `remove_item`, `clear_cart`,
`reorder_from_history`) syncs the whole cart to the real account and returns
`cartTotal` (local estimate), `itemCount`, and `serverTotal` (Rami Levy's own
total from the sync response, `null` if it gave none). If the sync fails at
the transport level (`auth_expired`, `blocked_by_cloudflare`,
`network_error`), the local cart is rolled back: `ok: false` means nothing
changed, so retrying is safe.

### Where the synced cart shows up on the website

Rami Levy stores the last-synced cart server-side, per account. The website
keeps its own copy of the cart in the browser, and **merges the server cart
into it only when the checkout page (`/he/dashboard/checkout`) loads**. The
home page's cart icon shows the browser's copy alone, so it won't reflect
anything this server added until the checkout page has been opened once.
Point people at the `checkoutUrl` that `rami_levy_view_cart` returns.
(Measured live on 2026-09-18.)

Because that step is a merge, removals don't propagate. If the browser
already holds a product, `remove_item` or `clear_cart` deletes it from the
server cart, but the browser's copy brings it back the next time checkout
loads. Adds and quantities from this server always show up.

## Errors

Every tool responds with `{ ok: false, reason, ... }` instead of throwing.
Reasons and what to do about each:

| Reason | When | What to do |
|---|---|---|
| `auth_expired` | A JSON response came back 401/403 | Re-capture the token bundle above |
| `blocked_by_cloudflare` | The response wasn't JSON, at any HTTP status | Recapture the bundle first (`cf_clearance` expires). Only if a fresh capture still fails, suspect your egress IP (proxy/VPN/Israeli IP) |
| `network_error` | Fetch failed, the body was invalid JSON, the response shape was unexpected, or search ignored the query | Check connectivity; if it persists, the API may have changed (see below) |
| `items_rejected` | The cart sync succeeded but the server dropped some products (`rejected: [{productId, name}]`) | They were removed from the local cart too; search for alternatives |
| `not_in_cart` | `remove_item` was called for a product not currently in the cart (nothing was synced) | Check `view_cart` for the current contents |
| `invalid_args` | `reorder_from_history`'s `numOrders`/`minOccurrences` were out of bounds | Pass `numOrders` 1–50 and `minOccurrences` between 1 and `numOrders` |
| `internal_error` | An unexpected exception was caught at the tool boundary | Inspect the `details` field; likely a bug worth reporting |

## Verified against the live API

Search wire format, order response nesting, and the cart sync response were
all **verified against the real API on 2026-09-18** with fresh logged-in
captures from an Israeli IP, and match what the client parses. One thing to
know about the cart response: Rami Levy adds its own delivery-fee line to
`items` server-side (e.g. `{id, name: "מחיר משלוח", price, quantity}`); this
tool ignores it (it's never matched to a local cart product), and the
top-level `price` — surfaced as `serverTotal` — excludes it, so `serverTotal`
is the product total only, not what checkout will actually charge.

## Manual smoke test (not part of automated tests — needs a real, live bundle)

`RAMI_LEVY_COOKIE` is optional (see above) — leave it unset and the `Cookie`
header below is just empty, which the real API accepts fine.

```bash
curl -s -X POST "https://www.rami-levy.co.il/api/catalog" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $RAMI_LEVY_BEARER_TOKEN" \
  -H "ecomtoken: $RAMI_LEVY_ECOM_TOKEN" \
  -H "Cookie: $RAMI_LEVY_COOKIE" \
  -H "User-Agent: $RAMI_LEVY_USER_AGENT" \
  -d '{"q":"milk","store":"412"}' | head -c 600
```

It works only if the response echoes `"q":"milk"` (not `"q":null`) **and**
contains product data. A `200` with `"q":null` means the query was ignored
(the wire format is wrong). An HTML body, at any status, is a Cloudflare
challenge: recapture the bundle and retry before blaming your egress.

## Installing into NanoClaw

This ships as an [Agent Plugins 1.0.0](https://agent-plugins.org) plugin
(`plugin.json` + `mcp.json`) — copy this directory into a group's
`plugins/rami-levy/`, fill in the real values for the placeholder env vars
in that group's stored MCP server config, and restart the group.
