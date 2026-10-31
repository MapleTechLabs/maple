import type { StatusPageComponentStatus } from "@maple/domain/primitives"

/** The glyph drawn on the status disc: check, dash, bang, cross, or a clock hand for maintenance. */
const GLYPH = {
	operational: "M5 8.2l2 2 4-4.4",
	degraded: "M5 8h6",
	partial_outage: "M8 4.6v4.2M8 11.2v.2",
	major_outage: "M5.6 5.6l4.8 4.8M10.4 5.6l-4.8 4.8",
	maintenance: "M8 4.8V8l2.2 1.4",
} as const satisfies Record<StatusPageComponentStatus, string>

/** A filled status disc in the status colour; decorative, so the text beside it carries the meaning. */
export const statusIcon = (status: StatusPageComponentStatus): string =>
	`<svg class="ico s-${status}" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false"><circle cx="8" cy="8" r="8"/><path d="${GLYPH[status]}"/></svg>`

/** A chevron for the pager buttons. */
export const chevron = (direction: "left" | "right"): string =>
	`<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false"><path d="${direction === "left" ? "M10 3.5 5.5 8l4.5 4.5" : "M6 3.5 10.5 8 6 12.5"}"/></svg>`
