/**
 * The telemetry evidence section: what the org sent, how it was set up, and how
 * it used Maple, read from the warehouse. `recent` is the 30 days up to the
 * cancellation, `prior` the 30 before that. Each field is `null` when it could
 * not be read; zero or empty means it was read and nothing was there.
 */
import { Schema } from "effect"

/** A count or a number of days: a whole number, never negative. */
const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
/** Whole days before the cancellation; negative after it. */
const DaysBeforeCancel = Schema.Int
/** A volume in GB: finite, never negative. */
const Volume = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0))
/** A fraction from 0 to 1. */
const Share = Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 1 }))

/** Billable GB per signal over one 30-day window, as the plan meters it. */
export const CancellationSignalVolume = Schema.Struct({
	tracesGB: Volume,
	logsGB: Volume,
	metricsGB: Volume,
})
export type CancellationSignalVolume = Schema.Schema.Type<typeof CancellationSignalVolume>

/** One service, by its OpenTelemetry `service.name`, over the 60 days before the cancellation. */
export const CancellationServiceUsage = Schema.Struct({
	/** `service.name`, cut to 80 characters. */
	name: Schema.String,
	recent: CancellationSignalVolume,
	prior: CancellationSignalVolume,
	/** The first hour it sent anything within the 60 days (so at most 60 even if it is older). */
	firstSeenDaysBeforeCancel: DaysBeforeCancel,
	/** The last hour it sent anything within the 60 days. */
	lastSeenDaysBeforeCancel: DaysBeforeCancel,
	/** Days in `recent` on which it sent anything. */
	activeDaysRecent: Count,
	/** Days in `prior` on which it sent anything. */
	activeDaysPrior: Count,
})
export type CancellationServiceUsage = Schema.Schema.Type<typeof CancellationServiceUsage>

export const CancellationServices = Schema.Struct({
	/** Services that sent anything in `recent`. */
	distinctRecent: Count,
	/** Services that sent anything in `prior`. */
	distinctPrior: Count,
	/** The 15 largest by billable volume over both windows, largest first. */
	top: Schema.Array(CancellationServiceUsage),
})
export type CancellationServices = Schema.Schema.Type<typeof CancellationServices>

/**
 * Environments and SDKs. `environment` is `deployment.environment.name` and its
 * older spelling `deployment.environment` taken together: a service sets one.
 */
export const CancellationResourceKey = Schema.Literals([
	"environment",
	"telemetry.sdk.language",
	"telemetry.sdk.name",
	"telemetry.sdk.version",
])
export type CancellationResourceKey = Schema.Schema.Type<typeof CancellationResourceKey>

/** One resource attribute over the 60 days' spans; shares are of all spans in that window. */
export const CancellationResourceAttribute = Schema.Struct({
	key: CancellationResourceKey,
	/** Share of spans without this attribute (or with it empty); for `environment`, with neither spelling. */
	notSetShare: Share,
	/** Its 5 most common values, most common first, each cut to 80 characters. */
	values: Schema.Array(Schema.Struct({ value: Schema.String, share: Share })),
})
export type CancellationResourceAttribute = Schema.Schema.Type<typeof CancellationResourceAttribute>

/** The org's alert rule evaluations in `recent`. */
export const CancellationAlertChecks = Schema.Struct({
	checks: Count,
	healthy: Count,
	breached: Count,
	/** Checks that did not evaluate, by why: no data at all, too few samples, no value. */
	skipped: Schema.Struct({
		noData: Count,
		belowMinSamples: Count,
		noValue: Count,
		/** Skipped with no recorded reason (checks from before reasons were stored). */
		unspecified: Count,
	}),
	/** Failed evaluations by error class, most first; up to 10 classes. */
	errors: Schema.Array(Schema.Struct({ category: Schema.String, checks: Count })),
	/** Distinct rules evaluated. */
	rules: Count,
	/** Distinct rules that breached at least once. */
	rulesBreached: Count,
})
export type CancellationAlertChecks = Schema.Schema.Type<typeof CancellationAlertChecks>

/** Errors the org's own services recorded (exceptions and error spans). */
export const CancellationErrorVolume = Schema.Struct({
	/** Error events per 7 days, 8 entries: index 0 is the 7 days up to the cancellation, 7 is 49-56 days before. */
	perWeek: Schema.Array(Count),
	/** Distinct error fingerprints (kinds of error) seen in `recent`. */
	fingerprintsRecent: Count,
	/** Distinct error fingerprints seen in `prior`. */
	fingerprintsPrior: Count,
})
export type CancellationErrorVolume = Schema.Schema.Type<typeof CancellationErrorVolume>

/** One custom or server-side product event Maple's own app recorded for the org (page views excluded). */
export const CancellationProductEvent = Schema.Struct({
	/** The event name, cut to 80 characters. */
	name: Schema.String,
	recent: Count,
	prior: Count,
	/** The last one within the 60 days. */
	lastDaysBeforeCancel: DaysBeforeCancel,
})
export type CancellationProductEvent = Schema.Schema.Type<typeof CancellationProductEvent>

/** Audit-log entries in each window. */
export const CancellationAuditWindows = Schema.Struct({ recent: Count, prior: Count })
export type CancellationAuditWindows = Schema.Schema.Type<typeof CancellationAuditWindows>

/** Every audit-log entry of the org over the 60 days, by who acted. */
export const CancellationAuditActors = Schema.Struct({
	/** People signed in to Maple (the dashboard, or Maple's chat as themselves). */
	users: CancellationAuditWindows,
	/** The org's API keys: its scripts and integrations. */
	apiKeys: CancellationAuditWindows,
	/** AI agents the org connected over MCP, and Maple's chat-platform bot answering the org's people. */
	agents: CancellationAuditWindows,
	/** Maple acting on its own (automatic investigations, internal jobs): not the customer's activity. */
	maple: CancellationAuditWindows,
})
export type CancellationAuditActors = Schema.Schema.Type<typeof CancellationAuditActors>

/**
 * One audit-log action of the org over the 60 days, reads and tool calls
 * included, by its users, API keys and agents (Maple's own automatic actions left out).
 */
export const CancellationAuditAction = Schema.Struct({
	/** Maple's action name, e.g. `dashboard.created`, `mcp_tool.called`, `member.removed`. */
	action: Schema.String,
	recent: Count,
	prior: Count,
	/** Entries over both windows whose outcome was not `allowed` (refused for a missing permission). */
	denied: Count,
})
export type CancellationAuditAction = Schema.Schema.Type<typeof CancellationAuditAction>

/**
 * Calls of one Maple AI tool from one surface over the 60 days, by the org's
 * users, API keys and agents (Maple's own automatic runs left out).
 */
export const CancellationToolCalls = Schema.Struct({
	tool: Schema.String,
	/** `mcp` (an external agent over MCP), `chat` (Maple's in-app chat), `bot` (a chat-platform bot). */
	surface: Schema.String,
	recent: Count,
	prior: Count,
	/** Calls over both windows that returned an error. */
	errors: Count,
})
export type CancellationToolCalls = Schema.Schema.Type<typeof CancellationToolCalls>

export const CancellationTelemetryEvidence = Schema.Struct({
	services: Schema.NullOr(CancellationServices),
	/** Empty when no spans arrived in the 60 days. */
	resourceAttributes: Schema.NullOr(Schema.Array(CancellationResourceAttribute)),
	alertChecks: Schema.NullOr(CancellationAlertChecks),
	errors: Schema.NullOr(CancellationErrorVolume),
	/** Up to 25 event names, most frequent over both windows first. */
	productEvents: Schema.NullOr(Schema.Array(CancellationProductEvent)),
	auditActors: Schema.NullOr(CancellationAuditActors),
	/** Up to 25 actions, most frequent over both windows first. */
	auditActions: Schema.NullOr(Schema.Array(CancellationAuditAction)),
	/** Up to 15 tool and surface pairs, most called over both windows first. */
	toolCalls: Schema.NullOr(Schema.Array(CancellationToolCalls)),
})
export type CancellationTelemetryEvidence = Schema.Schema.Type<typeof CancellationTelemetryEvidence>
