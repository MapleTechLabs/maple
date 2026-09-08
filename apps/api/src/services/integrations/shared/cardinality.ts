/**
 * Attribute-cardinality folding for integration pollers.
 *
 * Every provider hands back at least one unbounded dimension — hostnames, WAF rule ids, DNS
 * query names, GA4 page paths — and `Attributes` sits in the metrics tables' sorting key, so an
 * uncapped dimension bloats it and degrades every read of that metric, not just the breakdown.
 * The fix is the same everywhere: keep the N heaviest values across the window and fold the tail
 * into one explicit {@link OTHER_BUCKET} series, so the total still reconciles.
 *
 * Shared by the Cloudflare edge-analytics mapper and the Google Analytics collector.
 */

/** The folded tail. One series, so a breakdown's parts still sum to the unbroken total. */
export const OTHER_BUCKET = "other"

/** Top-N keys by weight; ties break lexicographically so folding is deterministic across runs. */
export const topNKeys = (weights: ReadonlyMap<string, number>, n: number): ReadonlySet<string> =>
	new Set(
		[...weights.entries()]
			.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
			.slice(0, n)
			.map(([key]) => key),
	)

/** Weight-rank an unbounded dimension across a window and fold the tail into {@link OTHER_BUCKET}. */
export const foldTail = (weights: ReadonlyMap<string, number>, n: number): ((key: string) => string) => {
	const top = topNKeys(weights, n)
	return (key) => (top.has(key) ? key : OTHER_BUCKET)
}
