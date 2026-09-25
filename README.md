# Gateway

One origin for the storefront. Removes the need for a browser client to know
which service owns which route, to hold a separate CORS policy per service, or
to juggle more than one base URL.

```
http://localhost:4000/generic/:tenant/shop   ->  GENERIC_API_URL      + /:tenant/shop
http://localhost:4000/auth/:tenant/login     ->  AUTH_API_URL         + /:tenant/login
http://localhost:4000/notification/...       ->  NOTIFICATION_API_URL + /...
http://localhost:4000/commerce/...           ->  COMMERCE_API_URL     + /...
http://localhost:4000/doc/...                ->  DOC_API_URL          + /...
http://localhost:4000/config/...             ->  CONFIG_API_URL       + /...
http://localhost:4000/compliance/...         ->  COMPLIANCE_API_URL   + /...
http://localhost:4000/health                 ->  the gateway itself
```

`/generic` rewrites to `/api/generic` on purpose — the engine's own path already
contains "generic", and `/generic/generic/...` is not a URL worth shipping.

## Run

```bash
npm start --prefix services/gateway
```

## Configuration

Every upstream is a FULL base URL — scheme, host, and any path the service
mounts under. That is what lets each one be local or remote independently:

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `4000` | Gateway listen port |
| `GENERIC_API_URL` | `http://localhost:3001/api/generic` | **local** by default |
| `AUTH_API_URL` | `https://api.zone4build.com/auth` | **remote** by default |
| `NOTIFICATION_API_URL` | `https://api.zone4build.com/notification` | remote |
| `COMMERCE_API_URL` | `https://api.zone4build.com/commerce` | remote |
| `DOC_API_URL` | `https://api.zone4build.com/doc` | remote |
| `CONFIG_API_URL` | `https://api.zone4build.com/config` | remote |
| `COMPLIANCE_API_URL` | `http://localhost:3010` | **local** compliance engine |
| `ALLOWED_ORIGINS` | `*` | Comma-separated browser origins |
| `ALLOW_CREDENTIALS` | `false` | Send `Access-Control-Allow-Credentials`. Cannot be combined with `*` — name origins explicitly when enabling it. |
| `UPSTREAM_TIMEOUT_MS` | `30000` | Response-header timeout before a 504 |

Point any service somewhere else without touching code:

```bash
# run commerce locally too
COMMERCE_API_URL=http://localhost:5000 npm start --prefix services/gateway
```

`GET /health` reports the resolved table, including whether each upstream
resolved local or remote — useful when a request goes somewhere unexpected.

## Running the whole platform locally

`npm run dev:local` from the repo root starts the 7 UI apps plus generic-api,
notification-api, config-api and this gateway under one turbo run, and points the
gateway at the local copies of the three services that run here:

| Prefix | Where it goes under `dev:local` |
|---|---|
| `/generic` | **local** :3001 |
| `/notification` | **local** :3005 |
| `/config` | **local** :3009 |
| `/auth` `/commerce` `/doc` | remote — Keycloak, the legacy engine, and document storage are not run locally |

The overrides are set on the `dev:local` script itself. They only reach the
gateway process because they are listed in `globalPassThroughEnv` in
`turbo.json` — turbo 2 runs tasks with a filtered environment, so an undeclared
variable is silently dropped and the gateway falls back to its remote default.
If a service unexpectedly resolves `remote`, check that list first; `GET /health`
prints where each prefix actually went.

commerce-api is deliberately not in the run. It is the service the UIs are being
migrated off, and it stays remote so a local cutover is always compared against
the real thing.

## Behaviour worth knowing

- **Bodies stream.** Nothing is buffered, so CSV imports and file uploads pass
  through without being held in memory.
- **Preflight stops at the edge.** `OPTIONS` is answered by the gateway and never
  forwarded, so upstreams need no CORS handling of their own.
- **Upstream CORS headers are stripped.** If a service also sets them, the browser
  would see a duplicated header and reject the response.
- **Failures are distinguishable.** A refused upstream is `502 UPSTREAM_UNAVAILABLE`,
  a slow one is `504 UPSTREAM_TIMEOUT`, an unmatched path is `404 NO_ROUTE`. The
  storefront can decide whether to retry.
- **Correlation ids flow through.** `x-correlation-id` is forwarded, or minted when
  absent, so a request can be followed across services in the logs.
- **Tenant resolution is untouched.** generic-api reads the tenant from the path
  (or `x-tenant-id`), and both are passed through unmodified.
- **Mixed local/remote is the point.** `/generic` on localhost while `/auth` is
  production behind Cloudflare, addressed through one origin. TLS upstreams get
  SNI, without which shared hosting hands back the wrong certificate.
- **Browser `Origin`/`Referer` are stripped on TLS upstreams.** To a remote
  service the gateway IS the client, not the browser; forwarding the browser's
  Origin makes a strict upstream reject what is really a server-to-server call.
  The gateway has already answered CORS at the edge.
- Zero dependencies. It sits in the path of every storefront request, so its blast
  radius should not include a transitive dependency tree.
