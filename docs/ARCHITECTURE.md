# Architecture

## Deployment identity

The `cflab` Worker is configured for the exact custom domain `cflab.aismallbizguru.com`, with a separate `cflab` D1 database and private `cflab-files` R2 bucket. This is the independent production-equivalent environment. The existing `lab.aismallbizguru.com` service, DNS, and infrastructure stay unchanged. Local Wrangler uses local bindings without custom-domain routes. Application logic has no deployment hostname; health always identifies `service: "cflab"`, and download URLs are relative. A future approved hostname change can keep the same Worker and data bindings after compatibility work is complete. See [deployment instructions](DEPLOYMENT.md).

## Request flow

The production entrypoint creates a Hono router with a deny-all admin authorization seam. The local entrypoint supplies a separate loopback/bearer admin check. Production never imports that development check. Hono is the sole runtime dependency: it removes routing/parameter/middleware plumbing without hiding SQL or application logic.

App requests load an active app, check the exact Origin against `app_origins`, handle preflight, hash and validate the app bearer token, enforce the route scope, validate input, and execute bound SQL or a binding operation. Every record/file lookup and mutation includes its owning app, and records also include resource. Errors have one JSON envelope. Health returns liveness without binding calls.

Structured logs contain only event name, method, status, and duration. Unexpected failures log a generic event without SQL, URLs, headers, or payloads. Wrangler invocation logs are disabled in the production config to avoid automatic full-URL logging. A future Analytics Engine write belongs in a small optional reporting function after request handling; there is no event table or analytics request path today.

## D1 and pagination

- `apps`: slug primary key, name, active state, timestamps, small client-readable JSON configuration.
- `app_origins`: composite primary key supports exact app/origin checks and prevents duplicates.
- `api_tokens`: globally unique SHA-256 hash index for authentication; `(app_id, id)` for bounded administration. No plaintext token column. Revocation preserves an administration record.
- `records`: `(app_id, resource, id)` primary key for both object access and keyset lists. `(app_id, resource, status, id)` serves optional exact status filtering. Payload is a JSON object with a SQLite validity/type constraint. No speculative JSON-field indexes.
- `files`: `(app_id, id)` serves listing and access; unique object key protects storage identity. App foreign key prevents accidentally deleting an app while its file metadata remains.
- `proxy_sources`: `(app_id, slug)` for lookup; constrained JSON policy, active state, timestamps.

Resources are implicit namespaces. A resource catalog adds no useful behavior until schemas or policies need enforcement. Configuration JSON is intentionally small; JSON requests are limited to 64 KiB. Only `limit`, `after`, and optional exact `status` are record query parameters. Limits are 1–100 (default 50). UUID ordering is stable but **not chronological**. Lists return one extra row internally to determine `next_cursor`, avoiding counts and offsets. Concurrent inserts earlier than a cursor are seen on the next full traversal; pagination is not a snapshot.

Every SQL statement is fixed text; client values are bound. D1 batches make app/origin creation and origin replacement atomic. Record PATCH atomically replaces supplied data and optionally changes status; omitted fields are preserved. Updates use last-writer-wins semantics. DELETE permanently removes records. Soft deletion, ETags for record concurrency, and payload-specific indexes can be added when a client requires them.

## R2 and consistency

Private R2 holds bytes at `apps/{app_slug}/files/{uuid_v4}`. Keys are deterministic from validated identifiers and a random 128-bit UUID, never filenames. D1 contains ownership, filename, type, byte length, SHA-256, and timestamps; public metadata omits object keys. Downloads stream through the authenticated Worker and use attachment disposition, sandbox CSP, `nosniff`, and `no-store`. Applications never receive R2 credentials.

Uploads are raw bodies capped at 8 MiB and buffered deliberately for bounded size validation and checksum computation before storage. This is a small-file API; large/multipart uploads are a future extension. Proxy bodies are also bounded before responding, up to 2 MiB. These are application caps, not claims about platform maxima.

D1 and R2 do not share a transaction. Upload writes bytes first and deletes them if metadata insertion fails. A process crash or failed compensation can leave an orphan R2 object: compare R2 inventory to D1 and review unmatched objects before cleanup. Delete removes R2 first; a D1 failure leaves metadata and a 503 download, and retrying DELETE repairs it. Tests cover these ordinary failure paths. There is no background janitor, distributed transaction, automatic retry of uploads, or exactly-once guarantee. If an upload response is lost, inspect the file list before retrying.

## Authentication and CORS

Tokens contain 256 random bits, prefixed `cfl_`, and are SHA-256 hashed. Fast hashing is appropriate for randomly generated high-entropy secrets; it is not password hashing. Each token belongs to exactly one app, has explicitly enumerated scopes, and is returned only on creation. An identifier and short prefix support listing/revocation. Tokens do not expire automatically in v1; rotate by creating a replacement, switching the client, and revoking the old one.

Scopes are app-wide: `records:read`, `records:write`, `files:read`, `files:write`, `proxy:use`. Write does not imply read. No wildcard, anonymous data access, implicit empty-scope privilege, OAuth, or user identity is implemented. Any valid app token can read that app's public configuration.

The production admin seam is closed until a verified Access integration is implemented. The local entrypoint requires a random secret of at least 32 characters, a loopback hostname, and no Origin header. Bind Wrangler to loopback; do not tunnel or deploy the local entrypoint. App bearer tokens cannot administer the service.

CORS echoes a single exact configured origin, never `*`. Only loopback origins may use HTTP. Allowed preflights need no bearer token but must match app origin, method, and permitted headers. Errors for allowed origins retain CORS headers. Requests without Origin remain valid for machine clients, so CORS is not an authorization boundary. Cookies and credentialed browser sessions are not used.

## Proxy threat model

Untrusted callers may control the app token, source slug, permitted query values, and arbitrary request headers. They cannot configure destinations. Trusted operators control deployed `PROXY_ALLOWED_HOSTS`, admin access, source policy, and secrets. The allowlist is empty by default in production; local configuration allows only `api.open-meteo.com`.

Each source uses one exact HTTPS URL with a fixed path. There is no caller-controlled path, URL, hostname, port, or protocol. URL credentials, fragments, base queries, IP literals (including alternate numeric forms), localhost/private/internal hostnames, workers.dev destinations, and non-HTTPS protocols are rejected. Hosts must exactly match the operator list; no wildcard or suffix matching. GET is the only v1 method. Unknown/repeated queries and common destination/callback parameter names are rejected. Operators must audit the **meaning** of each approved parameter: a trusted upstream that itself fetches caller-supplied URLs is not safe just because its hostname is approved.

Before each fetch, both A and AAAA answers are checked. Resolution errors fail closed; only ENODATA is tolerated when the other family has public answers. Private, loopback, link-local, shared, reserved, documentation, multicast, and conservative IPv6 special/transition ranges are blocked. The IPv6 validator intentionally rejects all `2001::/16` and `2002::/16`; some legitimate providers therefore require a reviewed refinement before use.

**DNS trust limitation:** Workers native `fetch` resolves the hostname again; the DNS check does not pin the connection address. An operator must only allow established APIs whose domain, DNS, and endpoint behavior they trust. Do not allow tenant-controlled domains, dynamic DNS, URL-forwarding services, or internal endpoints. This design does not claim protection against an allowlisted provider deliberately rebinding DNS or becoming compromised. If that threat enters scope, use an egress mechanism that enforces the destination at connection time before enabling such sources; a preflight DNS lookup alone cannot solve it.

Fetch uses `redirect: manual`; every redirect is rejected, even to an otherwise approved host. No caller headers, cookies, bearer tokens, or Origin headers are forwarded. Server headers are explicitly configured; secrets live in a Worker secret JSON map and D1 holds references. Do not put credentials in ordinary configured headers. Responses expose only an allowed content type and bytes, never upstream cookies, redirects, CORS, or diagnostic headers. Non-2xx status becomes a sanitized 502. Response size is enforced while reading actual bytes, even with missing/misleading Content-Length. A single deadline covers DNS, response headers, and body reading; timeout returns 504. Proxy caching is disabled (`cache_ttl: 0`) to avoid shared authenticated caches.

## Services intentionally absent

No Durable Objects: there is no per-entity coordination or live session requirement. No Queues or Workflows: requests are small and synchronous. No Analytics Engine yet: operational logs suffice. No DuckDB, Iceberg, or R2 Data Catalog: there is no current archival query workload. R2 and a small reporting seam leave room for these later without adding them to ordinary requests. No ORM, schema framework, custom login, scheduler, or VPS remains.
