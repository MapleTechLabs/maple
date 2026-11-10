// The leased row every integration poller claims per tick: a claim writes `now + lease` into a
// nullable epoch-ms column, and every later write compares-and-sets on the value it wrote.
//
// Corrupt-lease escape hatches are per poller and deliberately not normalized (2026-11):
// Cloudflare, Search Console and Supabase insights reclaim past `2 * LEASE_MS`; Railway past
// `2 * BILLING_HOLD_MS`; Supabase discovery past 2 hours; Supabase logs past
// `REFUSED_HOLD_MS + LEASE_MS`. AWS checks, GCP metrics and PlanetScale poll state have none.

import * as PG from "@maple-dev/effect-orm/postgres"

/**
 * Free to claim: no lease, or an expired one. With `corruptBeyondMs`, a lease further than that
 * ahead of `now` is also reclaimed: no live tick writes one, so it is a clock jump or a crashed writer.
 */
export const leaseClaimable = <P>(
	leaseUntil: PG.Expr<number | null, P>,
	now: number,
	corruptBeyondMs?: number,
) =>
	corruptBeyondMs === undefined
		? PG.or(leaseUntil.isNull(), leaseUntil.lt(now))
		: PG.or(leaseUntil.isNull(), leaseUntil.lt(now), leaseUntil.gt(now + corruptBeyondMs))

/** Still the lease this tick's claim wrote, so a tick that outlived it never touches a successor's. */
export const leaseStillOurs = <P>(leaseUntil: PG.Expr<number | null, P>, claimedUntil: number | null) =>
	claimedUntil === null ? leaseUntil.isNull() : leaseUntil.eq(claimedUntil)
