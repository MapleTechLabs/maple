import { Schema } from "effect"

/** ISO-8601 UTC timestamp on the v2 wire (e.g. `2026-07-15T12:34:56.000Z`). */
const ISO_8601_UTC_PATTERN = /^\d{4}-\d{2}-\d{2}T.+(?:Z|[+-]00:00)$/

export const Timestamp = Schema.String.pipe(
	Schema.check(
		Schema.makeFilter((value) => ISO_8601_UTC_PATTERN.test(value) && Number.isFinite(Date.parse(value)), {
			description: "Expected an ISO-8601 UTC timestamp",
		}),
	),
	Schema.annotate({
		title: "Timestamp",
		description: "ISO-8601 UTC timestamp, e.g. `2026-07-15T12:34:56.000Z`.",
		examples: ["2026-07-15T12:34:56.000Z"],
		format: "date-time",
	}),
)
export type Timestamp = Schema.Schema.Type<typeof Timestamp>
