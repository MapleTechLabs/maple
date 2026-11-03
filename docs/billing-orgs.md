# Billing orgs

A customer with several organizations can pay for all of them on one plan and one invoice. One
org is the **billing org**; the others are **members** billed through it. Each member keeps its own
data, members, dashboards and alerts. Only billing moves.

## Model

- `org_billing_links` (Postgres, `packages/db/src/tables/billing-links.ts`): one row per member,
  `org_id` (the member) to `billing_org_id` (the org that pays). One level deep: a billing org is
  never itself a member, and a member never pays for others.
- An org with no row bills as itself. That is every org until someone links one.
- Every Autumn call takes a `BillingCustomerId` (`@maple/domain/http`), never a raw org id. It comes
  from `BillingCustomerResolver.customerFor(orgId)` (the billing org's customer, cached 60s at the
  edge), `requireOwnBilling(orgId)` (billing writes; a member gets `BillingManagedByBillingOrgError`, 409) or `ownBillingCustomer(orgId)` (questions about the org itself, such as its plan history).
- The ingest gateway resolves the same table (`apps/ingest/src/autumn.rs`, `BillingOrgResolver`,
  60s cache, last-known answer on a failed or slow read) when it flushes usage and when it checks
  entitlements. An org it has never resolved keeps its usage for the next flush and fails the
  entitlement check open while Postgres is unreachable.

What a member gets from its billing org: the plan and its allowances, usage pool, spend limits and
usage alerts, AI credits, uptime monitor allowance, add-ons such as the OpenRouter key. All of it is
pooled; there are no per-member caps.

## Enabling it for a customer

Pooling allowances across orgs is a pricing decision, so linking is gated on the billing org's
Autumn customer holding the boolean feature `billing_sub_orgs` (`apps/api/autumn.config.ts`).

1. Push the feature once: `bun run --cwd apps/api atmn push`.
2. In the Autumn dashboard, grant `billing_sub_orgs` to the billing org's customer (its plan, or a
   customized plan for that customer). The customer id is the Maple org id.
3. An admin of both orgs opens **Settings, Billing** in the member org and picks the billing org.

The link endpoint (`POST /internal/billing/account/link`, called from the member) checks that the
caller is an admin of both orgs, that both are in the same data region, and the one-level rule.

## What linking does

- The member's own plans are cancelled inside the link's transaction, under the link lock, in one
  Autumn request (`billing.multi_update`): a running plan at the end of the period it already paid
  for, a scheduled one (a downgrade booked earlier) before it starts. An auto-enabled free plan is
  left alone. The link commits only after that request succeeds, so a failed cancel leaves no link.
  Usage from before the link stays on the member's final invoice; usage after it is the billing
  org's. A retried link skips plans already cancelled, and a concurrent one waits on the lock.
- The `billing.updated` webhooks for those cancellations post no cancellation review and emit no
  plan events: billing moved, the customer did not churn. The webhook reads the link under the
  link lock, so it waits for the link to commit before deciding.
- The member's uptime monitor count moves to the billing org's customer (continuous-use meter),
  sent only by the call that writes the link, so a repeated link moves nothing. The monitor cap counts the whole pool: the billing
  org's monitors and every member's.
- A billing org's daily spend chart sums its members; `GET /internal/billing/account/usage` gives
  the per-org split from the warehouse.

Unlinking (`DELETE /internal/billing/account/members/:orgId`, by the member or the billing org)
moves the monitor count back. A plan the member had before linking runs to the end of the period it
was cancelled at; after that the member has no plan and goes through checkout like a new org.

A billing org cannot be deleted while it has members; a member's link is purged with the member.

## Known limits

- A link takes up to 60s to reach every colo and the ingest gateway (both caches).
- Plan webhooks (`billing.updated`) carry the billing org's id, so plan events land on it.
- The uptime monitor move is fire-and-forget like every usage track: if Autumn drops one half, the
  counts drift until reconciled by hand. It runs after the commit, so an invocation that dies in
  between leaves the count where it was; nothing finishes it later.
- The cancel request can time out after Autumn applied it (the link waits 10s, holding the link
  lock). The org is then unlinked with its plans ending; linking again finishes the job.
- An org deleted while someone links it, or links to it, can leave a link row to a deleted org.
  The delete checks and removes links under the lock, but the rest of its purge does not.
- An org unlinked before its own cancelled plan ends gets a cancellation review when that plan
  expires: the webhook sees no link by then and reads it as churn.
- A checkout started before linking and paid after it activates a plan on the member's own
  customer. Nothing cancels it, and the webhook ignores plan changes on linked customers.
- Links never span regions: usage meters and Postgres rows are per region.
- Unverified against Autumn: with a downgrade booked, the current plan is already cancelled and is
  skipped, and the scheduled plan is cancelled immediately. If Autumn answers that by un-cancelling
  the current plan, it would renew on the member's card. Check the member's customer after the
  first such link.
