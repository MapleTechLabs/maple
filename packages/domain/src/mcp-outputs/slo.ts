import { Schema } from "effect"

// ---------------------------------------------------------------------------------------------
// list_slos / inspect_slo / create_slo / update_slo / delete_slo

export const SloSliKind = Schema.Literals(["availability", "latency"])
export const SloBurnSeverity = Schema.Literals(["critical", "warning"])

/** The SLO's burn-rate alert: on or off, who each tier notifies, and the rule behind it. */
export const SloAlertingRow = Schema.Struct({
	enabled: Schema.Boolean,
	/** The hidden `slo_burn_rate` alert rule; null for an SLO saved before burn alerts. */
	alertRuleId: Schema.NullOr(Schema.String),
	criticalDestinationIds: Schema.Array(Schema.String),
	warningDestinationIds: Schema.Array(Schema.String),
})

export const SloConfigRow = Schema.Struct({
	id: Schema.String,
	name: Schema.String,
	description: Schema.NullOr(Schema.String),
	serviceName: Schema.String,
	/** Empty: every environment. */
	environments: Schema.Array(Schema.String),
	sliKind: SloSliKind,
	/** Latency SLIs only: a span is good when faster than this. */
	latencyThresholdMs: Schema.NullOr(Schema.Number),
	targetPercent: Schema.Number,
	windowDays: Schema.Number,
	alerting: SloAlertingRow,
	createdAt: Schema.String,
	updatedAt: Schema.String,
})

/** An SLO with where it stands now; the status fields are null when the warehouse read failed. */
export const SloListRow = Schema.Struct({
	...SloConfigRow.fields,
	/** Good share over the SLO window, 0 to 1; null without events or when the read failed. */
	sli: Schema.NullOr(Schema.Number),
	/** Share of the window's error budget left: 1 untouched, negative when overspent. */
	budgetRemaining: Schema.NullOr(Schema.Number),
	/** The highest burn rate across the 5m, 30m, 1h and 6h windows. */
	worstBurnRate: Schema.NullOr(Schema.Number),
	worstBurnWindow: Schema.NullOr(Schema.String),
	/** The highest alert tier whose long and short windows both burn past its factor. */
	burning: Schema.NullOr(SloBurnSeverity),
	statusError: Schema.NullOr(Schema.String),
})

export const ListSlosOutput = Schema.Struct({
	slos: Schema.Array(SloListRow),
	total: Schema.Number,
	serviceFilter: Schema.optionalKey(Schema.String),
})

export const SloBurnWindowRow = Schema.Struct({
	/** `5m`, `30m`, `1h` or `6h`. */
	window: Schema.String,
	windowMinutes: Schema.Number,
	total: Schema.Number,
	good: Schema.Number,
	/** 1 spends exactly the budget over the SLO window; 0 when the window saw no events. */
	burnRate: Schema.Number,
})

export const SloBurnTierRow = Schema.Struct({
	severity: SloBurnSeverity,
	factor: Schema.Number,
	longWindow: Schema.String,
	shortWindow: Schema.String,
	breached: Schema.Boolean,
})

export const SloStatusRow = Schema.Struct({
	asOf: Schema.String,
	total: Schema.Number,
	good: Schema.Number,
	sli: Schema.NullOr(Schema.Number),
	budgetRemaining: Schema.Number,
	burnWindows: Schema.Array(SloBurnWindowRow),
	tiers: Schema.Array(SloBurnTierRow),
})

export const InspectSloOutput = Schema.Struct({
	slo: SloConfigRow,
	status: SloStatusRow,
})

export const SloMutationOutput = Schema.Struct({
	action: Schema.Literals(["created", "updated"]),
	slo: SloConfigRow,
})

export const DeleteSloOutput = Schema.Struct({
	deleted: Schema.Boolean,
	id: Schema.String,
	name: Schema.String,
})
