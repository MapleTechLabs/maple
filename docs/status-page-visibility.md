# Status page visibility

A status page is `public`, `password` or `internal` (`status_pages.visibility`). Changing it,
and setting or removing the page password, needs `status_pages:access` (engineers and admins) and is
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
  posted password (POST). Two limits, both failing closed: 10 a minute per client and page
  (`access:<client>:<page>` on the break-glass limiter, where an IPv6 client is its /64), then
  100 a minute per page across every client (`access:<page>` on
  `STATUS_PAGE_ACCESS_RATE_LIMITER`). Every other path, `/_manage` and the feeds included, needs
  the cookie: `/` answers 401 with the form, anything else 401 text. Every response of a
  password page is `cache-control: private, no-store` and `x-robots-tag: noindex`.
- **Page**: no subscribe link or dialog, no feed links, `noindex` (the same for an internal
  page's in-app view). Feed readers and Slack cannot sign in.

## Internal pages

- The publisher takes an internal page off the edge on its next publish: the slug route (while
  it still names the page) and the snapshot. Each KV key is deleted and its R2 object becomes a
  tombstone (`STATUS_PAGE_TOMBSTONE`, `{"gone":true}`), written before the KV delete. Break-glass
  entries stay for the reconciler. `published_hash` is cleared, so making the page public again
  writes it even if nothing else changed, over the tombstones. Deleting the page removes them.
  Internal pages are left out of the 15-minute stale republish.
- The status Worker reads a tombstone in R2 as "not found" for certain: 404 on every route,
  and the tombstone replaces the colo's cached copy, so it never falls back to a snapshot cached
  while the page was public. A missing R2 object still falls back to the cache, because that is
  what an outage looks like.
- The status Worker also answers 404 for any snapshot it still finds that says `internal`.
- Members read the page at `/status-pages/<id>/view`: `GET /v2/status_pages/{id}/view`
  (`status_pages:read`) builds the snapshot from Postgres now, credentials stripped, and the
  dashboard renders it in the same sandboxed frame as the editor preview.

## Known gaps

- A colo serves a snapshot from its cache for up to 30 seconds, so a password change or an
  unpublish takes that long to reach every visitor; a colo whose KV and R2 both fail serves
  its last cached copy, unless it already read the page's tombstone.
- A deleted page leaves no tombstone (its edge data is removed outright), so a colo that cached
  it can still serve that copy while KV fails, for as long as the cache keeps it (7 days).
- The form shows the page's name, logo, theme and description.
