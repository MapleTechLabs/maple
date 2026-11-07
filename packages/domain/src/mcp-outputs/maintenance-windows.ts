/** Output schemas for the maintenance window MCP tools. */
import { Schema } from "effect"

const MatcherValues = Schema.optionalKey(Schema.Array(Schema.String))

export const MaintenanceWindowMatchersRow = Schema.Struct({
	ruleIds: MatcherValues,
	tags: MatcherValues,
	services: MatcherValues,
	environments: MatcherValues,
})

/** `once` carries startsAt/endsAt; `weekly` carries timeZone, days, startTime and durationMinutes. */
export const MaintenanceScheduleRow = Schema.Struct({
	type: Schema.String,
	startsAt: Schema.optionalKey(Schema.String),
	endsAt: Schema.optionalKey(Schema.String),
	timeZone: Schema.optionalKey(Schema.String),
	days: Schema.optionalKey(Schema.Array(Schema.String)),
	startTime: Schema.optionalKey(Schema.String),
	durationMinutes: Schema.optionalKey(Schema.Number),
})

export const MaintenanceWindowRow = Schema.Struct({
	id: Schema.String,
	name: Schema.String,
	reason: Schema.NullOr(Schema.String),
	matchers: MaintenanceWindowMatchersRow,
	schedule: MaintenanceScheduleRow,
	excludeFromBaselines: Schema.Boolean,
	enabled: Schema.Boolean,
	/** The occurrence running now, else the next one. */
	nextOccurrence: Schema.NullOr(Schema.Struct({ startsAt: Schema.String, endsAt: Schema.String })),
	createdBy: Schema.String,
})

export const ListMaintenanceWindowsOutput = Schema.Struct({
	windows: Schema.Array(MaintenanceWindowRow),
	total: Schema.Number,
	limit: Schema.Number,
	offset: Schema.Number,
	hasMore: Schema.Boolean,
})

export const MaintenanceWindowMutationOutput = Schema.Struct({ window: MaintenanceWindowRow })

export const DeleteMaintenanceWindowOutput = Schema.Struct({ id: Schema.String, name: Schema.String })
