# CANDY FINDER

A complete, real-time DUELS and TRADES marketplace dashboard. The client is a responsive React/TypeScript website. A Cloudflare Worker issues authenticated WebSocket credentials and handles API routes. SQLite-backed Durable Objects persist listings and coordinate connected players. Workers Static Assets serves the built site from the same Cloudflare deployment.

**No Roblox Lua scripts or Roblox integrations are included.** This project has its own guest-session and WebSocket-token authentication. It does not depend on a token reseller or third-party authentication provider.

## What it does

- Separate live DUELS and TRADES rooms, with a dashboard and channel-specific listing feeds.
- Create listings with a player display name, Brainrot/item name, what the player wants, optional notes, and a 15-, 30-, or 60-minute expiry.
- Search and sort listings. The online count is the number of unique connected guest sessions in the selected channel; the active count is the server's count for that channel.
- Owners can remove their own listings. The server rejects another player's removal request.
- A Durable Object broadcasts listings and presence to connected browsers, restores persisted listings after reconnection, expires stale listings, and closes sockets when their temporary token expires.
- Strict server-side field validation, a per-IP connection-token rate limit, per-player listing rate limit, duplicate checks, payload limits, malformed-message handling, and reconnect backoff.

## Run locally

Use Node.js 20 or newer. Install dependencies with `npm install`.

In terminal 1, run:

```sh
npm run dev:worker
```

On first start this creates `.dev.vars` with a cryptographically random local `WS_TOKEN_SECRET`. The file is ignored by Git. Wrangler runs the Worker and local SQLite Durable Objects on port 8787.

In terminal 2, run:

```sh
npm run dev
```

Open `http://localhost:3000`. Vite serves the site and proxies `/api/*` and `/ws` to the local Worker. Stop either process with Ctrl+C. You can also run `npm run test:all` to type-check, run unit tests, build the site, and execute the local multi-client WebSocket integration suite.

The integration test starts its own Wrangler process on port 8793 and uses a temporary local Durable Object store. It tests the built homepage, health endpoint, route manifest, rejection of missing/invalid WS credentials, valid signed tokens and browser-session cookies, two simultaneous clients, live listing creation and removal broadcasts, duplicate blocking, owner-only removal, persistent reconnect, and DUELS/TRADES isolation.

## Authentication model

This is anonymous guest authentication, not an email/password account system. The first same-origin token request creates a random guest subject and sets a signed, 30-day `HttpOnly; Secure; SameSite=None` session cookie. That signed session cookie survives page refresh and lets the user remove their own listings after reconnecting. The Worker returns an HMAC-SHA-256-signed WebSocket token that expires after three minutes. The client holds the temporary token in memory and offers it as an extra WebSocket subprotocol; it is not stored in local storage or sent as a URL parameter. The Worker checks its signature, type, and expiry before forwarding the upgrade, then removes the auth subprotocol from the forwarded request. The Durable Object schedules closure for authenticated sockets when their three-minute token expires; the client reconnects with a newly issued token.

The permanent signing key is **never** included in browser assets. For local development it is in ignored `.dev.vars`; for production it is a Cloudflare Worker secret. The guest display name is a public label, not proof of a real-world identity. Anyone can make a new anonymous guest session, and names are not verified against a game account.

## Deploy to Cloudflare

A Cloudflare account is required for publication. The source package is ready to deploy, but deployment must be authorized from an account that owns or can create the Cloudflare Worker.

1. Install dependencies and authenticate Wrangler:

   ```sh
   npm install
   npx wrangler login
   ```

2. Create a new production signing secret and store it only in Cloudflare:

   ```sh
   openssl rand -base64 48 | npx wrangler secret put WS_TOKEN_SECRET
   ```

   Do not paste the permanent secret into `src/`, `public/`, `wrangler.toml`, a checked-in `.env` file, or frontend build variables. If a Wrangler version prompts for a value instead of reading stdin, run `npx wrangler secret put WS_TOKEN_SECRET` and paste a newly generated value at the prompt.

3. Build the frontend and deploy the Worker plus static assets:

   ```sh
   npm run deploy
   ```

`wrangler.toml` declares a SQLite-backed `CandyRoom` Durable Object migration. Wrangler creates the Durable Object binding as part of the deployment. The dashboard, API, and WebSocket endpoint ship together; no separate Pages project is needed. Wrangler prints the resulting `workers.dev` URL. A custom domain can be attached later from the Cloudflare dashboard.

The first production signing key is separate from local `.dev.vars`. Keep a secure backup of the production secret: replacing it invalidates outstanding cookies and WS tokens. A fresh deployment includes the Worker code and generated `dist/` assets; the ZIP contains source/configuration and a lockfile, not node_modules, generated output, local secrets, Wrangler local storage, or account credentials.

## Cloudflare Free plan notes

Cloudflare changes pricing and quotas; check the linked official pages before launch. The current published limits used for this README are:

- Workers Free includes **100,000 Worker requests per day** and **10 ms CPU per invocation**. A WebSocket handshake counts as a Worker request; ordinary static asset requests served by Workers Static Assets are documented as free and unlimited. Requests to the API and socket handshakes still run Worker code.
- Workers Free supports **SQLite-backed Durable Objects**. The current published Durable Objects free allowances include **100,000 DO requests per day**, **13,000 GB-seconds per day**, **5 million rows read per day**, **100,000 rows written per day**, and **5 GB of stored SQLite data**. Free-tier daily allowances reset at 00:00 UTC. The Durable Objects documentation explains that incoming WebSocket messages are accounted for using a 20:1 request ratio; outgoing messages are not charged as requests.
- Cloudflare states that operations beyond a Workers Free daily request cap can return error 1027, and exceeding a Durable Objects free allowance can cause further operations of that type to fail until the daily reset. An outage at the quota boundary can therefore stop new token requests, listing changes, or socket synchronization until usage resets. A paid Workers plan is needed for greater/paid usage, not to buy individual connection tokens.
- This project caps each channel at 250 active listings and throttles per-IP token requests and per-player posting. These application limits are separate from Cloudflare platform quotas. Long-lived sockets use the Durable Objects WebSocket Hibernation API to avoid keeping idle Durable Objects active between events.

Official references: [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/), [Workers limits](https://developers.cloudflare.com/workers/platform/limits/), [Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/), [Durable Objects WebSockets](https://developers.cloudflare.com/durable-objects/best-practices/websockets/), and [Workers Static Assets](https://developers.cloudflare.com/workers/static-assets/).

## Project files

- `src/client/` — React dashboard, form, listings, socket client, search and filtering.
- `src/worker/` — Worker routes, signed session/WS token logic, validation, and Durable Object room implementation.
- `src/styles/global.css` — desktop/iPhone layout, theme, micro-animations, and reduced-motion rules.
- `public/` — favicon and the route manifest.
- `tests/unit/` — token and validation tests.
- `scripts/` — local Worker bootstrap and multi-user integration runner.
- `wrangler.toml` — Cloudflare Worker, Static Assets, Durable Object binding, and SQLite migration.
- `.dev.vars.example` — placeholder only; never contains a real secret.

## Security and limitations

WebSocket credentials are bearer tokens, so any temporary token visible to a client can authorize that guest for up to three minutes. The permanent signing key is secret-side only. Guest names are not tied to a verified game profile. The current project does not provide email recovery, password accounts, moderation/admin tools, or Roblox data connectivity. Never use a display name as a security decision; listing ownership is tied to the random signed session subject.
