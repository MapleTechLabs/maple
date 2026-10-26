import { Cron, Option, Result, Schema } from "effect"
import {
	OrgId,
	UptimeIntervalSeconds,
	UptimeMonitorId,
	UptimeMonitorKind,
	UptimeMonitorStatus,
} from "./primitives"

// Uptime monitors: the stored config per kind, the probe contract between the API and
// `apps/scraper`, and the pure rules both sides share (assertions, the up/down machine).

const NonEmpty = Schema.String.check(Schema.isMinLength(1), Schema.isTrimmed())
const Port = Schema.Number.check(Schema.isInt(), Schema.isBetween({ minimum: 1, maximum: 65535 }))
const TimeoutMs = Schema.Number.check(Schema.isInt(), Schema.isBetween({ minimum: 1000, maximum: 30000 }))

export const UptimeHttpMethod = Schema.Literals(["GET", "HEAD", "POST"])
export type UptimeHttpMethod = Schema.Schema.Type<typeof UptimeHttpMethod>

/** `2xx`-style class or an exact code such as `204`. */
export const UptimeStatusMatcher = Schema.String.check(Schema.isPattern(/^([1-5]xx|[1-5]\d\d)$/u))

export const UptimeAssertion = Schema.Union([
	Schema.TaggedStruct("status", { op: Schema.Literals(["is", "is_not"]), value: UptimeStatusMatcher }),
	Schema.TaggedStruct("latency", { underMs: Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0)) }),
	Schema.TaggedStruct("body", { op: Schema.Literals(["contains", "not_contains"]), value: NonEmpty }),
	// `path` is a dot path with `[n]` indexes, e.g. `checks[0].status`. `exists` takes no value;
	// `equals` and `contains` always carry one.
	Schema.TaggedStruct("json_path", { path: NonEmpty, op: Schema.Literal("exists") }),
	Schema.TaggedStruct("json_path", { path: NonEmpty, op: Schema.Literal("equals"), value: Schema.String }),
	Schema.TaggedStruct("header", { name: NonEmpty, op: Schema.Literal("exists") }),
	Schema.TaggedStruct("header", { name: NonEmpty, op: Schema.Literal("equals"), value: Schema.String }),
	Schema.TaggedStruct("header", { name: NonEmpty, op: Schema.Literal("contains"), value: NonEmpty }),
])
export type UptimeAssertion = Schema.Schema.Type<typeof UptimeAssertion>

export const UptimeHttpConfig = Schema.TaggedStruct("http", {
	url: NonEmpty,
	method: UptimeHttpMethod,
	headers: Schema.Record(Schema.String, Schema.String),
	body: Schema.optionalKey(Schema.String),
	assertions: Schema.Array(UptimeAssertion),
	timeoutMs: TimeoutMs,
})
export const UptimeTcpConfig = Schema.TaggedStruct("tcp", {
	host: NonEmpty,
	port: Port,
	timeoutMs: TimeoutMs,
})
export const UptimeDnsRecordType = Schema.Literals(["A", "AAAA", "CNAME", "MX", "TXT", "NS"])
export type UptimeDnsRecordType = Schema.Schema.Type<typeof UptimeDnsRecordType>
export const UptimeDnsConfig = Schema.TaggedStruct("dns", {
	hostname: NonEmpty,
	recordType: UptimeDnsRecordType,
	/** Up when any answer equals this; omitted means "resolves at all". */
	expected: Schema.optionalKey(NonEmpty),
	timeoutMs: TimeoutMs,
})
export const UptimeHeartbeatSchedule = Schema.Union([
	Schema.TaggedStruct("interval", {
		seconds: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(60)),
	}),
	Schema.TaggedStruct("cron", { expression: NonEmpty, timezone: NonEmpty }),
])
export type UptimeHeartbeatSchedule = Schema.Schema.Type<typeof UptimeHeartbeatSchedule>
export const UptimeHeartbeatConfig = Schema.TaggedStruct("heartbeat", {
	schedule: UptimeHeartbeatSchedule,
	graceSeconds: Schema.Number.check(Schema.isInt(), Schema.isBetween({ minimum: 0, maximum: 86400 })),
})

/**
 * What a caller without write access sees in place of an HTTP check's header value. Sent back
 * on update, it keeps the stored value, so a round-tripped redacted config wipes nothing.
 */
export const UPTIME_REDACTED_HEADER_VALUE = "[redacted]"

/** The stored config; `_tag` always equals the monitor's `kind`. */
export const UptimeMonitorConfig = Schema.Union([
	UptimeHttpConfig,
	UptimeTcpConfig,
	UptimeDnsConfig,
	UptimeHeartbeatConfig,
])
export type UptimeMonitorConfig = Schema.Schema.Type<typeof UptimeMonitorConfig>
export type UptimeProbeConfig = Exclude<UptimeMonitorConfig, { readonly _tag: "heartbeat" }>

/** One check in the per-monitor recent ring (newest last). */
export const UptimeRecentCheck = Schema.Struct({
	at: Schema.Number,
	ok: Schema.Boolean,
	durationMs: Schema.NullOr(Schema.Number),
})
export type UptimeRecentCheck = Schema.Schema.Type<typeof UptimeRecentCheck>
export const UPTIME_RECENT_LIMIT = 60

/** The latest check's detail, kept on the monitor state for the detail page. */
export const UptimeCheckDetail = Schema.Struct({
	at: Schema.Number,
	ok: Schema.Boolean,
	durationMs: Schema.NullOr(Schema.Number),
	statusCode: Schema.NullOr(Schema.Number),
	/** One sentence, e.g. `Status 503, expected 2xx`; null when ok. */
	error: Schema.NullOr(Schema.String),
	traceId: Schema.NullOr(Schema.String),
})
export type UptimeCheckDetail = Schema.Schema.Type<typeof UptimeCheckDetail>

// --- Probe contract (`/api/internal/uptime-*`, SD_INTERNAL_TOKEN bearer) ---

export class UptimeProbeTarget extends Schema.Class<UptimeProbeTarget>("UptimeProbeTarget")({
	id: UptimeMonitorId,
	orgId: OrgId,
	name: Schema.String,
	serviceName: Schema.NullOr(Schema.String),
	intervalSeconds: UptimeIntervalSeconds,
	config: Schema.Union([UptimeHttpConfig, UptimeTcpConfig, UptimeDnsConfig]),
	/** The org's public ingest key: check spans go into the org's own traces. */
	ingestKey: Schema.String,
}) {}
export const UptimeProbeTargetList = Schema.Array(UptimeProbeTarget)

export class UptimeCheckReport extends Schema.Class<UptimeCheckReport>("UptimeCheckReport")({
	monitorId: UptimeMonitorId,
	checkedAt: Schema.Number,
	ok: Schema.Boolean,
	durationMs: Schema.NullOr(Schema.Number),
	statusCode: Schema.NullOr(Schema.Number),
	error: Schema.NullOr(Schema.String),
	traceId: Schema.NullOr(Schema.String),
}) {}
/** Most reports one `/api/internal/uptime-results` POST may carry; the scraper batches to it. */
export const UPTIME_CHECK_REPORT_BATCH_MAX = 1_000
export const UptimeCheckReportList = Schema.Array(UptimeCheckReport).check(
	Schema.isMaxLength(UPTIME_CHECK_REPORT_BATCH_MAX),
)

// --- Assertions ---

export interface UptimeHttpObservation {
	readonly statusCode: number
	readonly durationMs: number
	readonly headers: Readonly<Record<string, string>>
	/** Body prefix as text; `null` when not read (HEAD, binary, too large). */
	readonly body: string | null
}

const statusMatches = (matcher: string, code: number): boolean =>
	matcher.endsWith("xx") ? Math.floor(code / 100) === Number(matcher[0]) : code === Number(matcher)

const PATH_TOKEN = /[^.[\]]+|\[(\d+)\]/gu
const asJsonArray = Schema.decodeUnknownOption(Schema.Array(Schema.Unknown))
const asJsonObject = Schema.decodeUnknownOption(Schema.Record(Schema.String, Schema.Unknown))

/**
 * Reads `a.b[0].c` (or JSONPath-style `$.a.b[0].c`) from parsed JSON; `None` when a step is
 * missing, `Some(null)` for a JSON null.
 */
export const readJsonPath = (root: unknown, path: string): Option.Option<unknown> =>
	Array.from(path.replace(/^\$\.?/u, "").matchAll(PATH_TOKEN)).reduce<Option.Option<unknown>>(
		(current, match) =>
			Option.flatMap(current, (value) => {
				const key = match[1] ?? match[0]
				const index = Number(key)
				return Option.orElse(
					Option.flatMap(asJsonArray(value), (items) =>
						Number.isInteger(index) && index >= 0 && index < items.length
							? Option.some(items[index])
							: Option.none(),
					),
					() =>
						Option.flatMap(asJsonObject(value), (record) =>
							Object.hasOwn(record, key) ? Option.some(record[key]) : Option.none(),
						),
				)
			}),
		Option.some(root),
	)

const jsonText = (value: unknown): string => (typeof value === "string" ? value : JSON.stringify(value))

const parseJson = (body: string | null): Option.Option<unknown> =>
	body === null ? Option.none() : Option.liftThrowable(JSON.parse)(body)

/** The first failing assertion as one sentence, or `null` when every assertion passes. */
export const firstFailedAssertion = (
	assertions: ReadonlyArray<UptimeAssertion>,
	observed: UptimeHttpObservation,
): string | null => {
	const failures = assertions.flatMap((assertion): ReadonlyArray<string> => {
		switch (assertion._tag) {
			case "status": {
				const matches = statusMatches(assertion.value, observed.statusCode)
				const ok = assertion.op === "is" ? matches : !matches
				return ok
					? []
					: [
							`Status ${observed.statusCode}, expected ${assertion.op === "is" ? "" : "not "}${assertion.value}`,
						]
			}
			case "latency":
				return observed.durationMs < assertion.underMs
					? []
					: [
							`Responded in ${Math.round(observed.durationMs)} ms, expected under ${assertion.underMs} ms`,
						]
			case "body": {
				const found = observed.body !== null && observed.body.includes(assertion.value)
				if (assertion.op === "contains")
					return found ? [] : [`Body does not contain "${assertion.value}"`]
				return found ? [`Body contains "${assertion.value}"`] : []
			}
			case "json_path": {
				const read = Option.flatMap(parseJson(observed.body), (json) =>
					readJsonPath(json, assertion.path),
				)
				if (Option.isNone(read)) return [`JSON path ${assertion.path} not found`]
				if (assertion.op === "exists") return []
				const actual = jsonText(read.value)
				return actual === assertion.value
					? []
					: [`JSON path ${assertion.path} is ${actual}, expected ${assertion.value}`]
			}
			case "header": {
				const actual = observed.headers[assertion.name.toLowerCase()]
				if (actual === undefined) return [`Header ${assertion.name} missing`]
				if (assertion.op === "exists") return []
				const expected = assertion.value
				const ok = assertion.op === "equals" ? actual === expected : actual.includes(expected)
				return ok
					? []
					: [`Header ${assertion.name} is "${actual}", expected ${assertion.op} "${expected}"`]
			}
		}
	})
	return failures[0] ?? null
}

// --- Check spans ---

/** `service.name` of the spans the scraper exports per check; the service map drops it. */
export const UPTIME_SERVICE_NAME = "maple-uptime"
/** The resource attribute naming the monitor a check span belongs to. */
export const UPTIME_MONITOR_ID_ATTRIBUTE = "maple.uptime.monitor_id"
/** `service.namespace` of Maple's own synthetic services, so users can filter them out. */
export const MAPLE_SERVICES_NAMESPACE = "maple-services"

/** Maple's own synthetic services; checks recorded before the namespace existed match by name. */
export const isMapleService = (row: { readonly serviceName: string; readonly serviceNamespace: string }) =>
	row.serviceNamespace === MAPLE_SERVICES_NAMESPACE || row.serviceName === UPTIME_SERVICE_NAME

// --- HTTP check request ---

export const UPTIME_USER_AGENT = "maple-uptime/1.0"

/** A monitor without a status rule still expects success: a 503 must not read as up. */
const IMPLICIT_STATUS: UptimeAssertion = { _tag: "status", op: "is", value: "2xx" }

/** The assertions a check is judged by: the configured ones, plus `2xx` when none rules on status. */
export const effectiveAssertions = (
	assertions: ReadonlyArray<UptimeAssertion>,
): ReadonlyArray<UptimeAssertion> =>
	assertions.some((assertion) => assertion._tag === "status")
		? assertions
		: [IMPLICIT_STATUS, ...assertions]

/** The request an HTTP check sends, as plain data each HTTP client builds from. */
export interface UptimeCheckRequest {
	readonly method: UptimeHttpMethod
	readonly url: string
	readonly headers: Readonly<Record<string, string>>
	/** POST only; the content type is the configured `content-type`, else `text/plain`. */
	readonly body: { readonly text: string; readonly contentType: string } | null
}

/** Our user-agent first so a configured one wins; `extraHeaders` (traceparent) last so they always apply. */
export const uptimeHttpRequest = (
	config: Schema.Schema.Type<typeof UptimeHttpConfig>,
	extraHeaders: Readonly<Record<string, string>> = {},
): UptimeCheckRequest => {
	const contentType = Object.entries(config.headers).find(
		([name]) => name.toLowerCase() === "content-type",
	)?.[1]
	return {
		method: config.method,
		url: config.url,
		headers: { "user-agent": UPTIME_USER_AGENT, ...config.headers, ...extraHeaders },
		body:
			config.method === "POST" && config.body !== undefined
				? { text: config.body, contentType: contentType ?? "text/plain" }
				: null,
	}
}

// --- Up/down machine ---

export const UptimeMonitorStateSnapshot = Schema.Struct({
	status: UptimeMonitorStatus,
	consecutiveFailures: Schema.Number,
	consecutiveSuccesses: Schema.Number,
})
export type UptimeMonitorStateSnapshot = Schema.Schema.Type<typeof UptimeMonitorStateSnapshot>

/**
 * Applies one check: down after `failuresToDown` failures in a row, back up on the first
 * success. A paused monitor never changes here (pausing is a config change, not a check).
 */
export const applyUptimeCheck = (
	state: UptimeMonitorStateSnapshot,
	ok: boolean,
	failuresToDown: number,
): UptimeMonitorStateSnapshot => {
	if (state.status === "paused") return state
	if (ok)
		return { status: "up", consecutiveFailures: 0, consecutiveSuccesses: state.consecutiveSuccesses + 1 }
	const consecutiveFailures = state.consecutiveFailures + 1
	return {
		status: consecutiveFailures >= failuresToDown ? "down" : state.status,
		consecutiveFailures,
		consecutiveSuccesses: 0,
	}
}

/** Appends to the recent ring, keeping the newest `UPTIME_RECENT_LIMIT`. */
export const appendRecentCheck = (
	recent: ReadonlyArray<UptimeRecentCheck>,
	check: UptimeRecentCheck,
): ReadonlyArray<UptimeRecentCheck> => [...recent, check].slice(-UPTIME_RECENT_LIMIT)

export const uptimeKindOf = (config: UptimeMonitorConfig): UptimeMonitorKind => config._tag

// --- Heartbeat deadlines ---

export type UptimeHeartbeatConfig = Schema.Schema.Type<typeof UptimeHeartbeatConfig>

/** Parses a heartbeat's cron schedule in its own time zone; `None` when either is invalid. */
export const parseHeartbeatCron = (expression: string, timezone: string): Option.Option<Cron.Cron> =>
	Result.getSuccess(Cron.parse(expression, timezone))

/**
 * When a heartbeat becomes overdue: the next ping expected after `anchorMs` (the last ping,
 * or when the monitor started waiting), plus the grace. `None` for an unparsable cron.
 */
export const heartbeatDeadline = (config: UptimeHeartbeatConfig, anchorMs: number): Option.Option<number> => {
	const graceMs = config.graceSeconds * 1000
	const schedule = config.schedule
	if (schedule._tag === "interval") return Option.some(anchorMs + schedule.seconds * 1000 + graceMs)
	// `Cron.next` throws for a schedule with no occurrence, such as `0 0 30 2 *`.
	return Option.flatMap(parseHeartbeatCron(schedule.expression, schedule.timezone), (cron) =>
		Option.map(nextCronDate(cron, anchorMs), (next) => next.getTime() + graceMs),
	)
}

const nextCronDate = Option.liftThrowable(Cron.next)

const relativeAge = (ms: number): string => {
	const minutes = Math.max(1, Math.round(ms / 60_000))
	if (minutes < 120) return `${minutes} min ago`
	const hours = Math.round(minutes / 60)
	return hours < 48 ? `${hours} h ago` : `${Math.round(hours / 24)} days ago`
}

/** The error an overdue heartbeat records, e.g. `No ping since 2026-10-26 14:03 UTC (3 h ago)`. */
export const describeMissedHeartbeat = (lastPingAt: number | null, nowMs: number): string => {
	if (lastPingAt === null) return "No ping received yet"
	const at = new Date(lastPingAt).toISOString().slice(0, 16).replace("T", " ")
	return `No ping since ${at} UTC (${relativeAge(nowMs - lastPingAt)})`
}
