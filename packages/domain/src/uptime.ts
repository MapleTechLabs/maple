import { Cron, Option, Result, Schema, Array as Arr, Record as Rec, String as Str } from "effect"
import { OrgId, UptimeIntervalSeconds, UptimeMonitorId, UptimeMonitorStatus } from "@maple/primitives"

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
export const UptimeStepMethod = Schema.Literals(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"])
export type UptimeStepMethod = Schema.Schema.Type<typeof UptimeStepMethod>

/** A variable a step extracts for later steps: `[A-Za-z_][A-Za-z0-9_]*`, used as `{{name}}`. */
export const UptimeVariableName = Schema.String.check(Schema.isPattern(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/u))

/** Where an extracted variable's value comes from in a step's response. */
export const UptimeExtraction = Schema.Struct({
	name: UptimeVariableName,
	from: Schema.Union([
		Schema.TaggedStruct("json_path", { path: NonEmpty }),
		Schema.TaggedStruct("header", { name: NonEmpty }),
	]),
})
export type UptimeExtraction = Schema.Schema.Type<typeof UptimeExtraction>

/** Most steps one multi-step check runs. */
export const UPTIME_MAX_STEPS = 10
/** The whole run's budget: every step shares it. */
const MultiStepTimeoutMs = Schema.Number.check(
	Schema.isInt(),
	Schema.isBetween({ minimum: 1000, maximum: 60000 }),
)

/** Largest request body a check sends, in characters (64 KB). */
export const UPTIME_MAX_BODY_LENGTH = 64 * 1024
/** Longest URL a check requests, in characters. */
export const UPTIME_MAX_URL_LENGTH = 2048
/** Most request headers one request carries. */
export const UPTIME_MAX_HEADERS = 50
export const UPTIME_MAX_HEADER_NAME_LENGTH = 256
/** Longest header value, in characters (8 KB). */
export const UPTIME_MAX_HEADER_VALUE_LENGTH = 8 * 1024
/** Most assertions one request is judged by. */
export const UPTIME_MAX_ASSERTIONS = 20
/** Most variables one step extracts. */
export const UPTIME_MAX_EXTRACTIONS = 20
export const UPTIME_MAX_STEP_NAME_LENGTH = 200
/** Longest value a step may extract into a variable, in characters (4 KB). */
export const UPTIME_MAX_VARIABLE_LENGTH = 4 * 1024
/** Longest failure sentence a check reports. */
export const UPTIME_MAX_ERROR_LENGTH = 500

/** A record schema's check that no key is longer than `maximum`: a key schema's own checks are not run. */
export const uptimeHeaderNamesWithin = (maximum: number) =>
	Schema.makeFilter(
		(headers: Readonly<Record<string, string>>) =>
			Arr.every(Rec.keys(headers), (name) => name.length <= maximum),
		{ expected: `header names of at most ${maximum} characters` },
	)

/**
 * The schemas of what a check sends. `limited` adds the size limits new input must meet; without
 * them the same shapes read rows stored before the limits existed.
 */
const requestSchemas = (limited: boolean) => {
	const text = (maximum: number) =>
		limited ? Schema.String.check(Schema.isMaxLength(maximum)) : Schema.String
	const url = limited ? NonEmpty.check(Schema.isMaxLength(UPTIME_MAX_URL_LENGTH)) : NonEmpty
	const headers = limited
		? Schema.Record(Schema.String, text(UPTIME_MAX_HEADER_VALUE_LENGTH)).check(
				Schema.isMaxProperties(UPTIME_MAX_HEADERS),
				uptimeHeaderNamesWithin(UPTIME_MAX_HEADER_NAME_LENGTH),
			)
		: Schema.Record(Schema.String, Schema.String)
	const body = Schema.optionalKey(text(UPTIME_MAX_BODY_LENGTH))
	const assertions = limited
		? Schema.Array(UptimeAssertion).check(Schema.isMaxLength(UPTIME_MAX_ASSERTIONS))
		: Schema.Array(UptimeAssertion)
	const http = Schema.TaggedStruct("http", {
		url,
		method: UptimeHttpMethod,
		headers,
		body,
		assertions,
		timeoutMs: TimeoutMs,
	})
	const step = Schema.Struct({
		name: limited ? NonEmpty.check(Schema.isMaxLength(UPTIME_MAX_STEP_NAME_LENGTH)) : NonEmpty,
		method: UptimeStepMethod,
		/** May use `{{name}}` for a variable an earlier step extracted, in the URL, headers and body. */
		url,
		headers,
		body,
		assertions,
		extract: limited
			? Schema.Array(UptimeExtraction).check(Schema.isMaxLength(UPTIME_MAX_EXTRACTIONS))
			: Schema.Array(UptimeExtraction),
	})
	const multistep = Schema.TaggedStruct("multistep", {
		steps: Schema.Array(step).check(Schema.isMinLength(1), Schema.isMaxLength(UPTIME_MAX_STEPS)),
		timeoutMs: MultiStepTimeoutMs,
	})
	return { http, step, multistep }
}

const limitedRequests = requestSchemas(true)
const storedRequests = requestSchemas(false)

export const UptimeHttpConfig = limitedRequests.http
export const UptimeStep = limitedRequests.step
export type UptimeStep = Schema.Schema.Type<typeof UptimeStep>
export const UptimeMultiStepConfig = limitedRequests.multistep
export type UptimeMultiStepConfig = Schema.Schema.Type<typeof UptimeMultiStepConfig>

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
 * What a caller without write access sees in place of a check's header value, request body or
 * URL query value. A header value or body sent back as this on update keeps the stored one, so
 * a round-tripped redacted config wipes nothing.
 */
export const UPTIME_REDACTED_HEADER_VALUE = "[redacted]"

/** The stored config; `_tag` always equals the monitor's `kind`. */
export const UptimeMonitorConfig = Schema.Union([
	UptimeHttpConfig,
	UptimeTcpConfig,
	UptimeDnsConfig,
	UptimeMultiStepConfig,
	UptimeHeartbeatConfig,
])
export type UptimeMonitorConfig = Schema.Schema.Type<typeof UptimeMonitorConfig>
/**
 * The config as a row holds it: the same shapes without the size limits, so a monitor saved
 * before them still reads. New input is checked against `UptimeMonitorConfig`.
 */
export const StoredUptimeMonitorConfig = Schema.Union([
	storedRequests.http,
	UptimeTcpConfig,
	UptimeDnsConfig,
	storedRequests.multistep,
	UptimeHeartbeatConfig,
])
export type UptimeProbeConfig = Exclude<UptimeMonitorConfig, { readonly _tag: "heartbeat" }>

/** One check in the per-monitor recent ring (newest last). */
export const UptimeRecentCheck = Schema.Struct({
	at: Schema.Number,
	ok: Schema.Boolean,
	durationMs: Schema.NullOr(Schema.Number),
})
export type UptimeRecentCheck = Schema.Schema.Type<typeof UptimeRecentCheck>
export const UPTIME_RECENT_LIMIT = 60

/** The TLS certificate an HTTPS check's first hop presented. */
export const UptimeCertificate = Schema.Struct({
	/** `notAfter`, epoch ms. */
	expiresAt: Schema.Number,
	subject: Schema.String,
	issuer: Schema.String,
})
export type UptimeCertificate = Schema.Schema.Type<typeof UptimeCertificate>

/**
 * The alert group an HTTPS monitor's certificate is observed under, beside the monitor's own.
 * Spelled like `__total__`, so no real service name takes it.
 */
export const UPTIME_CERTIFICATE_GROUP_KEY = "__tls_certificate__"

/** An uptime incident about the monitor's certificate rather than the monitor being down. */
export const isUptimeCertificateIncident = (incident: {
	readonly signalType: string
	readonly groupKey?: string | null
}): boolean => incident.signalType === "uptime" && incident.groupKey === UPTIME_CERTIFICATE_GROUP_KEY

/** How far ahead of its expiry a certificate opens a warning incident. */
export const UPTIME_CERTIFICATE_WARNING_DAYS = 14
const DAY_MS = 86_400_000

/** True once the certificate is inside the warning window (or already expired). */
export const isCertificateExpiring = (certificate: UptimeCertificate, nowMs: number): boolean =>
	certificate.expiresAt - nowMs < UPTIME_CERTIFICATE_WARNING_DAYS * DAY_MS

/** `Certificate for api.example.com expires in 9 days (2026-11-24)`, or `... expired 2 days ago (...)`. */
export const describeCertificateExpiry = (certificate: UptimeCertificate, nowMs: number): string => {
	const date = Str.slice(0, 10)(new Date(certificate.expiresAt).toISOString())
	const days = Math.floor(Math.abs(certificate.expiresAt - nowMs) / DAY_MS)
	const span = days === 1 ? "1 day" : `${days} days`
	const subject = certificate.subject === "" ? "Certificate" : `Certificate for ${certificate.subject}`
	if (certificate.expiresAt <= nowMs)
		return `${subject} expired ${days === 0 ? "today" : `${span} ago`} (${date})`
	return `${subject} expires ${days === 0 ? "today" : `in ${span}`} (${date})`
}

/** The latest check's detail, kept on the monitor state for the detail page. */
export const UptimeCheckDetail = Schema.Struct({
	at: Schema.Number,
	ok: Schema.Boolean,
	durationMs: Schema.NullOr(Schema.Number),
	statusCode: Schema.NullOr(Schema.Number),
	/** One sentence, e.g. `Status 503, expected 2xx`; null when ok. */
	error: Schema.NullOr(Schema.String),
	traceId: Schema.NullOr(Schema.String),
	/** HTTPS checks: the newest certificate seen, kept through failed checks that could not read one. */
	certificate: Schema.optionalKey(UptimeCertificate),
})
export type UptimeCheckDetail = Schema.Schema.Type<typeof UptimeCheckDetail>

// Probe contract: `/api/internal/uptime-*`, behind the SD_INTERNAL_TOKEN bearer.

export class UptimeProbeTarget extends Schema.Class<UptimeProbeTarget>("UptimeProbeTarget")({
	id: UptimeMonitorId,
	orgId: OrgId,
	name: Schema.String,
	serviceName: Schema.NullOr(Schema.String),
	intervalSeconds: UptimeIntervalSeconds,
	config: Schema.Union([UptimeHttpConfig, UptimeTcpConfig, UptimeDnsConfig, UptimeMultiStepConfig]),
	/** The org's public ingest key: check spans go into the org's own traces. */
	ingestKey: Schema.String,
	/**
	 * When the monitor's settings last changed (epoch ms). A report echoes it, so the API can tell a
	 * check that probed an earlier target; absent from APIs that predate it.
	 */
	revision: Schema.optionalKey(Schema.Number),
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
	/** HTTPS checks whose handshake completed; absent from scrapers that predate it. */
	certificate: Schema.optionalKey(UptimeCertificate),
	/** The target's `revision` the check ran against. */
	targetRevision: Schema.optionalKey(Schema.Number),
}) {}
/** Most reports one `/api/internal/uptime-results` POST may carry; the scraper batches to it. */
export const UPTIME_CHECK_REPORT_BATCH_MAX = 1_000
export const UptimeCheckReportList = Schema.Array(UptimeCheckReport).check(
	Schema.isMaxLength(UPTIME_CHECK_REPORT_BATCH_MAX),
)

export interface UptimeHttpObservation {
	readonly statusCode: number
	readonly durationMs: number
	readonly headers: Readonly<Record<string, string>>
	/** Body prefix as text; `null` when not read (HEAD, binary, too large). */
	readonly body: string | null
}

const statusMatches = (matcher: string, code: number): boolean =>
	Str.endsWith("xx")(matcher) ? Math.floor(code / 100) === Number(matcher[0]) : code === Number(matcher)

const PATH_TOKEN = /[^.[\]]+|\[(\d+)\]/gu
const asJsonArray = Schema.decodeUnknownOption(Schema.Array(Schema.Unknown))
const asJsonObject = Schema.decodeUnknownOption(Schema.Record(Schema.String, Schema.Unknown))

/**
 * Reads `a.b[0].c` (or JSONPath-style `$.a.b[0].c`) from parsed JSON; `None` when a step is
 * missing, `Some(null)` for a JSON null.
 */
export const readJsonPath = (root: unknown, path: string): Option.Option<unknown> =>
	Arr.reduce<RegExpMatchArray, Option.Option<unknown>>(
		Arr.fromIterable(Str.matchAll(PATH_TOKEN)(Str.replace(/^\$\.?/u, "")(path))),
		Option.some(root),
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
							Rec.has(record, key) ? Option.some(record[key]) : Option.none(),
						),
				)
			}),
	)

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))

const jsonText = (value: unknown): string => (typeof value === "string" ? value : encodeJson(value))

/** What a failure sentence quotes of a value the target sent: its start, never all of a long one. */
const QUOTED_VALUE_LENGTH = 100
const quoted = (value: string): string =>
	value.length <= QUOTED_VALUE_LENGTH ? value : `${Str.slice(0, QUOTED_VALUE_LENGTH)(value)}...`

/** A check's failure sentence at the length a report and the monitor's state keep. */
export const capCheckError = (error: string): string =>
	error.length <= UPTIME_MAX_ERROR_LENGTH ? error : `${Str.slice(0, UPTIME_MAX_ERROR_LENGTH - 3)(error)}...`

const parseJson = (body: string | null): Option.Option<unknown> =>
	body === null ? Option.none() : Option.liftThrowable(JSON.parse)(body)

/** The first failing assertion as one sentence, or `null` when every assertion passes. */
export const firstFailedAssertion = (
	assertions: ReadonlyArray<UptimeAssertion>,
	observed: UptimeHttpObservation,
): string | null => {
	const failures = Arr.flatMap(assertions, (assertion): ReadonlyArray<string> => {
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
				const found = observed.body !== null && Str.includes(assertion.value)(observed.body)
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
					: [`JSON path ${assertion.path} is ${quoted(actual)}, expected ${assertion.value}`]
			}
			case "header": {
				const actual = observed.headers[Str.toLowerCase(assertion.name)]
				if (actual === undefined) return [`Header ${assertion.name} missing`]
				if (assertion.op === "exists") return []
				const expected = assertion.value
				const ok = assertion.op === "equals" ? actual === expected : Str.includes(expected)(actual)
				return ok
					? []
					: [
							`Header ${assertion.name} is "${quoted(actual)}", expected ${assertion.op} "${expected}"`,
						]
			}
		}
	})
	const first = failures[0]
	return first === undefined ? null : capCheckError(first)
}

/** `service.name` of the spans the scraper exports per check; the service map drops it. */
export const UPTIME_SERVICE_NAME = "maple-uptime"
/** The resource attribute naming the monitor a check span belongs to. */
export const UPTIME_MONITOR_ID_ATTRIBUTE = "maple.uptime.monitor_id"
/** The check span attribute of each HTTP phase, in ms; written by the scraper, read by the breakdown. */
export const UPTIME_TIMING_ATTRIBUTES = {
	dnsMs: "maple.uptime.timing.dns_ms",
	connectMs: "maple.uptime.timing.connect_ms",
	tlsMs: "maple.uptime.timing.tls_ms",
	ttfbMs: "maple.uptime.timing.ttfb_ms",
	transferMs: "maple.uptime.timing.transfer_ms",
} as const
/** `service.namespace` of Maple's own synthetic services, so users can filter them out. */
export const MAPLE_SERVICES_NAMESPACE = "maple-services"

/** Maple's own synthetic services; checks recorded before the namespace existed have none and match by name. */
export const isMapleService = (row: { readonly serviceName: string; readonly serviceNamespace: string }) =>
	row.serviceNamespace === MAPLE_SERVICES_NAMESPACE ||
	(row.serviceNamespace === "" && row.serviceName === UPTIME_SERVICE_NAME)

export const UPTIME_USER_AGENT = "maple-uptime/1.0"

/** A monitor without a status rule still expects success: a 503 must not read as up. */
const IMPLICIT_STATUS: UptimeAssertion = { _tag: "status", op: "is", value: "2xx" }

/** The assertions a check is judged by: the configured ones, plus `2xx` when none rules on status. */
export const effectiveAssertions = (
	assertions: ReadonlyArray<UptimeAssertion>,
): ReadonlyArray<UptimeAssertion> =>
	Arr.some(assertions, (assertion) => assertion._tag === "status")
		? assertions
		: [IMPLICIT_STATUS, ...assertions]

/** The request an HTTP check sends, as plain data each HTTP client builds from. */
export interface UptimeCheckRequest {
	readonly method: UptimeStepMethod
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
	const contentType = Option.getOrUndefined(
		Option.map(
			Arr.findFirst(
				Rec.toEntries(config.headers),
				([name]) => Str.toLowerCase(name) === "content-type",
			),
			([, value]) => value,
		),
	)
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
export const describeMissedHeartbeat = (lastPingAt: number | null, nowMs: number): string =>
	lastPingAt === null ? "No ping received yet" : `No ping since ${sinceText(lastPingAt, nowMs)}`

const sinceText = (at: number, nowMs: number): string =>
	`${Str.replace("T", " ")(Str.slice(0, 16)(new Date(at).toISOString()))} UTC (${relativeAge(nowMs - at)})`

/** How long a probe's last check vouches for it: 3 intervals, and never under 5 minutes. */
export const probeStaleAfterMs = (intervalSeconds: number): number =>
	Math.max(3 * intervalSeconds * 1000, 5 * 60_000)

/** What a probe with no recent check reports, e.g. `No check result since 2026-10-26 14:03 UTC (12 min ago)`. */
export const describeStaleProbe = (lastCheckAt: number | null, nowMs: number): string =>
	lastCheckAt === null ? "No check result yet" : `No check result since ${sinceText(lastCheckAt, nowMs)}`

const VARIABLE_REFERENCE = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/gu
/** One reference with its name captured, for splitting a template into literal parts and names. */
const VARIABLE_PART = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/u

/** The variable names a template refers to, in order. */
export const variablesIn = (template: string): ReadonlyArray<string> =>
	Arr.map(Arr.fromIterable(Str.matchAll(VARIABLE_REFERENCE)(template)), (match) => match[1] ?? "")

/**
 * `template` with each `{{name}}` replaced by its value. A name with no value is an error naming it:
 * the run stops there rather than send a literal `{{name}}`.
 */
export const interpolate = (
	template: string,
	variables: Readonly<Record<string, string>>,
): Result.Result<string, string> => {
	const missing = Arr.findFirst(variablesIn(template), (name) => !Rec.has(variables, name))
	if (Option.isSome(missing)) return Result.fail(missing.value)
	// One pass over the template: split on the capturing pattern puts each name at an odd index, so a
	// value is inserted literally and never read as a template or a replacement pattern.
	const parts = Str.split(template, VARIABLE_PART)
	return Result.succeed(
		Arr.join(
			Arr.map(parts, (part, index) => (index % 2 === 1 ? (variables[part] ?? "") : part)),
			"",
		),
	)
}

/** Why a template could not be filled: a variable with no value, or a result past the length allowed. */
export type InterpolationFailure =
	| { readonly _tag: "missing"; readonly name: string }
	| { readonly _tag: "too_long" }

/**
 * `interpolate`, refusing a result longer than `maximum`. The length is summed from the parts
 * first, so an oversized result is never built.
 */
export const interpolateWithin = (
	template: string,
	variables: Readonly<Record<string, string>>,
	maximum: number,
): Result.Result<string, InterpolationFailure> => {
	const missing = Arr.findFirst(variablesIn(template), (name) => !Rec.has(variables, name))
	if (Option.isSome(missing)) return Result.fail({ _tag: "missing", name: missing.value })
	const parts = Arr.map(Str.split(template, VARIABLE_PART), (part, index) =>
		index % 2 === 1 ? (variables[part] ?? "") : part,
	)
	const length = Arr.reduce(parts, 0, (total, part) => total + part.length)
	return length > maximum ? Result.fail({ _tag: "too_long" }) : Result.succeed(Arr.join(parts, ""))
}

const URL_SCHEME_AND_AUTHORITY = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/([^/?#]*)/u
/** An authority that is one variable, with or without a literal port. */
const VARIABLE_AUTHORITY = /^\{\{\s*[A-Za-z_][A-Za-z0-9_]*\s*\}\}(:\d+)?$/u
const STARTS_WITH_VARIABLE = /^\{\{\s*[A-Za-z_][A-Za-z0-9_]*\s*\}\}/u

/**
 * Who chooses the host a step URL template requests:
 * - `literal`: the template does, and `origin` is it (null when its host does not parse).
 * - `variable`: one variable is the whole host, or the template starts with a variable.
 * - `mixed`: a variable sits inside the host or directly after it with no `/`, `?` or `#` between,
 *   so a value could extend the host. `origin` is what the text before that variable names.
 */
export type StepUrlHost =
	| { readonly _tag: "literal"; readonly origin: string | null }
	| { readonly _tag: "variable" }
	| { readonly _tag: "mixed"; readonly origin: string | null }

/** The origin of an http(s) URL with a host; null for anything else. */
const originOrNull = (url: string): string | null => {
	if (!URL.canParse(url)) return null
	const parsed = new URL(url)
	return parsed.host === "" || parsed.origin === "null" ? null : parsed.origin
}

/** The one rule for a step URL's host, read by the save-time check and by the probe. */
export const stepUrlHost = (template: string): StepUrlHost => {
	const trimmed = Str.trim(template)
	const match = URL_SCHEME_AND_AUTHORITY.exec(trimmed)
	if (match === null) {
		if (STARTS_WITH_VARIABLE.test(trimmed)) return { _tag: "variable" }
		// No `scheme://`: only a template with no variable is left for the URL check to judge.
		return !Str.includes("{{")(trimmed)
			? { _tag: "literal", origin: originOrNull(trimmed) }
			: { _tag: "mixed", origin: null }
	}
	const authority = match[1] ?? ""
	const prefix = match[0]
	if (!Str.includes("{{")(authority)) return { _tag: "literal", origin: originOrNull(prefix) }
	if (VARIABLE_AUTHORITY.test(authority)) return { _tag: "variable" }
	return { _tag: "mixed", origin: originOrNull(Str.split(prefix, "{{")[0]) }
}

/** Why a step URL template cannot be saved, or null: a variable may not be part of its host. */
export const stepUrlTemplateProblem = (template: string): string | null => {
	const host = stepUrlHost(template)
	if (host._tag === "mixed")
		return "a variable can't be part of the URL's host: end the host with a / before the variable, or make the whole host one variable"
	return host._tag === "literal" && host.origin === null && Str.includes("{{")(template)
		? "the URL needs a valid http(s) host before its first variable"
		: null
}

/**
 * Whether a filled step URL still requests the host its template names. A template whose host is
 * one variable has none to keep; any other must fill to the origin of its literal part.
 */
export const filledUrlKeepsHost = (template: string, filled: string): boolean => {
	const host = stepUrlHost(template)
	if (host._tag === "variable") return true
	return host.origin !== null && originOrNull(Str.trim(filled)) === host.origin
}

/** Every template a step sends: its URL, header values and body. */
const stepTemplates = (step: UptimeStep): ReadonlyArray<string> => [
	step.url,
	...Rec.values(step.headers),
	...(step.body === undefined ? [] : [step.body]),
]

/**
 * The first reference to a variable no earlier step extracts, as a sentence, or null when every
 * reference resolves. Also refuses a body on GET or HEAD, and a name extracted twice.
 */
export const multiStepConfigProblem = (config: UptimeMultiStepConfig): string | null => {
	interface Scan {
		readonly known: ReadonlySet<string>
		readonly problem: string | null
	}
	const start: Scan = { known: new Set(), problem: null }
	const problem = Arr.reduce(config.steps, start, (acc, step, index): Scan => {
		if (acc.problem !== null) return acc
		const label = `Step ${index + 1} (${step.name})`
		// Names identify a step's hidden header values across edits, so two steps never share one.
		if (Arr.some(config.steps.slice(0, index), (earlier) => earlier.name === step.name))
			return { ...acc, problem: `${label}: another step already has this name` }
		if (step.body !== undefined && (step.method === "GET" || step.method === "HEAD"))
			return { ...acc, problem: `${label}: a request body needs POST, PUT, PATCH or DELETE` }
		// The probe keeps its user-agent across redirects to other hosts, so it never carries a variable.
		const agent = Arr.findFirst(
			Rec.toEntries(step.headers),
			([name, value]) => Str.toLowerCase(name) === "user-agent" && variablesIn(value).length > 0,
		)
		if (Option.isSome(agent))
			return { ...acc, problem: `${label}: the User-Agent header can't use a variable` }
		const hostProblem = stepUrlTemplateProblem(step.url)
		if (hostProblem !== null) return { ...acc, problem: `${label}: ${hostProblem}` }
		const unknown = Arr.findFirst(
			Arr.flatMap(stepTemplates(step), variablesIn),
			(name) => !acc.known.has(name),
		)
		if (Option.isSome(unknown))
			return {
				...acc,
				problem: `${label} uses {{${unknown.value}}}, which no earlier step extracts`,
			}
		const duplicate = Arr.findFirst(step.extract, (extraction) => acc.known.has(extraction.name))
		if (Option.isSome(duplicate))
			return {
				...acc,
				problem: `${label} extracts ${duplicate.value.name}, which an earlier step already set`,
			}
		const repeated = Arr.findFirst(step.extract, (extraction, at) =>
			Arr.some(step.extract.slice(0, at), (earlier) => earlier.name === extraction.name),
		)
		if (Option.isSome(repeated))
			return { ...acc, problem: `${label} extracts ${repeated.value.name} twice` }
		return { known: new Set([...acc.known, ...Arr.map(step.extract, (e) => e.name)]), problem: null }
	})
	return problem.problem
}

/** The values a step's extractions read from its response, or the first one that is missing. */
export const extractVariables = (
	extract: ReadonlyArray<UptimeExtraction>,
	observed: UptimeHttpObservation,
): Result.Result<Readonly<Record<string, string>>, string> => {
	const none: Result.Result<Readonly<Record<string, string>>, string> = Result.succeed({})
	return Arr.reduce(extract, none, (acc, extraction) =>
		Result.flatMap(acc, (values) => {
			const source = extraction.from
			const value =
				source._tag === "header"
					? Option.fromNullishOr(observed.headers[Str.toLowerCase(source.name)])
					: Option.map(
							Option.flatMap(parseJson(observed.body), (json) =>
								readJsonPath(json, source.path),
							),
							jsonText,
						)
			const missing =
				source._tag === "header"
					? `Header ${source.name} missing, so ${extraction.name} could not be set`
					: `JSON path ${source.path} not found, so ${extraction.name} could not be set`
			return Option.match(value, {
				onNone: () => Result.fail(missing),
				onSome: (found) =>
					found.length > UPTIME_MAX_VARIABLE_LENGTH
						? Result.fail(
								`${extraction.name} is longer than ${UPTIME_MAX_VARIABLE_LENGTH / 1024} KB, more than a variable holds`,
							)
						: Result.succeed({ ...values, [extraction.name]: found }),
			})
		}),
	)
}

const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u
// Tab, visible ASCII and Latin-1: what an HTTP/1.1 client sends; CR, LF and other controls are not.
const HEADER_VALUE = /^[\t\u0020-\u007e\u0080-\u00ff]*$/u

/** Why a header cannot be sent, or null: an invalid name, or a value with a control or non-Latin-1 character. */
export const headerProblem = (name: string, value: string): string | null =>
	!HEADER_NAME.test(name)
		? `Header name '${name}' is not a valid HTTP header name`
		: HEADER_VALUE.test(value)
			? null
			: `Header ${name} has a character an HTTP header cannot carry (a line break, a control or non-Latin-1 character)`

/** The first header in `headers` that cannot be sent, as a sentence, or null. */
export const headersProblem = (headers: Readonly<Record<string, string>>): string | null =>
	Option.getOrNull(
		Arr.findFirst(Rec.toEntries(headers), ([name, value]) => headerProblem(name, value) !== null).pipe(
			Option.map(([name, value]) => headerProblem(name, value) ?? ""),
		),
	)
