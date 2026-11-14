import type { HeadroomTone } from "@maple/web-data/alerts/overview-derive"

// How a reading against its threshold is coloured. The rules table and the Inbox both pick the
// tone with `headroomTone`, so the same rule never reads calm on one and alarming on the other.

/** A headroom bar's fill. */
export const HEADROOM_FILL = {
	neutral: "bg-foreground-faint",
	warning: "bg-severity-warn",
	error: "bg-severity-error",
} as const satisfies Record<HeadroomTone, string>

/** The reading's own text colour; a neutral one keeps its row's. */
export const HEADROOM_TEXT = {
	neutral: undefined,
	warning: "text-severity-warn",
	error: "text-severity-error",
} as const satisfies Record<HeadroomTone, string | undefined>
