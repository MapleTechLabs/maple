# Status page custom domains

A status page can be served on a customer's own subdomain (`status.acme.com`) through
Cloudflare for SaaS on the `maple.dev` zone. The customer adds a CNAME and an ownership TXT
record; once Maple finds the TXT, Cloudflare validates the hostname and issues its certificate;
the page then answers there with every route it has
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

## Ownership proof

The CNAME alone proves nothing about who is claiming: Cloudflare validates over HTTP through it,
and it may still be in DNS from an earlier claim. So a claim creates nothing at Cloudflare until
its TXT record is found:

- Name `_maple-challenge.<hostname>`, value `maple-status-page=<hex>`, the first 16 bytes of
  SHA-256 over `orgId + "\n" + pageId + "\n" + hostname` (`customDomainOwnershipRecord`). It
  needs no secret and no storage: only the zone's owner can publish it, and a value published
  for one organization's page verifies no other claim.
- The lookup is DNS over HTTPS (`DnsTxtResolver`). A failed lookup is "not found yet", with the
  reason in `last_error`; the next check asks again.
- A row with nothing at Cloudflare and never active is waiting for the record: `pending_dns`,
  no `cloudflare_hostname_id`, the CNAME and the TXT in `dns_records`. There is no column for it.
- A row that already has a Cloudflare hostname id, or is active, was added before the rule (or
  has passed it) and is never asked for the record. The record can go once the domain is active.
- A claim that has not passed does not hold the hostname from its owner. Setting a hostname
  held by such a claim looks the caller's own record up at once: found, the old claim is dropped
  (cleanup row as for any removal) and the caller's proceeds; not found, the answer is
  `status_page_custom_domain_taken` with the record to publish in its message. A hostname held
  by a claim that passed, or by an active domain, stays taken.

## Lifecycle

| Step                                            | Where                                                                                                                                                                                                                                                                                                                                                                                |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Set (`PUT /v2/status_pages/{id}/custom_domain`) | Row in `status_page_custom_domains`, waiting for its ownership record. If the record is already published, the Cloudflare hostname (DV, HTTP validation) and its Worker route follow in the same call.                                                                                                                                                                               |
| Check                                           | The alerting minute tick, before the publish sweep: every minute for the first hour, every 10 minutes after, every 6 hours once active or failed. A claim still waiting gets its TXT looked up; once found, the Cloudflare hostname and route are created (a Cloudflare outage only delays that). `POST .../custom_domain/check` checks now and asks Cloudflare to retry validation. |
| Active                                          | Hostname and certificate both active. The page's revision is bumped; the publisher writes the snapshot (which names the domain) and the `host:` route. Feeds, `status.json` (`page.status_url`), the Slack command and the dashboard's links then use `https://<domain>`.                                                                                                            |
| Expire                                          | A domain that has not gone active within 7 days of being added is removed (as below), so stale claims do not pile up.                                                                                                                                                                                                                                                                |
| Remove, replace, page or org deletion           | A `status_page_cleanups` row carries the hostname and Cloudflare ids; the publisher's sweep deletes the Worker route, the custom hostname and the edge route, keeping anything a live page has claimed since. A domain added back before the sweep takes its queued Cloudflare hostname over only when the cleanup row is the same organization's.                                   |

`status` is `pending_dns`, `pending_ssl`, `active` or `failed` (see `customDomainProgress`).
An active domain stays active through a pending re-check (certificate renewal); only a failure
takes it down. The DNS records shown to the customer are the CNAME and the `_maple-challenge`
ownership TXT while the claim waits for it; after that the CNAME, Cloudflare's
`_cf-custom-hostname` TXT until the hostname is verified (optional with the CNAME in place),
and certificate TXTs only if Cloudflare asks for them.

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
- Domains added before the ownership rule keep their Cloudflare hostname without a record,
  pending ones included; those expire after 7 days like any claim that never goes active.
- A hostname longer than 236 characters is refused: its `_maple-challenge` name would not fit
  in DNS.
- The domain is not part of the config document (`GET/PUT .../config`, MCP
  `apply_status_page_config`): it has its own asynchronous lifecycle and failure modes.
