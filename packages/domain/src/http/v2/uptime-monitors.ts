import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/http-api"
import { Schema } from "effect"
import {
	UptimeIntervalSeconds,
	UptimeMonitorId,
	UptimeMonitorKind,
	UptimeMonitorStatus,
} from "../../primitives"
import {
	UptimeDnsRecordType,
	UptimeHttpMethod,
	UptimeStatusMatcher,
	type UptimeAssertion,
	type UptimeHeartbeatSchedule,
	type UptimeMonitorConfig,
} from "../../uptime"
import {
	UptimeMonitorLimitReachedError,
	UptimeMonitorNotFoundError,
	UptimeMonitorPersistenceError,
	UptimeMonitorValidationError,
} from "../uptime"
import { AuthorizationV2 } from "./auth"
import { wireExample, ListOf, ListQuery, Timestamp } from "./envelopes"
import { V2InsufficientPermissions, V2ParameterInvalid } from "./errors"
import { publicErrors } from "./public-error"
import { PublicId, PublicIdPrefixes } from "./public-id"
import { AlertDestinationPublicId, AlertRulePublicId } from "./resource-ids"

/** `upm_…` public ID ⇄ internal `UptimeMonitorId` (raw UUID). */
export const UptimeMonitorPublicId = PublicId(PublicIdPrefixes.uptimeMonitor, UptimeMonitorId)

const NonEmptyString = Schema.String.check(Schema.isMinLength(1), Schema.isTrimmed())
const Int = Schema.Number.check(Schema.isInt())

/** Default timeout when a create omits `timeout_ms`. */
export const UPTIME_DEFAULT_TIMEOUT_MS = 10_000

const timeoutField = Schema.optionalKey(
	Schema.Number.check(Schema.isInt(), Schema.isBetween({ minimum: 1000, maximum: 30000 })).annotate({
		description:
			"How long one check may take before it counts as failed, in milliseconds (1000 to 30000). Defaults to 10000.",
		examples: [10000],
	}),
)

// --- Wire config (snake_case, discriminated by `type`) ---

const jsonPathField = NonEmptyString.annotate({
	description: "Dot path with `[n]` indexes, e.g. `checks[0].status`.",
})

export const V2UptimeAssertion = Schema.Union([
	Schema.Struct({
		type: Schema.Literal("status"),
		op: Schema.Literals(["is", "is_not"]),
		value: UptimeStatusMatcher.annotate({
			description: "A class like `2xx` or an exact code like `204`.",
		}),
	}),
	Schema.Struct({
		type: Schema.Literal("latency"),
		under_ms: Int.check(Schema.isGreaterThan(0)).annotate({
			description: "The response must arrive in under this many milliseconds.",
		}),
	}),
	Schema.Struct({
		type: Schema.Literal("body"),
		op: Schema.Literals(["contains", "not_contains"]),
		value: NonEmptyString,
	}),
	Schema.Struct({ type: Schema.Literal("json_path"), path: jsonPathField, op: Schema.Literal("exists") }),
	Schema.Struct({
		type: Schema.Literal("json_path"),
		path: jsonPathField,
		op: Schema.Literal("equals"),
		value: Schema.String.annotate({
			description: "Compared to the value's JSON text (`null` for null).",
		}),
	}),
	Schema.Struct({ type: Schema.Literal("header"), name: NonEmptyString, op: Schema.Literal("exists") }),
	Schema.Struct({
		type: Schema.Literal("header"),
		name: NonEmptyString,
		op: Schema.Literal("equals"),
		value: Schema.String,
	}),
	Schema.Struct({
		type: Schema.Literal("header"),
		name: NonEmptyString,
		op: Schema.Literal("contains"),
		value: NonEmptyString,
	}),
]).annotate({
	identifier: "UptimeAssertion",
	title: "Uptime assertion",
	description: "One condition an HTTP check must meet. The first one that fails marks the check failed.",
})
export type V2UptimeAssertion = Schema.Schema.Type<typeof V2UptimeAssertion>

export const V2UptimeHttpConfig = Schema.Struct({
	type: Schema.Literal("http"),
	url: NonEmptyString.annotate({
		description: "The public http(s) URL to request. Private, loopback and metadata hosts are refused.",
		examples: ["https://api.example.com/health"],
	}),
	method: Schema.optionalKey(
		UptimeHttpMethod.annotate({ description: "Request method. Defaults to `GET`." }),
	),
	headers: Schema.optionalKey(
		Schema.Record(Schema.String, Schema.String).annotate({ description: "Extra request headers." }),
	),
	body: Schema.optionalKey(Schema.String.annotate({ description: "Request body, for `POST`." })),
	assertions: Schema.optionalKey(
		Schema.Array(V2UptimeAssertion).annotate({
			description: "Conditions the response must meet. Defaults to a status of `2xx`.",
		}),
	),
	timeout_ms: timeoutField,
}).annotate({ identifier: "UptimeHttpConfig", title: "HTTP check" })

export const V2UptimeTcpConfig = Schema.Struct({
	type: Schema.Literal("tcp"),
	host: NonEmptyString.annotate({
		description: "Public hostname or IP to connect to.",
		examples: ["db.example.com"],
	}),
	port: Schema.Number.check(Schema.isInt(), Schema.isBetween({ minimum: 1, maximum: 65535 })).annotate({
		description: "TCP port.",
		examples: [5432],
	}),
	timeout_ms: timeoutField,
}).annotate({ identifier: "UptimeTcpConfig", title: "TCP check" })

export const V2UptimeDnsConfig = Schema.Struct({
	type: Schema.Literal("dns"),
	hostname: NonEmptyString.annotate({ description: "The name to resolve.", examples: ["example.com"] }),
	record_type: UptimeDnsRecordType.annotate({ description: "Record type to query." }),
	expected: Schema.optionalKey(
		NonEmptyString.annotate({
			description: "Up when any answer equals this; omitted means it resolves at all.",
		}),
	),
	timeout_ms: timeoutField,
}).annotate({ identifier: "UptimeDnsConfig", title: "DNS check" })

export const V2UptimeHeartbeatSchedule = Schema.Union([
	Schema.Struct({
		type: Schema.Literal("interval"),
		seconds: Int.check(Schema.isGreaterThanOrEqualTo(60)).annotate({
			description: "Expected seconds between pings (at least 60).",
		}),
	}),
	Schema.Struct({
		type: Schema.Literal("cron"),
		expression: NonEmptyString.annotate({ description: "Cron expression of the expected pings." }),
		timezone: NonEmptyString.annotate({
			description: "IANA timezone the expression runs in.",
			examples: ["UTC"],
		}),
	}),
]).annotate({ identifier: "UptimeHeartbeatSchedule", title: "Heartbeat schedule" })

export const V2UptimeHeartbeatConfig = Schema.Struct({
	type: Schema.Literal("heartbeat"),
	schedule: V2UptimeHeartbeatSchedule,
	grace_seconds: Schema.Number.check(
		Schema.isInt(),
		Schema.isBetween({ minimum: 0, maximum: 86400 }),
	).annotate({
		description: "How late a ping may be before the monitor goes down.",
		examples: [300],
	}),
}).annotate({ identifier: "UptimeHeartbeatConfig", title: "Heartbeat" })

export const V2UptimeMonitorConfig = Schema.Union([
	V2UptimeHttpConfig,
	V2UptimeTcpConfig,
	V2UptimeDnsConfig,
	V2UptimeHeartbeatConfig,
]).annotate({
	identifier: "UptimeMonitorConfig",
	title: "Uptime monitor config",
	description: "What the monitor checks. `type` always equals the monitor's `kind`.",
})
export type V2UptimeMonitorConfig = Schema.Schema.Type<typeof V2UptimeMonitorConfig>

const DEFAULT_ASSERTIONS: ReadonlyArray<UptimeAssertion> = [{ _tag: "status", op: "is", value: "2xx" }]

const assertionFromWire = (assertion: V2UptimeAssertion): UptimeAssertion => {
	switch (assertion.type) {
		case "status":
			return { _tag: "status", op: assertion.op, value: assertion.value }
		case "latency":
			return { _tag: "latency", underMs: assertion.under_ms }
		case "body":
			return { _tag: "body", op: assertion.op, value: assertion.value }
		case "json_path":
			return assertion.op === "exists"
				? { _tag: "json_path", path: assertion.path, op: "exists" }
				: { _tag: "json_path", path: assertion.path, op: "equals", value: assertion.value }
		case "header":
			return assertion.op === "exists"
				? { _tag: "header", name: assertion.name, op: "exists" }
				: assertion.op === "equals"
					? { _tag: "header", name: assertion.name, op: "equals", value: assertion.value }
					: { _tag: "header", name: assertion.name, op: "contains", value: assertion.value }
	}
}

const assertionToWire = (assertion: UptimeAssertion): V2UptimeAssertion => {
	switch (assertion._tag) {
		case "status":
			return { type: "status", op: assertion.op, value: assertion.value }
		case "latency":
			return { type: "latency", under_ms: assertion.underMs }
		case "body":
			return { type: "body", op: assertion.op, value: assertion.value }
		case "json_path":
			return assertion.op === "exists"
				? { type: "json_path", path: assertion.path, op: "exists" }
				: { type: "json_path", path: assertion.path, op: "equals", value: assertion.value }
		case "header":
			return assertion.op === "exists"
				? { type: "header", name: assertion.name, op: "exists" }
				: assertion.op === "equals"
					? { type: "header", name: assertion.name, op: "equals", value: assertion.value }
					: { type: "header", name: assertion.name, op: "contains", value: assertion.value }
	}
}

const scheduleFromWire = (
	schedule: Schema.Schema.Type<typeof V2UptimeHeartbeatSchedule>,
): UptimeHeartbeatSchedule =>
	schedule.type === "interval"
		? { _tag: "interval", seconds: schedule.seconds }
		: { _tag: "cron", expression: schedule.expression, timezone: schedule.timezone }

const scheduleToWire = (
	schedule: UptimeHeartbeatSchedule,
): Schema.Schema.Type<typeof V2UptimeHeartbeatSchedule> =>
	schedule._tag === "interval"
		? { type: "interval", seconds: schedule.seconds }
		: { type: "cron", expression: schedule.expression, timezone: schedule.timezone }

/** Wire config to the stored domain config, filling the defaults a create may omit. */
export const uptimeConfigFromWire = (config: V2UptimeMonitorConfig): UptimeMonitorConfig => {
	switch (config.type) {
		case "http":
			return {
				_tag: "http",
				url: config.url,
				method: config.method ?? "GET",
				headers: config.headers ?? {},
				...(config.body === undefined ? undefined : { body: config.body }),
				assertions:
					config.assertions === undefined
						? DEFAULT_ASSERTIONS
						: config.assertions.map(assertionFromWire),
				timeoutMs: config.timeout_ms ?? UPTIME_DEFAULT_TIMEOUT_MS,
			}
		case "tcp":
			return {
				_tag: "tcp",
				host: config.host,
				port: config.port,
				timeoutMs: config.timeout_ms ?? UPTIME_DEFAULT_TIMEOUT_MS,
			}
		case "dns":
			return {
				_tag: "dns",
				hostname: config.hostname,
				recordType: config.record_type,
				...(config.expected === undefined ? undefined : { expected: config.expected }),
				timeoutMs: config.timeout_ms ?? UPTIME_DEFAULT_TIMEOUT_MS,
			}
		case "heartbeat":
			return {
				_tag: "heartbeat",
				schedule: scheduleFromWire(config.schedule),
				graceSeconds: config.grace_seconds,
			}
	}
}

/** Stored domain config to its wire form, every default spelled out. */
export const uptimeConfigToWire = (config: UptimeMonitorConfig): V2UptimeMonitorConfig => {
	switch (config._tag) {
		case "http":
			return {
				type: "http",
				url: config.url,
				method: config.method,
				headers: config.headers,
				...(config.body === undefined ? undefined : { body: config.body }),
				assertions: config.assertions.map(assertionToWire),
				timeout_ms: config.timeoutMs,
			}
		case "tcp":
			return { type: "tcp", host: config.host, port: config.port, timeout_ms: config.timeoutMs }
		case "dns":
			return {
				type: "dns",
				hostname: config.hostname,
				record_type: config.recordType,
				...(config.expected === undefined ? undefined : { expected: config.expected }),
				timeout_ms: config.timeoutMs,
			}
		case "heartbeat":
			return {
				type: "heartbeat",
				schedule: scheduleToWire(config.schedule),
				grace_seconds: config.graceSeconds,
			}
	}
}

// --- Objects ---

const kindField = UptimeMonitorKind.annotate({
	description: "What the monitor checks: `http`, `tcp`, `dns`, or `heartbeat` (your job pings Maple).",
	examples: ["http"],
})

const intervalField = UptimeIntervalSeconds.annotate({
	description: "How often Maple runs the check, in seconds (30 to 3600). Ignored for heartbeats.",
})

const failuresToDownField = Schema.Number.check(
	Schema.isInt(),
	Schema.isBetween({ minimum: 1, maximum: 10 }),
).annotate({
	description: "Consecutive failed checks before the monitor is down (1 to 10).",
	examples: [2],
})

export const V2UptimeLastCheck = Schema.Struct({
	at: Timestamp.annotate({ description: "When the check ran." }),
	ok: Schema.Boolean.annotate({ description: "Whether the check passed." }),
	status_code: Schema.NullOr(Schema.Number).annotate({
		description: "HTTP status code, or `null` for non-HTTP checks and connection failures.",
	}),
	duration_ms: Schema.NullOr(Schema.Number).annotate({ description: "How long the check took." }),
	error: Schema.NullOr(Schema.String).annotate({
		description: "Why the check failed in one sentence, or `null` when it passed.",
	}),
	trace_id: Schema.NullOr(Schema.String).annotate({
		description: "Trace id of the check's span in your traces, when recorded.",
	}),
}).annotate({ identifier: "UptimeLastCheck", title: "Last uptime check" })

export const V2UptimeRecentCheck = Schema.Struct({
	at: Timestamp,
	ok: Schema.Boolean,
	duration_ms: Schema.NullOr(Schema.Number),
}).annotate({ identifier: "UptimeRecentCheck", title: "Recent uptime check" })

export const V2UptimeMonitorState = Schema.Struct({
	status: UptimeMonitorStatus.annotate({
		description: "`pending` until the first result, then `up` or `down`; `paused` while disabled.",
		examples: ["up"],
	}),
	consecutive_failures: Schema.Number.annotate({ description: "Failed checks in a row." }),
	status_changed_at: Schema.NullOr(Timestamp).annotate({
		description: "When the status last changed, or `null` before the first result.",
	}),
	last_check: Schema.NullOr(V2UptimeLastCheck).annotate({ description: "The latest check, or `null`." }),
	recent: Schema.Array(V2UptimeRecentCheck).annotate({ description: "Recent checks, oldest first." }),
	last_ping_at: Schema.NullOr(Timestamp).annotate({
		description: "Heartbeats only: when the last ping arrived.",
	}),
}).annotate({ identifier: "UptimeMonitorState", title: "Uptime monitor state" })

const uptimeMonitorExample = {
	id: "upm_YofPTrK9782DWwcnXhpcCw",
	object: "uptime_monitor",
	name: "API health",
	kind: "http",
	config: {
		type: "http",
		url: "https://api.example.com/health",
		method: "GET",
		headers: {},
		assertions: [{ type: "status", op: "is", value: "2xx" }],
		timeout_ms: 10000,
	},
	interval_seconds: 60,
	failures_to_down: 2,
	service_name: "api",
	enabled: true,
	destination_ids: ["dest_oybbpTBhtSFGShMjjLiCrh"],
	heartbeat_url: null,
	alert_rule_id: "alrt_YofPTrK9782DWwcnXhpcCw",
	state: {
		status: "up",
		consecutive_failures: 0,
		status_changed_at: "2026-07-15T09:12:00.000Z",
		last_check: {
			at: "2026-07-15T09:12:00.000Z",
			ok: true,
			status_code: 200,
			duration_ms: 142,
			error: null,
			trace_id: null,
		},
		recent: [{ at: "2026-07-15T09:12:00.000Z", ok: true, duration_ms: 142 }],
		last_ping_at: null,
	},
	created_at: "2026-07-01T12:00:00.000Z",
	updated_at: "2026-07-15T09:12:00.000Z",
} as const

const destinationIdsField = Schema.Array(AlertDestinationPublicId).annotate({
	description:
		"Alert destinations notified when the monitor goes down and when it recovers. Empty means the incident still opens, but nobody is notified.",
})

export const V2UptimeMonitor = Schema.Struct({
	id: UptimeMonitorPublicId,
	object: Schema.Literal("uptime_monitor").annotate({
		description: 'The object type, always `"uptime_monitor"`.',
		examples: ["uptime_monitor"],
	}),
	name: Schema.String.annotate({ description: "Human-readable label.", examples: ["API health"] }),
	kind: kindField,
	config: V2UptimeMonitorConfig,
	interval_seconds: intervalField,
	failures_to_down: failuresToDownField,
	service_name: Schema.NullOr(Schema.String).annotate({
		description: "Service the monitor belongs to, linking failures to its health, traces and deploys.",
		examples: ["api"],
	}),
	enabled: Schema.Boolean.annotate({
		description: "Whether the monitor runs. A disabled monitor is paused.",
		examples: [true],
	}),
	destination_ids: destinationIdsField,
	heartbeat_url: Schema.NullOr(Schema.String).annotate({
		description:
			"Heartbeats only: the URL your job sends `GET` or `POST` to on success (append `/fail` to report a failure). `null` for other kinds.",
	}),
	alert_rule_id: Schema.NullOr(AlertRulePublicId).annotate({
		description:
			"The alert rule backing this monitor: its incidents carry this rule id. `null` only for a monitor whose rule is missing.",
	}),
	state: V2UptimeMonitorState,
	created_at: Timestamp.annotate({ description: "When the monitor was created." }),
	updated_at: Timestamp.annotate({ description: "When the monitor was last updated." }),
}).annotate({
	identifier: "UptimeMonitor",
	title: "Uptime Monitor",
	description:
		"A check Maple runs on a schedule from outside your infrastructure (HTTP, TCP or DNS), or a heartbeat your own job sends. Each check is recorded as a span in your traces.",
	examples: [wireExample(uptimeMonitorExample)],
})
export type V2UptimeMonitor = Schema.Schema.Type<typeof V2UptimeMonitor>

export const V2UptimeMonitorCreateParams = Schema.Struct({
	name: NonEmptyString.annotate({
		description: "Human-readable label. Required, non-empty.",
		examples: ["API health"],
	}),
	kind: kindField,
	config: V2UptimeMonitorConfig,
	interval_seconds: Schema.optionalKey(intervalField),
	failures_to_down: Schema.optionalKey(failuresToDownField),
	service_name: Schema.optionalKey(
		Schema.NullOr(Schema.String).annotate({ description: "Service the monitor belongs to." }),
	),
	enabled: Schema.optionalKey(
		Schema.Boolean.annotate({ description: "Whether the monitor starts running. Defaults to `true`." }),
	),
	destination_ids: Schema.optionalKey(destinationIdsField),
}).annotate({
	identifier: "UptimeMonitorCreateParams",
	title: "Uptime monitor create parameters",
	description: "Request body for creating an uptime monitor. `config.type` must equal `kind`.",
	examples: [
		wireExample({
			name: "API health",
			kind: "http",
			config: { type: "http", url: "https://api.example.com/health" },
			interval_seconds: 60,
		}),
	],
})
export type V2UptimeMonitorCreateParams = Schema.Schema.Type<typeof V2UptimeMonitorCreateParams>

export const V2UptimeMonitorUpdateParams = Schema.Struct({
	name: Schema.optionalKey(NonEmptyString),
	config: Schema.optionalKey(
		V2UptimeMonitorConfig.annotate({
			description: "A new config of the same kind; the kind cannot change.",
		}),
	),
	interval_seconds: Schema.optionalKey(intervalField),
	failures_to_down: Schema.optionalKey(failuresToDownField),
	service_name: Schema.optionalKey(Schema.NullOr(Schema.String)),
	enabled: Schema.optionalKey(
		Schema.Boolean.annotate({
			description:
				"`false` pauses the monitor; `true` resumes it, back to `pending` until the next result.",
		}),
	),
	destination_ids: Schema.optionalKey(destinationIdsField),
}).annotate({
	identifier: "UptimeMonitorUpdateParams",
	title: "Uptime monitor update parameters",
	description: "Request body for updating an uptime monitor. Omitted fields are left unchanged.",
	examples: [wireExample({ enabled: false })],
})
export type V2UptimeMonitorUpdateParams = Schema.Schema.Type<typeof V2UptimeMonitorUpdateParams>

export const V2UptimeMonitorDeleteResponse = Schema.Struct({
	id: UptimeMonitorPublicId,
	object: Schema.Literal("uptime_monitor"),
	deleted: Schema.Literal(true).annotate({ description: "Always `true`: the monitor no longer exists." }),
}).annotate({
	identifier: "UptimeMonitorDeleteResponse",
	title: "Uptime monitor delete response",
	description: "Confirmation that an uptime monitor was deleted.",
	examples: [wireExample({ id: "upm_YofPTrK9782DWwcnXhpcCw", object: "uptime_monitor", deleted: true })],
})
export type V2UptimeMonitorDeleteResponse = Schema.Schema.Type<typeof V2UptimeMonitorDeleteResponse>

export const V2UptimeMonitorTestParams = Schema.Struct({
	config: V2UptimeMonitorConfig.annotate({ description: "The config to try. Only `http` runs here." }),
}).annotate({
	identifier: "UptimeMonitorTestParams",
	title: "Uptime monitor test parameters",
	description: "A config to run once, before saving it.",
	examples: [wireExample({ config: { type: "http", url: "https://api.example.com/health" } })],
})
export type V2UptimeMonitorTestParams = Schema.Schema.Type<typeof V2UptimeMonitorTestParams>

export const V2UptimeMonitorTestResult = Schema.Struct({
	object: Schema.Literal("uptime_monitor.test_result"),
	ok: Schema.Boolean.annotate({ description: "Whether the check passed every assertion." }),
	status_code: Schema.NullOr(Schema.Number).annotate({
		description: "The response status, or `null` when no response arrived.",
	}),
	duration_ms: Schema.Number.annotate({ description: "How long the request took." }),
	failed_assertion: Schema.NullOr(Schema.String).annotate({
		description: "The first assertion that failed, in one sentence, or `null`.",
	}),
	error: Schema.NullOr(Schema.String).annotate({
		description: "Why no response arrived (refused URL, connection failure, timeout), or `null`.",
	}),
	headers: Schema.Record(Schema.String, Schema.String).annotate({ description: "Response headers." }),
	body_prefix: Schema.NullOr(Schema.String).annotate({
		description: "The first 2 KB of the response body, or `null` when there was none.",
	}),
	body_truncated: Schema.Boolean.annotate({ description: "Whether the body was longer than the prefix." }),
}).annotate({
	identifier: "UptimeMonitorTestResult",
	title: "Uptime monitor test result",
	description: "The outcome of one HTTP check run on demand.",
	examples: [
		wireExample({
			object: "uptime_monitor.test_result",
			ok: true,
			status_code: 200,
			duration_ms: 142,
			failed_assertion: null,
			error: null,
			headers: { "content-type": "application/json" },
			body_prefix: '{"status":"ok"}',
			body_truncated: false,
		}),
	],
})
export type V2UptimeMonitorTestResult = Schema.Schema.Type<typeof V2UptimeMonitorTestResult>

const [uptimeNotFound, uptimeValidation, uptimePersistence, uptimeLimitReached] = publicErrors(
	UptimeMonitorNotFoundError,
	UptimeMonitorValidationError,
	UptimeMonitorPersistenceError,
	UptimeMonitorLimitReachedError,
)

const UptimeMonitorList = ListOf(V2UptimeMonitor).annotate({
	identifier: "UptimeMonitorList",
	title: "Uptime monitor list",
	description: "A cursor-paginated page of uptime monitors.",
})

export class V2UptimeMonitorsApiGroup extends HttpApiGroup.make("uptimeMonitors")
	.add(
		HttpApiEndpoint.get("list", "/", {
			query: ListQuery,
			success: UptimeMonitorList,
			error: [V2ParameterInvalid.schema, uptimePersistence],
		}).annotateMerge(
			OpenApi.annotations({
				identifier: "listUptimeMonitors",
				summary: "List uptime monitors",
				description:
					"Returns your organization's uptime monitors with their current state, most recently created first. Cursor-paginated. Requires the `uptime_monitors:read` scope.",
			}),
		),
	)
	.add(
		HttpApiEndpoint.post("create", "/", {
			payload: V2UptimeMonitorCreateParams,
			success: V2UptimeMonitor,
			error: [
				V2InsufficientPermissions.schema,
				uptimeValidation,
				uptimePersistence,
				uptimeLimitReached,
			],
		}).annotateMerge(
			OpenApi.annotations({
				identifier: "createUptimeMonitor",
				summary: "Create an uptime monitor",
				description:
					"Creates an uptime monitor. It starts `pending` until its first result. Fails with 402 when the organization already has as many monitors as its plan allows. Requires the `uptime_monitors:write` scope and an org-admin caller.",
			}),
		),
	)
	.add(
		HttpApiEndpoint.post("test", "/test", {
			payload: V2UptimeMonitorTestParams,
			success: V2UptimeMonitorTestResult,
			error: [V2InsufficientPermissions.schema, uptimeValidation],
		}).annotateMerge(
			OpenApi.annotations({
				identifier: "testUptimeMonitor",
				summary: "Test an uptime check",
				description:
					"Runs one HTTP check now with the given config and reports the response, without saving anything. TCP, DNS and heartbeat monitors run after creation. Requires the `uptime_monitors:write` scope and an org-admin caller.",
			}),
		),
	)
	.add(
		HttpApiEndpoint.get("retrieve", "/:id", {
			params: { id: UptimeMonitorPublicId },
			success: V2UptimeMonitor,
			error: [uptimeNotFound, uptimePersistence],
		}).annotateMerge(
			OpenApi.annotations({
				identifier: "getUptimeMonitor",
				summary: "Retrieve an uptime monitor",
				description:
					"Returns a single uptime monitor by its `upm_…` ID. Requires the `uptime_monitors:read` scope.",
			}),
		),
	)
	.add(
		HttpApiEndpoint.patch("update", "/:id", {
			params: { id: UptimeMonitorPublicId },
			payload: V2UptimeMonitorUpdateParams,
			success: V2UptimeMonitor,
			error: [V2InsufficientPermissions.schema, uptimeNotFound, uptimeValidation, uptimePersistence],
		}).annotateMerge(
			OpenApi.annotations({
				identifier: "updateUptimeMonitor",
				summary: "Update an uptime monitor",
				description:
					"Updates a monitor; omitted fields are unchanged. Set `enabled` to pause or resume it. Requires the `uptime_monitors:write` scope and an org-admin caller.",
			}),
		),
	)
	.add(
		HttpApiEndpoint.delete("delete", "/:id", {
			params: { id: UptimeMonitorPublicId },
			success: V2UptimeMonitorDeleteResponse,
			error: [V2InsufficientPermissions.schema, uptimeNotFound, uptimePersistence],
		}).annotateMerge(
			OpenApi.annotations({
				identifier: "deleteUptimeMonitor",
				summary: "Delete an uptime monitor",
				description:
					"Permanently deletes an uptime monitor and stops its checks. Recorded check spans are unaffected. Requires the `uptime_monitors:write` scope and an org-admin caller.",
			}),
		),
	)
	.prefix("/v2/uptime_monitors")
	.middleware(AuthorizationV2)
	.annotateMerge(
		OpenApi.annotations({
			title: "Uptime Monitors",
			description:
				"Checks Maple runs from outside your infrastructure (HTTP, TCP, DNS) and heartbeats your jobs send. Each check is a span in your traces; a monitor goes down after enough failures in a row.",
		}),
	) {}
