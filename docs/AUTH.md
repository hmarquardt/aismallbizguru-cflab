# Human authentication

CFLab has two independent credential systems. They are deliberately not interchangeable:

| | Machine API token | Human session |
| --- | --- | --- |
| Belongs to | one application/service | one human user |
| Prefix | `cfl_` | `cflu_` |
| Created by | admin API (`POST /api/admin/apps/:app/tokens`) | successful login |
| Lifetime | no automatic expiry; revoke explicitly | 7 days by default, revocable |
| Authorization | enumerated app scopes | admin status or project membership |
| Storage | SHA-256 hash in `api_tokens` | SHA-256 hash in `sessions` |

Machine tokens keep their existing behavior. Human sessions add user identity and project membership without replacing service credentials. Password reset tokens use the distinct `cflr_` prefix and are never valid for API access.

## User model

```text
users
  id, email (unique, normalized lowercase), password_hash (nullable until setup),
  active, is_admin, created_at, updated_at, password_changed_at, last_login_at

project_memberships
  user_id, app_id, access ('read' | 'write'), created_at
```

`is_admin = true` grants global administration and access to every app. `is_admin = false` grants access only to explicitly assigned apps. Membership `read` maps to `records:read` and `files:read`; membership `write` adds `records:write`, `files:write`, and `proxy:use`. A user may belong to any number of projects. There are no custom roles or policy languages, and no public signup: administrators create users.

Email is trimmed and lowercased for storage and comparison. Gmail dots, plus-addressing, and provider-specific semantics are never rewritten.

## Password storage

Passwords use standard scrypt through Workers' native `node:crypto` binding with OWASP's recommended Worker-compatible parameters (`N=8192`, `r=8`, `p=10`), a unique 16-byte random salt, a 256-bit derived key, and an explicit 32 MiB `maxmem` (the algorithm needs 8 MiB; the isolate ceiling is 128 MiB). The stored representation encodes algorithm, parameters, salt, and key so parameters can be raised later:

```text
scrypt$8192$8$10$<base64 salt>$<base64 derived key>
```

Verification uses the parameters stored with each hash, rejects unknown algorithms and parameter sets that would exceed the memory budget, and compares keys in constant time. Malformed or unsupported stored hashes fail safely. There is no plaintext, reversible encryption, fast generic hash, custom crypto, or external password dependency.

PBKDF2-HMAC-SHA-256 was the original choice, but the deployed Workers runtime rejects PBKDF2 iteration counts above 100,000 (`NotSupportedError`), well below OWASP's 600,000-iteration guidance. Rather than accept the ceiling or compose a custom KDF, CFLab uses OWASP's recommended scrypt fallback. `node:crypto` is part of the runtime via the already-enabled `nodejs_compat` flag, not a dependency, and the hash format remains versioned and upgradeable.

Policy is length-only: 15–128 characters, spaces, Unicode, and password-manager strings are allowed, paste is allowed, and passwords are never silently truncated. No uppercase/lowercase/digit/symbol rules and no scheduled expiry. A password changes only when the user requests it, recovery requires it, or credentials are suspected compromised.

## Session lifecycle

Login creates a `cflu_` + 64-hex-character token from a cryptographically secure generator. Only `SHA-256(raw token)` is stored in D1; the raw token is returned once, never logged, and never placed in a URL. `last_seen_at` updates opportunistically (at most every five minutes).

- Absolute lifetime: 7 days by default, configured by the plaintext var `AUTH_SESSION_TTL_SECONDS` (300–2,592,000 seconds). No refresh tokens.
- `Authorization: Bearer <session>` works on app routes, so a different-origin browser client can authenticate with the user's own revocable credential.
- Sessions are individually revocable (`POST /api/auth/logout`, admin `POST /api/admin/users/:id/revoke-sessions`).
- Deactivating a user revokes all their sessions immediately.
- A password change or password reset revokes all sessions and requires a fresh login. Sessions are not rotated in place.

## Password reset lifecycle

`POST /api/auth/forgot-password` always returns the same generic response for known, unknown, and inactive accounts and does not reveal delivery state. When an active account exists, CFLab invalidates previous unused reset tokens, issues a new `cflr_` token, stores only its SHA-256 hash, and emails a link.

Reset tokens are single-use, user-specific, and short-lived (30 minutes by default via `AUTH_RESET_TTL_SECONDS`, 300–86,400 seconds). `POST /api/auth/reset-password` validates the hash, expiry, and unused state; hashes the new password; marks the token and any siblings used; revokes all sessions; and requires a normal login. The user is never logged in automatically.

The reset URL is built only from the trusted `AUTH_PUBLIC_BASE_URL` var (HTTPS, loopback HTTP permitted for local development). An incoming `Host` header can never change it. Reset pages send `Referrer-Policy: no-referrer`, and the page removes the token from the address bar after reading it.

## Email

Transactional authentication mail (initial password setup, forgot-password reset) uses the Cloudflare Email Service `send_email` binding named `EMAIL`. Configuration:

```text
AUTH_FROM_EMAIL        sender address; empty means mail is unavailable
AUTH_PUBLIC_BASE_URL   trusted base for reset links
```

Real delivery requires onboarding a sending domain in the Cloudflare dashboard (**Compute > Email Service > Email Sending > Onboard Domain**), which adds bounce MX, SPF, DKIM, and DMARC records. The current production configuration intentionally leaves `AUTH_FROM_EMAIL` empty until that onboarding is reviewed; until then, forgot-password still returns its generic response (mail failure is logged, not exposed), and admin password-setup requests fail with `503 email_unavailable`. No third-party mail provider is used, and automated tests use a fake binding so no real email is sent.

## Administration

Human administrators use the same `/api/admin/*` surface as before, authenticated by an admin session instead of a shared secret. `GET/POST/PATCH /api/admin/users`, membership add/remove, session revocation, and password-setup mail are documented in [API.md](API.md). The local entrypoint keeps the loopback `DEV_ADMIN_TOKEN` convenience for development; production has no bypass.

Safety rules: only administrators can manage users; project users receive `403`; the last active administrator cannot be deactivated or demoted; deactivation revokes sessions; duplicate emails are rejected case-insensitively; memberships must reference real apps; and no endpoint returns or logs password hashes, reset tokens, or session tokens.

The minimal UI (`/admin/login`, `/admin/users`, `/account`, `/forgot-password`, `/reset-password`) stores the session token in `sessionStorage` only, never in URLs or persistent local storage, and contains no embedded credentials.

## First-admin bootstrap

There is no public signup and no bootstrap HTTP endpoint. The first administrator is created through Cloudflare-account-authenticated operator access to the verified CFLab D1 database, then establishes a password through the normal reset-token machinery.

1. Check that no active administrator already exists:

   ```sh
   npx wrangler d1 execute DB --remote --config wrangler.jsonc \
     --command "SELECT COUNT(*) AS active_admins FROM users WHERE is_admin = 1 AND active = 1"
   ```

   If the count is nonzero, stop and use the admin UI instead.

2. Insert the admin identity without a password, plus a single-use setup token whose hash (never the raw token) is stored:

   ```sh
   EMAIL='operator-supplied@example.com'          # never guessed; ask the operator
   USER_ID=$(uuidgen | tr 'A-Z' 'a-z')
   TOKEN_ID=$(uuidgen | tr 'A-Z' 'a-z')
   TOKEN="cflr_$(openssl rand -hex 32)"
   HASH=$(printf '%s' "$TOKEN" | shasum -a 256 | awk '{print $1}')   # sha256sum on Linux
   NOW=$(date -u +%Y-%m-%dT%H:%M:%S.000Z)
   EXPIRES=$(date -u -v+30M +%Y-%m-%dT%H:%M:%S.000Z)                 # GNU: date -u -d '+30 minutes' ...
   npx wrangler d1 execute DB --remote --config wrangler.jsonc --command "
   INSERT INTO users (id,email,password_hash,active,is_admin,created_at,updated_at)
     VALUES ('$USER_ID','$EMAIL',NULL,1,1,'$NOW','$NOW');
   INSERT INTO password_reset_tokens (id,user_id,token_hash,created_at,expires_at)
     VALUES ('$TOKEN_ID','$USER_ID','$HASH','$NOW','$EXPIRES');
   "
   ```

3. Open `https://cflab.aismallbizguru.com/reset-password?token=$TOKEN` immediately, choose a password, and log in. The token is single-use and expires in 30 minutes; do not paste it into logs or tickets. Once email delivery is configured, later setups can use `POST /api/admin/users/:id/send-password-setup` or `/forgot-password` instead of direct D1 access.

## Rate limiting

Cloudflare's native Workers rate-limiting bindings protect the credential endpoints:

| Binding | Route | Default |
| --- | --- | --- |
| `RL_LOGIN` | `POST /api/auth/login` | 10 per 60 s |
| `RL_RECOVERY` | `POST /api/auth/forgot-password` | 5 per 60 s |
| `RL_RESET` | `POST /api/auth/reset-password` | 10 per 60 s |

Keys are `route + SHA-256(normalized email or reset token)`, so raw addresses and tokens never enter the limiter. Limits are per key and short-lived; there is no account lockout, so an attacker cannot permanently lock a user out. A rejected request returns `429 rate_limited`.

## Security assumptions and logging

CORS for `/api/auth/*` allows only the same origin or origins already registered for active apps, and never emits `*`; CORS is browser hygiene, not authorization. Membership checks always run after the session is verified. Sessions are bearer credentials: a browser that holds one can use it, so clients must not share or embed them, and server logs never contain `Authorization` values, passwords, hashes, reset tokens, or session tokens. Authentication logs record only event, outcome, and user id. There is no MFA in this version; the `users` table and session flow leave room to add a second factor without schema replacement.
