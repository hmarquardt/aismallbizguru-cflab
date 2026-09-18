# CFLab API

Base URL locally: `http://127.0.0.1:8787`. Independent deployment target: `https://cflab.aismallbizguru.com`. Choose the base URL in client configuration; paths and relative download URLs do not depend on a hostname. `https://lab.aismallbizguru.com` still serves the separate legacy LabBox contract. All responses use `Cache-Control: no-store`. Except health and CORS preflight, app routes require `Authorization: Bearer <app-token>`. Administrative routes use the separate admin boundary described below.

Slugs are 1–64 lowercase ASCII letters, digits, underscores, or hyphens, beginning with a letter or digit. Generated IDs are lowercase UUID v4. Timestamps are UTC ISO 8601 strings. JSON requests require `Content-Type: application/json` and are capped at 64 KiB. Unknown JSON fields are rejected; arbitrary fields inside `data` and `config` are allowed. App config must contain no secrets.

Errors always have this form:

```json
{"error":{"code":"record_not_found","message":"Record not found"}}
```

Common statuses: 400 invalid input, 401 missing/invalid/revoked/wrong-app bearer, 403 insufficient scope/origin/admin denial, 404 missing resource or route, 409 duplicate app, 413 body limit, 415 wrong JSON media type, 500 sanitized internal error, 502 upstream failure/policy violation, 503 missing file bytes/proxy secret, 504 upstream deadline. Successful DELETE returns 204 with no body. An inactive app appears unavailable (404).

## Health

`GET /api/health` → 200:

```json
{"status":"ok","service":"cflab"}
```

This is liveness only, not a database/storage readiness check.

## App data

`GET /api/apps/:app` accepts any valid token for that app. Returns `id`, `name`, `active`, `config`, `created_at`, and `updated_at`. It does not return tokens, origins, or proxy secrets.

## Records

Base: `/api/apps/:app/resources/:resource/records`. Resources are implicit namespaces; no resource creation call is needed.

| Method/path | Scope | Behavior |
| --- | --- | --- |
| POST base | `records:write` | Create `{data: object, status?: string \| null}`; 201 |
| GET base | `records:read` | List with `limit`, `after`, optional exact `status`; 200 |
| GET base`/:id` | `records:read` | Read one; 200 |
| PATCH base`/:id` | `records:write` | Replace supplied `data`, optionally change `status`; 200 |
| DELETE base`/:id` | `records:write` | Permanently delete; 204 |

```sh
curl http://127.0.0.1:8787/api/apps/demo/resources/notes/records \
  -H "Authorization: Bearer $APP_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"data":{"title":"First note","tags":["test"]},"status":"draft"}'
```

Example 201 response:

```json
{
  "id":"4e944fa4-3a8a-4e3e-a61b-2cf659bc0308",
  "app_id":"demo",
  "resource":"notes",
  "data":{"title":"First note","tags":["test"]},
  "status":"draft",
  "created_at":"2026-09-18T12:00:00.000Z",
  "updated_at":"2026-09-18T12:00:00.000Z"
}
```

```sh
curl 'http://127.0.0.1:8787/api/apps/demo/resources/notes/records?limit=20&status=draft' \
  -H "Authorization: Bearer $APP_TOKEN"
curl -X PATCH "http://127.0.0.1:8787/api/apps/demo/resources/notes/records/$RECORD_ID" \
  -H "Authorization: Bearer $APP_TOKEN" -H 'Content-Type: application/json' \
  -d '{"data":{"title":"Replacement payload"},"status":null}'
curl -X DELETE "http://127.0.0.1:8787/api/apps/demo/resources/notes/records/$RECORD_ID" \
  -H "Authorization: Bearer $APP_TOKEN"
```

`data` is an object, not an arbitrary JSON scalar or array. PATCH replaces the whole supplied data object; it does not merge keys. Omitted fields are preserved; `status: null` clears status. Non-null status is 1–64 characters without control characters. Empty PATCH is invalid. IDs/ownership/timestamps cannot be supplied or changed through this API.

Lists return `{"records":[...],"next_cursor":null}` (or a UUID cursor). Pass a non-null cursor as `after` with the same filters for the next page. Default limit 50, maximum 100. Results are in ascending UUID order, not creation order; there is no `total` or offset. Repeated/unknown query parameters are errors. Updates are last-writer-wins; deletion is permanent.

## Files

Base: `/api/apps/:app/files`.

| Method/path | Scope | Behavior |
| --- | --- | --- |
| POST base | `files:write` | Raw byte upload, maximum 8 MiB; 201 metadata |
| GET base | `files:read` | Paginated metadata, `limit`/`after`; 200 |
| GET base`/:id` | `files:read` | Metadata; 200 |
| GET base`/:id/content` | `files:read` | Streaming attachment download; 200 |
| DELETE base`/:id` | `files:write` | Delete R2 object and D1 metadata; 204 |

```sh
curl http://127.0.0.1:8787/api/apps/demo/files \
  -H "Authorization: Bearer $APP_TOKEN" \
  -H 'Content-Type: image/png' -H 'X-Filename: photo.png' \
  --data-binary @photo.png
```

Send a plain MIME type without parameters. Omitted type defaults to `application/octet-stream`; filename defaults to `download`. `X-Filename` is at most 200 characters and cannot contain control characters. No multipart form, caller-supplied object key, public URL, range download, or record attachment is supported yet. A record may store a returned file ID explicitly in its data.

Example metadata (checksum abbreviated here; actual value is 64 hex characters):

```json
{
  "id":"4e944fa4-3a8a-4e3e-a61b-2cf659bc0308",
  "app_id":"demo",
  "filename":"photo.png",
  "content_type":"image/png",
  "size_bytes":1234,
  "checksum":"...",
  "created_at":"2026-09-18T12:00:00.000Z",
  "download_url":"/api/apps/demo/files/4e944fa4-3a8a-4e3e-a61b-2cf659bc0308/content"
}
```

List envelope: `{"files":[...],"next_cursor":null}`. Download URLs still require bearer authentication; they cannot be used as public `<img src>` URLs. Browser clients can fetch with Authorization, then use a blob URL. Download responses include Content-Type, Content-Length, Content-Disposition, ETag, sandbox CSP, and `nosniff`.

```sh
curl "http://127.0.0.1:8787/api/apps/demo/files/$FILE_ID/content" \
  -H "Authorization: Bearer $APP_TOKEN" --output downloaded.png
```

## Configured proxy

`GET /api/apps/:app/proxy/:source` requires `proxy:use`. Only predefined sources are callable; there is no destination URL or suffix-path parameter.

For a weather source configured as below:

```sh
curl 'http://127.0.0.1:8787/api/apps/demo/proxy/weather?latitude=42&longitude=-93' \
  -H "Authorization: Bearer $APP_TOKEN"
```

Response is the approved upstream content with HTTP 200 (no JSON wrapper). Invalid queries return 400; other methods return 405; inactive/absent sources return 404. Redirects, non-2xx statuses, rejected types, DNS policy failures, and oversized bodies return sanitized 502; deadline expiry returns 504. No upstream cookies, Location, CORS, or diagnostic headers are exposed. See [proxy threat model](ARCHITECTURE.md#proxy-threat-model).

## Administration

The following routes are functional through the **local entrypoint** with `Authorization: Bearer <DEV_ADMIN_TOKEN>`, a loopback host, and no Origin header. Production returns `admin_disabled` until verified Cloudflare Access authentication is implemented. App tokens cannot use these routes. All JSON responses, including initial token creation, are `no-store`.

| Method/path under `/api/admin` | Body / response |
| --- | --- |
| POST `/apps` | `{id,name,active?,origins?,config?}` → 201 app with origins |
| GET `/apps` | `{apps:[...],next_cursor}`; optional `after` slug, 100 per page |
| GET `/apps/:app` | App including origins |
| PATCH `/apps/:app` | Any of `{name,active,origins,config}` → `{updated:true}` |
| POST `/apps/:app/tokens` | `{name,scopes}` → 201 metadata **and one-time token** |
| GET `/apps/:app/tokens` | `{tokens:[...],next_cursor}`; optional `after` UUID, 100 per page |
| DELETE `/apps/:app/tokens/:id` | Revoke (idempotent for an existing token); 204 |
| PUT `/apps/:app/proxy-sources/:source` | `{active?,config}` → create/replace source; 200 |
| GET `/apps/:app/proxy-sources` | `{sources:[...],next_cursor}`; optional `after` slug, 100 per page |

App IDs cannot be renamed. Inactive apps can still be administered. `origins` and `config` are replaced as whole values when supplied; omitted fields are unchanged. Maximum 32 origins, exact serialized HTTP(S) origins without trailing slash/path. HTTP is allowed only for loopback. No app deletion is provided.

Token scopes must be a nonempty list drawn from `records:read`, `records:write`, `files:read`, `files:write`, `proxy:use`. Name is required, maximum 128 characters. Creation response contains `id`, `name`, `prefix`, `scopes`, `token`, `created_at`. List responses include `revoked_at` but never token plaintext or hashes. Tokens do not expire automatically.

```sh
curl -X PUT http://127.0.0.1:8787/api/admin/apps/demo/proxy-sources/weather \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H 'Content-Type: application/json' \
  -d '{"active":true,"config":{
    "base_url":"https://api.open-meteo.com/v1/forecast",
    "methods":["GET"],
    "query_params":["latitude","longitude","current"],
    "headers":{"Accept":"application/json"},
    "secret_headers":{},
    "response_types":["application/json"],
    "max_response_bytes":1048576,
    "timeout_ms":5000,
    "cache_ttl":0
  }}'
```

`base_url` is required and its hostname must already be in the deployment's `PROXY_ALLOWED_HOSTS`. Defaults shown above apply except `headers` and `query_params` default empty. Response types may be `application/json`, `application/geo+json`, `text/plain`, `text/csv`; no wildcards or executable content types. Size range 1–2,097,152 bytes, timeout 100–10,000 ms. Only GET and cache TTL 0 are supported. Query values are limited to 512 characters. Source PUT replaces the full config; defaults are reapplied for omitted properties. Set `active:false` to disable a source.

For an upstream credential, configure `"secret_headers":{"Authorization":"WEATHER_KEY"}` and put `{"WEATHER_KEY":"Bearer actual-upstream-secret"}` in the Worker secret `PROXY_SECRETS` (locally in ignored `.dev.vars`). The value is the complete header value. Secret references remain admin-visible; values never come from D1 or callers. Ordinary headers must not contain credentials; Authorization is rejected there. Host, Cookie, forwarding, Cloudflare, and transport headers are forbidden.

## Browser preflight

```sh
curl -i -X OPTIONS http://127.0.0.1:8787/api/apps/demo/resources/notes/records \
  -H 'Origin: http://localhost:5173' \
  -H 'Access-Control-Request-Method: POST' \
  -H 'Access-Control-Request-Headers: authorization,content-type'
```

For an allowed origin this returns 204, the exact `Access-Control-Allow-Origin`, allowed methods `GET, POST, PATCH, DELETE`, headers `authorization, content-type, x-filename`, and a 300-second preflight max age. Browser responses expose Content-Disposition and ETag. Origin policy does not substitute for tokens or scopes.
