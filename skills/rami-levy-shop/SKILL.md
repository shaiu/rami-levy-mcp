---
name: rami-levy-shop
description: Use when the user wants to do a Rami Levy shop through the MCP server — a weekly/regular order ("do my usual shop", "reorder my staples", "time for groceries"), adding several items at once, or reviewing what's in the cart before checking out. Covers the confirm-then-add flow, how the website cart differs from this one, and what to hand the user at the end.
---

# Shopping at Rami Levy

The `rami_levy_*` tools talk to a real account. Adds and removals take effect
immediately on it, and there is no undo beyond removing the item again. The
job here is to get the shop right *before* writing, and to hand over a cart
the user can actually see.

## The regular shop

1. **Preview, don't reorder blind.** Call `rami_levy_suggest_reorder`. It
   returns the products appearing in at least `minOccurrences` (default 3) of
   the last `numOrders` (default 10) orders, each with `occurrences`, the
   median `qty`, and `lastPrice` (what was paid last time — not necessarily
   today's price).
2. **Show the list and ask.** Present it compactly — name, qty, last price,
   and how many of the N orders it appeared in — and ask what to drop or
   change. Do not add anything yet.
   - Only skip this when the user explicitly asked for a blind reorder
     ("just reorder my usual"). Then call `rami_levy_reorder_from_history`
     with the same arguments: identical selection, applied directly.
3. **Add what survived** with `rami_levy_add_item`, using the `productId`,
   `name` and `lastPrice` from the candidate. Each add syncs the whole cart
   and returns `serverTotal` — Rami Levy's own number, and the authoritative
   one.
4. **Fill the gaps** with `rami_levy_search_products`. Search in **Hebrew** —
   the catalog is Hebrew, and an English query returns nothing rather than an
   error. Never invent a `productId`; it always comes from a search result or
   an order line.

## Adjusting the tuning

- Shopping fortnightly rather than weekly, or the list looks thin? Raise
  `numOrders` (max 50) or lower `minOccurrences` to 2.
- The list is full of one-offs? Raise `minOccurrences`.
- `suggest_reorder` costs about `1 + numOrders` API calls, so it is not free —
  tune in one step rather than sweeping values.

## Handing the cart over

`rami_levy_view_cart` shows **only what this server has added since the last
checkout**. It is not a read of the website cart — Rami Levy has no endpoint
for that — so anything the user did in the browser is invisible here.

Send them to the `checkoutUrl` (`/he/dashboard/checkout`), not the home-page
cart icon: the site merges this cart into the browser's copy only when the
checkout page loads. If the page was already open when the cart changed, it
still shows the old contents — say so (that's what `checkoutHint` is for),
because a stale page reads exactly like an add that failed.

Two numbers to keep straight: `serverTotal` is the product total, and Rami
Levy adds a delivery fee (~₪36) as its own line at checkout. Don't quote
`serverTotal` as what they'll be charged.

## Looking at past orders

`rami_levy_list_orders(page?)` pages the history newest-first (6 per page,
with `page`/`lastPage`/`totalOrders`). `rami_levy_view_order(orderId)` opens
one in full. Use these to answer "what did I buy last time" or "how much was
the last order" — they never touch the cart. A line's `productId` feeds
straight into `add_item` if the user wants one thing again.

## When something fails

Every tool returns `{ ok: false, reason }` instead of throwing, and a failed
cart sync rolls the local cart back, so `ok: false` means nothing changed and
retrying is safe.

- `auth_expired` — the captured session expired. The user re-captures it; the
  procedure lives in this repo's README, and on the maintainer's machine it is
  `pbpaste | ~/.config/rami-levy-mcp/import-curl.sh` after copying the orders
  request as cURL. Don't try to read the tokens out of a browser.
- `blocked_by_cloudflare` — recapture first; only suspect the egress IP if a
  fresh capture still fails.
- `items_rejected` — the server refused those products and they were removed
  locally too. Tell the user and offer alternatives from a fresh search.
- `resetAfterOrder` on a response — an order was placed since the last sync,
  so the cart was cleared before the change. Say the cart started fresh.
