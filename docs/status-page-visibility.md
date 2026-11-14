# Status page visibility

A status page is `public`, `password` or `internal` (`status_pages.visibility`). Changing it,
and setting or removing the page password, needs `status_pages:access` (org admins) and is
audited (`status_page.updated` / `config_applied` with the field, `status_page.password_set`,
`status_page.password_removed`).

| Visibility | Who reads it | At the edge |
| --- | --- | --- |
| `public` | Anyone | Everything, as before |
| `password` | Visitors who enter the page password | Only the password form until they do |
| `internal` | Signed-in org members, in Maple | Nothing: 404 on the Maple address and any custom domain |

`visibility` is in `V2StatusPage`, `PATCH /v2/status_pages/{id}` and the config document
(`PUT …/config`, MCP `apply_status_page_config`). A config without it keeps the page's
current visibility, so no document opens a page by default. The password itself only goes
through `PUT /v2/status_pages/{id}/password` (8 to 256 characters) and
`DELETE …/password`; reads say `has_password`, nothing more.

Rules, checked under the page's row lock: `password` needs a password set; a `password` page
cannot drop its password; `internal` cannot have a custom domain (remove it first, and a
domain cannot be added to an internal page).

## Password pages

- **Hash**: `status_pages.password_hash` holds
  `pbkdf2-sha256$100000$<salt>$<key>` (16-byte random salt, 32-byte key, base64url;
  `packages/domain/src/status-page-access.ts`). 100,000 iterations is the most Workers'
  WebCrypto allows. One-way, so it is not a sealed column (`secret-encryption.md`).
- **Publishing**: the snapshot's `passwordHash` carries the hash while the page is `password`,
  null otherwise. Snapshots live in KV and R2, which only the status Worker reads; no renderer
  output (`status.json`, feeds, badge, HTML) includes it, and `GET …/view` and the preview
  return it as null.
- **Cookie**: `maple_status_access=<expires at ms>.<signature>`, where the signature is
  HMAC-SHA256 keyed by the stored hash over `maple/status-page/access/v1|<page id>|<expires>`.
  `HttpOnly; Secure; SameSite=Lax; Max-Age=2592000`, host-only, `Path` the page's base path
  (`/` on a custom domain, `/s/<slug>` on Maple's host). A new password has a new salt, so every
  cookie signed under the old hash stops verifying. A value expiring more than 30 days out is
  refused even with a valid signature.
- **Gate** (`apps/status/src/access.ts`): `/_access` serves the branded form (GET) and checks a
  posted password (POST), rate-limited per `access:<ip>:<page>` on the break-glass limiter
  (10 a minute) and failing closed. Every other path, `/_manage` and the feeds included, needs
  the cookie: `/` answers 401 with the form, anything else 401 text. Every response of a
  password page is `cache-control: private, no-store` and `x-robots-tag: noindex`.
- **Page**: no subscribe link or dialog, no feed links, `noindex` (the same for an internal
  page's in-app view). Feed readers and Slack cannot sign in.

## Internal pages

- The publisher takes an internal page off the edge on its next publish: the slug route (while
  it still names the page) and the snapshot in KV and R2. Break-glass entries stay for the
  reconciler. `published_hash` is cleared, so making the page public again writes it even if
  nothing else changed. Internal pages are left out of the 15-minute stale republish.
- The status Worker also answers 404 for any snapshot it still finds that says `internal`.
- Members read the page at `/status-pages/<id>/view`: `GET /v2/status_pages/{id}/view`
  (`status_pages:read`) builds the snapshot from Postgres now, credentials stripped, and the
  dashboard renders it in the same sandboxed frame as the editor preview.

## Known gaps

- A colo serves a snapshot from its cache for up to 30 seconds, so a password change or an
  unpublish takes that long to reach every visitor; a colo whose KV and R2 both fail serves
  its last cached copy.
- The form shows the page's name, logo, theme and description.
