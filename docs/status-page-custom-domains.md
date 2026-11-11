# Status page custom domains

A status page can be served on a customer's own subdomain (`status.acme.com`) through
Cloudflare for SaaS on the `maple.dev` zone. The customer adds a CNAME; Cloudflare validates
the hostname and issues its certificate; the page then answers there with every route it has
on its Maple address (`/feed.atom`, `/feed.rss`, `/api/v1/status.json`, `/api/v1/uptime.json`,
`/badge.svg`, `/_manage`; see `status-page-public-api.md`).

## How a request reaches the page

1. The customer's CNAME points `status.acme.com` at `status-domains.maple.dev`, an originless
   proxied record (`AAAA 100::`) that is also the zone's fallback origin.
2. Each custom hostname has its own Worker route, `status.acme.com/*`, to its stage's status
   Worker (`maple-status`, `maple-status-pr-<n>`, ...). The route runs before origin
   resolution, so the fallback origin is never contacted. Per-hostname routes, not `*/*`: a
   wildcard would also take `maple.dev` hostnames that have no Worker of their own (ingest).
3. The status Worker looks the hostname up (`host:<hostname>` in KV, `hosts/<hostname>` in
   R2). Only Maple's own hosts (the stage's status domain, `*.workers.dev`, local dev) also
   serve `/s/<slug>`; any other host with no route is a 404, so one customer's domain never
   serves another customer's page.

## Lifecycle

| Step | Where |
| --- | --- |
| Set (`PUT /v2/status_pages/{id}/custom_domain`) | Row in `status_page_custom_domains` first, then the Cloudflare hostname (DV, HTTP validation) and its Worker route. A Cloudflare outage only delays it. |
| Check | The alerting minute tick, before the publish sweep: every minute for the first hour, every 10 minutes after, every 6 hours once active or failed. `POST .../custom_domain/check` checks now and asks Cloudflare to retry validation. |
| Active | Hostname and certificate both active. The page's revision is bumped; the publisher writes the snapshot (which names the domain) and the `host:` route. Feeds, `status.json` (`page.status_url`), the Slack command and the dashboard's links then use `https://<domain>`. |
| Remove, replace, page or org deletion | A `status_page_cleanups` row carries the hostname and Cloudflare ids; the publisher's sweep deletes the Worker route, the custom hostname and the edge route, keeping anything a live page has claimed since. |

`status` is `pending_dns`, `pending_ssl`, `active` or `failed` (see `customDomainProgress`).
An active domain stays active through a pending re-check (certificate renewal); only a failure
takes it down. The DNS records shown to the customer are the CNAME, the
`_cf-custom-hostname` ownership TXT until the hostname is verified (optional with the CNAME
in place), and certificate TXTs only if Cloudflare asks for them.

Hostnames are validated at the API boundary (`customDomainIssue`): a subdomain (an apex
cannot CNAME), no IPs, no `maple.dev`, `workers.dev` or other reserved names. One domain per
page, unique across orgs. An internal page has no custom domain (`status-page-visibility.md`).

## Operator setup

Done once per zone, by hand:

1. In the Cloudflare dashboard, enable Cloudflare for SaaS on `maple.dev` (SSL/TLS, Custom
   Hostnames, Enable). It is billed per hostname past the free allowance.
2. Create an API token scoped to the `maple.dev` zone with **SSL and Certificates: Edit** and
   **Workers Routes: Edit**.
3. In Infisical (`prod`, and `preview` for PR previews) set `MAPLE_STATUS_DOMAINS_ZONE_ID` (the zone id)
   and `MAPLE_STATUS_DOMAINS_API_TOKEN` (the token).
4. Deploy US prd. It declares `status-domains.maple.dev` and sets it as the fallback origin
   (`declareStatusDomainsOrigin`, `packages/infra/src/cloudflare/status-pages.ts`). The
   fallback origin takes a few minutes to become active.

Every stage whose api, alerting and maple-ai Workers carry both variables offers custom
domains; the rest (local dev by default) say "custom domains unavailable". Previews share the
zone and its fallback origin with prd, and route their hostnames to their own status Worker.
The zone holds each hostname once, so a hostname used by prd cannot be added on a preview.

## Known gaps

- A closed PR preview leaves its custom hostnames and routes on the zone (its database goes,
  so nothing drains them). Delete them in the dashboard, or by listing routes whose script is
  `maple-status-pr-<n>`.
- The domain is not part of the config document (`GET/PUT .../config`, MCP
  `apply_status_page_config`): it has its own asynchronous lifecycle and failure modes.
