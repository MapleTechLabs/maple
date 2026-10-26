/** Pieces the uptime monitor MCP tools share: rows, target summaries, config building, errors. */
import { Effect, Schema } from "effect"
import type { UptimeMonitorRow } from "@maple/domain/mcp-outputs"
import { UPTIME_DEFAULT_TIMEOUT_MS } from "@maple/domain/http/v2"
import type { UptimeMonitorKind } from "@maple/domain/primitives"
import {
	UptimeMonitorConfig,
	type UptimeAssertion,
	type UptimeHttpMethod,
	type UptimeDnsRecordType,
	type UptimeRecentCheck,
} from "@maple/domain/uptime"
import { redactUrlSecrets } from "@maple/domain/url-redaction"
import type { UptimeMonitorRecord } from "@maple/backend/services/uptime/UptimeMonitorsService"
import { McpInvalidInputError, McpQueryError, McpUnavailableError } from "../tools/types"

export const DEFAULT_GRACE_SECONDS = 300
export const DEFAULT_HEARTBEAT_TIMEZONE = "UTC"

const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString())

const seconds = (value: number): string =>
	value === 0
		? "0s"
		: value % 3600 === 0
			? `${value / 3600}h`
			: value % 60 === 0
				? `${value / 60}m`
				: `${value}s`

/** What a monitor checks, in one line. Userinfo and query secrets never leave the URL. */
export const targetSummary = (config: UptimeMonitorConfig): string => {
	switch (config._tag) {
		case "http":
			return `${config.method} ${redactUrlSecrets(config.url)}`
		case "tcp":
			return `${config.host}:${config.port}`
		case "dns":
			return `${config.recordType} ${config.hostname}${config.expected === undefined ? "" : ` = ${config.expected}`}`
		case "heartbeat": {
			const schedule =
				config.schedule._tag === "interval"
					? `ping every ${seconds(config.schedule.seconds)}`
					: `ping on cron "${config.schedule.expression}" (${config.schedule.timezone})`
			return `${schedule}, ${seconds(config.graceSeconds)} grace`
		}
	}
}

/** Share of recent checks that passed; null before the first one. */
export const uptimeRatio = (recent: ReadonlyArray<UptimeRecentCheck>): number | null =>
	recent.length === 0 ? null : recent.filter((check) => check.ok).length / recent.length

/** `canWrite`: the ping URL is a credential, so only org admins see it. */
export const toMonitorRow = (
	monitor: UptimeMonitorRecord,
	canWrite: boolean,
): typeof UptimeMonitorRow.Type => ({
	id: monitor.id,
	name: monitor.name,
	kind: monitor.kind,
	target: targetSummary(monitor.config),
	status: monitor.state.status,
	enabled: monitor.enabled,
	serviceName: monitor.serviceName,
	intervalSeconds: monitor.intervalSeconds,
	failuresToDown: monitor.failuresToDown,
	statusChangedAt: iso(monitor.state.statusChangedAt),
	lastCheck:
		monitor.state.lastCheck === null
			? null
			: {
					at: new Date(monitor.state.lastCheck.at).toISOString(),
					ok: monitor.state.lastCheck.ok,
					statusCode: monitor.state.lastCheck.statusCode,
					durationMs: monitor.state.lastCheck.durationMs,
					error: monitor.state.lastCheck.error,
					traceId: monitor.state.lastCheck.traceId,
				},
	uptimeRatio: uptimeRatio(monitor.state.recent),
	recentChecks: monitor.state.recent.length,
	lastPingAt: iso(monitor.state.lastPingAt),
	heartbeatUrl: canWrite ? monitor.heartbeatUrl : null,
	destinationIds: [...monitor.destinationIds],
})

/** A line the heartbeat job runs last: fails quietly, retries, never hangs the job. */
export const pingCommand = (heartbeatUrl: string | null): string | null =>
	heartbeatUrl === null ? null : `curl -fsS -m 10 --retry 3 ${heartbeatUrl}`

export const limitReachedMessage = (limit: number): string =>
	limit === 0
		? "This organization's plan doesn't include uptime monitors. An admin can upgrade the plan in Settings → Billing."
		: `This organization has used its ${limit} included uptime monitors. Delete one with delete_uptime_monitor, or upgrade the plan in Settings → Billing to add more.`

type UptimeServiceError =
	| { readonly _tag: "@maple/http/errors/UptimeMonitorValidationError"; readonly message: string }
	| { readonly _tag: "@maple/http/errors/UptimeMonitorPersistenceError"; readonly message: string }
	| { readonly _tag: "@maple/http/errors/UptimeMonitorNotFoundError"; readonly message: string }
	| {
			readonly _tag: "@maple/http/errors/UptimeMonitorLimitReachedError"
			readonly message: string
			readonly limit: number
	  }

/** The service's failures as the model reads them: bad input to fix, a plan limit, or an outage. */
export const toMcpUptimeError = (tool: string) => (error: UptimeServiceError) => {
	switch (error._tag) {
		case "@maple/http/errors/UptimeMonitorValidationError":
			return new McpInvalidInputError({ message: error.message })
		case "@maple/http/errors/UptimeMonitorNotFoundError":
			return new McpInvalidInputError({
				message: "No such uptime monitor. list_uptime_monitors lists them.",
				parameter: "monitor",
			})
		case "@maple/http/errors/UptimeMonitorLimitReachedError":
			return new McpUnavailableError({
				message: limitReachedMessage(error.limit),
				capability: "uptime_monitor_allowance",
			})
		case "@maple/http/errors/UptimeMonitorPersistenceError":
			return new McpQueryError({
				message: `${error._tag}: ${error.message}`,
				pipeName: tool,
				cause: error,
			})
	}
}

// --- Config from flat tool parameters ---

export interface UptimeConfigFields {
	readonly url?: string | undefined
	readonly method?: UptimeHttpMethod | undefined
	readonly expected_status?: string | undefined
	readonly max_response_ms?: number | undefined
	readonly body_contains?: string | undefined
	readonly host?: string | undefined
	readonly port?: number | undefined
	readonly record_type?: UptimeDnsRecordType | undefined
	readonly expected?: string | undefined
	readonly heartbeat_interval_seconds?: number | undefined
	readonly cron?: string | undefined
	readonly timezone?: string | undefined
	readonly grace_seconds?: number | undefined
	/** Update only: drop the matching check or expected answer. */
	readonly clear_max_response_ms?: boolean | undefined
	readonly clear_body_contains?: boolean | undefined
	readonly clear_expected?: boolean | undefined
}

const FIELD_KINDS: ReadonlyArray<readonly [keyof UptimeConfigFields, ReadonlyArray<UptimeMonitorKind>]> = [
	["url", ["http"]],
	["method", ["http"]],
	["expected_status", ["http"]],
	["max_response_ms", ["http"]],
	["body_contains", ["http"]],
	["host", ["tcp", "dns"]],
	["port", ["tcp"]],
	["record_type", ["dns"]],
	["expected", ["dns"]],
	["heartbeat_interval_seconds", ["heartbeat"]],
	["cron", ["heartbeat"]],
	["timezone", ["heartbeat"]],
	["grace_seconds", ["heartbeat"]],
	["clear_max_response_ms", ["http"]],
	["clear_body_contains", ["http"]],
	["clear_expected", ["dns"]],
]

const CLEAR_PAIRS: ReadonlyArray<readonly [keyof UptimeConfigFields, keyof UptimeConfigFields]> = [
	["clear_max_response_ms", "max_response_ms"],
	["clear_body_contains", "body_contains"],
	["clear_expected", "expected"],
]

/** A clear flag and the value it clears cannot both be set. */
const rejectClearConflicts = (fields: UptimeConfigFields) => {
	const conflict = CLEAR_PAIRS.find(
		([clear, field]) => fields[clear] === true && fields[field] !== undefined,
	)
	return conflict === undefined
		? Effect.void
		: invalid(
				`Pass ${conflict[1]} to set it, or ${conflict[0]}=true to remove it, not both.`,
				conflict[0],
			)
}

const isLatency = (assertion: UptimeAssertion) => assertion._tag === "latency"
const isBodyContains = (assertion: UptimeAssertion) =>
	assertion._tag === "body" && assertion.op === "contains"

const invalid = (message: string, parameter?: string) =>
	Effect.fail(
		new McpInvalidInputError({ message, ...(parameter === undefined ? undefined : { parameter }) }),
	)

/** A field for another kind is a mistake to name, not to drop: the model meant something by it. */
const rejectMisplaced = (kind: UptimeMonitorKind, fields: UptimeConfigFields) => {
	const misplaced = FIELD_KINDS.find(
		([field, kinds]) => fields[field] !== undefined && !kinds.includes(kind),
	)
	return misplaced === undefined
		? Effect.void
		: invalid(
				`${misplaced[0]} applies to ${misplaced[1].join(" and ")} monitors, not ${kind}.`,
				misplaced[0],
			)
}

const decodeConfig = (kind: UptimeMonitorKind, raw: unknown) =>
	Schema.decodeUnknownEffect(UptimeMonitorConfig)(raw).pipe(
		Effect.mapError(
			(error) => new McpInvalidInputError({ message: `Invalid ${kind} check: ${error.message}` }),
		),
	)

/** Replaces every assertion `matches` finds with one `next`; unchanged when `next` is absent. */
const withAssertion = (
	assertions: ReadonlyArray<UptimeAssertion>,
	next: UptimeAssertion | undefined,
	matches: (assertion: UptimeAssertion) => boolean,
): ReadonlyArray<UptimeAssertion> => {
	if (next === undefined) return assertions
	const at = assertions.findIndex(matches)
	const kept = assertions.filter((assertion) => !matches(assertion))
	return at === -1 ? [...kept, next] : [...kept.slice(0, at), next, ...kept.slice(at)]
}

const httpAssertions = (current: ReadonlyArray<UptimeAssertion>, fields: UptimeConfigFields) =>
	withAssertion(
		withAssertion(
			withAssertion(
				current,
				fields.expected_status === undefined
					? undefined
					: { _tag: "status", op: "is", value: fields.expected_status },
				// An expected status replaces every status rule, so `is_not 5xx` cannot contradict it.
				(assertion) => assertion._tag === "status",
			),
			fields.max_response_ms === undefined
				? undefined
				: { _tag: "latency", underMs: fields.max_response_ms },
			isLatency,
		),
		fields.body_contains === undefined
			? undefined
			: { _tag: "body", op: "contains", value: fields.body_contains },
		isBodyContains,
	).filter(
		(assertion) =>
			!(fields.clear_max_response_ms === true && isLatency(assertion)) &&
			!(fields.clear_body_contains === true && isBodyContains(assertion)),
	)

type HeartbeatScheduleInput =
	| { readonly _tag: "interval"; readonly seconds: number }
	| { readonly _tag: "cron"; readonly expression: string; readonly timezone: string }

const heartbeatSchedule = (
	fields: UptimeConfigFields,
	timezone: string,
): Effect.Effect<HeartbeatScheduleInput | undefined, McpInvalidInputError> => {
	if (fields.heartbeat_interval_seconds !== undefined && fields.cron !== undefined) {
		return invalid("Pass heartbeat_interval_seconds or cron, not both.", "cron")
	}
	if (fields.heartbeat_interval_seconds !== undefined) {
		return Effect.succeed({ _tag: "interval", seconds: fields.heartbeat_interval_seconds })
	}
	return Effect.succeed(
		fields.cron === undefined ? undefined : { _tag: "cron", expression: fields.cron, timezone },
	)
}

/** A new monitor's config from the tool's flat parameters, with the same defaults as the API. */
export const buildUptimeConfig = Effect.fnUntraced(function* (
	kind: UptimeMonitorKind,
	fields: UptimeConfigFields,
) {
	yield* rejectMisplaced(kind, fields)
	switch (kind) {
		case "http": {
			if (fields.url === undefined) return yield* invalid("An http monitor needs a url.", "url")
			return yield* decodeConfig(kind, {
				_tag: "http",
				url: fields.url,
				method: fields.method ?? "GET",
				headers: {},
				assertions: httpAssertions(
					[{ _tag: "status", op: "is", value: fields.expected_status ?? "2xx" }],
					fields,
				),
				timeoutMs: UPTIME_DEFAULT_TIMEOUT_MS,
			})
		}
		case "tcp": {
			if (fields.host === undefined) return yield* invalid("A tcp monitor needs a host.", "host")
			if (fields.port === undefined) return yield* invalid("A tcp monitor needs a port.", "port")
			return yield* decodeConfig(kind, {
				_tag: "tcp",
				host: fields.host,
				port: fields.port,
				timeoutMs: UPTIME_DEFAULT_TIMEOUT_MS,
			})
		}
		case "dns": {
			if (fields.host === undefined) {
				return yield* invalid("A dns monitor needs a host to resolve.", "host")
			}
			return yield* decodeConfig(kind, {
				_tag: "dns",
				hostname: fields.host,
				recordType: fields.record_type ?? "A",
				...(fields.expected === undefined ? undefined : { expected: fields.expected }),
				timeoutMs: UPTIME_DEFAULT_TIMEOUT_MS,
			})
		}
		case "heartbeat": {
			const schedule = yield* heartbeatSchedule(fields, fields.timezone ?? DEFAULT_HEARTBEAT_TIMEZONE)
			if (schedule === undefined) {
				return yield* invalid(
					"A heartbeat monitor needs heartbeat_interval_seconds (at least 60) or a cron expression.",
					"heartbeat_interval_seconds",
				)
			}
			return yield* decodeConfig(kind, {
				_tag: "heartbeat",
				schedule,
				graceSeconds: fields.grace_seconds ?? DEFAULT_GRACE_SECONDS,
			})
		}
	}
})

const omitExpected = (config: UptimeMonitorConfig): UptimeMonitorConfig => {
	if (config._tag !== "dns") return config
	const { expected: _expected, ...rest } = config
	return rest
}

/** An existing config with the given fields changed; undefined when none was given. */
export const updateUptimeConfig = Effect.fnUntraced(function* (
	current: UptimeMonitorConfig,
	fields: UptimeConfigFields,
) {
	yield* rejectMisplaced(current._tag, fields)
	yield* rejectClearConflicts(fields)
	if (!FIELD_KINDS.some(([field]) => fields[field] !== undefined)) return undefined
	switch (current._tag) {
		case "http":
			return yield* decodeConfig(current._tag, {
				...current,
				...(fields.url === undefined ? undefined : { url: fields.url }),
				...(fields.method === undefined ? undefined : { method: fields.method }),
				assertions: httpAssertions(current.assertions, fields),
			})
		case "tcp":
			return yield* decodeConfig(current._tag, {
				...current,
				...(fields.host === undefined ? undefined : { host: fields.host }),
				...(fields.port === undefined ? undefined : { port: fields.port }),
			})
		case "dns":
			return yield* decodeConfig(current._tag, {
				...current,
				...(fields.host === undefined ? undefined : { hostname: fields.host }),
				...(fields.record_type === undefined ? undefined : { recordType: fields.record_type }),
				...(fields.expected === undefined ? undefined : { expected: fields.expected }),
			}).pipe(Effect.map((config) => (fields.clear_expected === true ? omitExpected(config) : config)))
		case "heartbeat": {
			const currentZone =
				current.schedule._tag === "cron" ? current.schedule.timezone : DEFAULT_HEARTBEAT_TIMEZONE
			const timezone = fields.timezone ?? currentZone
			const next = yield* heartbeatSchedule(fields, timezone)
			if (next === undefined && fields.timezone !== undefined && current.schedule._tag !== "cron") {
				return yield* invalid(
					"timezone applies to a cron schedule; this heartbeat runs on an interval.",
					"timezone",
				)
			}
			const schedule =
				next ??
				(current.schedule._tag === "cron" ? { ...current.schedule, timezone } : current.schedule)
			return yield* decodeConfig(current._tag, {
				...current,
				schedule,
				...(fields.grace_seconds === undefined ? undefined : { graceSeconds: fields.grace_seconds }),
			})
		}
	}
})
