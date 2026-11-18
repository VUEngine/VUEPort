# vueport-server

A small PHP relay deployed at [api.vueport.net](https://api.vueport.net) for what a web page can't reach on its own.

| Route | |
| --- | --- |
| `GET /pvb/*` | Planet VB's `/api/rom/*`, routed through for one shared point of egress. |
| `POST /ra` | RetroAchievements' `dorequest.php`, which sends no CORS header |
| `POST /gamepad-profiles` | A controller profile shared from the Game Pads settings, kept for review. `GET` lists and `DELETE /gamepad-profiles/<name>` removes, both with the review token. See `src/gamepad_profiles.php` and `packages/core/scripts/fetch-gamepad-submissions.mjs`. |
| `POST /lan-shares` | VUEPort Desktop announcing a game it shares in its local network, renewed every 30s and gone after 90s. `POST /lan-shares/withdraw` takes it back, `GET /lan-shares` lists the shares of the caller's own network (same public IPv4, or IPv6 /64). Only names and private addresses are kept, never a game. See `src/lan_shares.php`. |

## Layout

- `public/index.php`: front controller, dispatches by path
- `public/.htaccess`: rewrites everything to `index.php` under Apache
- `public/router.php`: the same for PHP's dev server, local only
- `src/`: one file per concern, `require_once`d from `index.php`
- `data/`: not in git, created beside `src/` on first use. Shared profiles awaiting review, rate counters and current LAN shares, all named by salted hashes, never by address.

Only `public/` and `src/` are needed at runtime.

> **Note**: `build`, `clean` and `lint:fix` exist but do nothing. The root `yarn workspaces run` needs them in every package.

## Running Locally

Needs PHP with the `curl` extension.

```sh
yarn workspace vueport-server serve   # dev server on :8787
yarn workspace vueport-server test
```

## Configuration

Read from the environment on every request.

| Variable | Default | |
| --- | --- | --- |
| `VUEPORT_ALLOWED_ORIGINS` | `*` | Comma-separated origins allowed to call the relay. Narrow it for a real deployment, or it relays for any page. |
| `VUEPORT_DATA_DIR` | `../data` | Where shared profiles and LAN shares are kept. Writable by PHP, outside the document root. |
| `VUEPORT_REVIEW_TOKEN` | unset | Sent as `X-Review-Token` to list and delete submissions, at least 24 characters. Falls back to a `review-token` file in the data directory; with neither, reviewing answers 404. |

If the host offers no way to set environment variables for PHP, change the default in [`src/config.php`](src/config.php) directly.

The web build calls `https://api.vueport.net`, hardcoded as `PROXY_BASE` in `packages/web/src/web-proxy.ts`. Moving the relay means changing it there.

Shared profiles are capped at 500 in the queue, five per address per hour.
