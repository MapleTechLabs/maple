// Shared vocabulary for the Cloudflare infra pages: chart bucketing plus the
// fixed color mappings for HTTP status classes and cache statuses, so the same
// status never renders in two hues on one page.

/**
 * The pooled tail of a high-cardinality breakdown. Both the poller (its per-window top-N tail) and
 * the API (every key outside the chart's top-N) write this same key, so the stack still totals to
 * the zone's attributed traffic and the legend carries exactly one "everything else" series.
 * Mirrors `CLOUDFLARE_BREAKDOWN_OTHER_KEY` in the query engine.
 */
export const BREAKDOWN_OTHER_KEY = "other"
export const BREAKDOWN_OTHER_LABEL = "Other"

// Status classes carry severity; cache statuses shade from "answered at the
// edge" (primary) to "went to origin" (muted). Both are fixed, meaningful
// mappings — not palette-by-index.

export const STATUS_CLASS_COLORS: Record<string, string> = {
	// 1xx is informational chatter, not a real response — a faded take on the 2xx hue.
	"1xx": "color-mix(in oklab, var(--severity-info) 50%, transparent)",
	"2xx": "var(--severity-info)",
	"3xx": "var(--chart-2)",
	"4xx": "var(--severity-warn)",
	"5xx": "var(--severity-error)",
	unknown: "color-mix(in oklab, var(--muted-foreground) 55%, transparent)",
} satisfies Record<string, string>

/** Cache statuses the edge answered without touching origin, strongest first. */
export const EDGE_SERVED_STATUSES: ReadonlyArray<{ status: string; label: string; color: string }> = [
	{ status: "hit", label: "Hit", color: "var(--primary)" },
	{ status: "stale", label: "Stale", color: "color-mix(in oklab, var(--primary) 70%, transparent)" },
	{
		status: "revalidated",
		label: "Revalidated",
		color: "color-mix(in oklab, var(--primary) 50%, transparent)",
	},
	{
		status: "updating",
		label: "Updating",
		color: "color-mix(in oklab, var(--primary) 35%, transparent)",
	},
]

export const CACHE_STATUS_COLORS: Record<string, string> = {
	...Object.fromEntries(EDGE_SERVED_STATUSES.map((s) => [s.status, s.color])),
	miss: "var(--chart-3)",
	expired: "var(--chart-4)",
	// Deliberately-uncached traffic (bypass/dynamic/none) shades down a single
	// muted ramp — it all reads as "went to origin, by design".
	bypass: "color-mix(in oklab, var(--muted-foreground) 60%, transparent)",
	dynamic: "color-mix(in oklab, var(--muted-foreground) 45%, transparent)",
	none: "color-mix(in oklab, var(--muted-foreground) 35%, transparent)",
	unknown: "color-mix(in oklab, var(--muted-foreground) 25%, transparent)",
} satisfies Record<string, string>
