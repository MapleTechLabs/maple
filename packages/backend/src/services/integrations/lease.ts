// The leased row every integration poller claims per tick: a claim writes `now + lease` into a
// nullable epoch-ms column, and every later write compares-and-sets on the value it wrote.
//
// `withLease` (./poller) keeps a failed tick's back-off in its own hold column, so one corrupt
// bound fits every poller on it: twice its lease. Railway, PlanetScale, Google Cloud, Vercel and
// Supabase use it; the pollers not on it yet still pass their own bound here, or none.

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
