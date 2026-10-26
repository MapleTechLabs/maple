import { AlertDestinationId } from "@maple/domain/http"
import { Schema } from "effect"

// The uptime form's draft: every field as the inputs hold it, strings until the payload is built.

export const MonitorKind = Schema.Literals(["http", "tcp", "dns", "heartbeat"])
export type MonitorKind = typeof MonitorKind.Type

export const HttpMethod = Schema.Literals(["GET", "HEAD", "POST"])
export const RecordType = Schema.Literals(["A", "AAAA", "CNAME", "MX", "TXT", "NS"])
export const ScheduleMode = Schema.Literals(["interval", "cron"])
export const EveryUnit = Schema.Literals(["seconds", "minutes", "hours"])
export const AssertionType = Schema.Literals(["status", "latency", "body", "json_path", "header"])
export type AssertionType = typeof AssertionType.Type

/** One "Up when" row: `target` is the JSON path or header name, `value` what it is compared with. */
export const AssertionDraft = Schema.Struct({
	id: Schema.Number,
	type: AssertionType,
	op: Schema.String,
	target: Schema.String,
	value: Schema.String,
})
export type AssertionDraft = typeof AssertionDraft.Type

/** The free-text inputs, addressed by name from one Message. */
export const TextField = Schema.Literals([
	"name",
	"url",
	"headers",
	"body",
	"failuresToDown",
	"timeoutMs",
	"host",
	"port",
	"hostname",
	"expected",
	"everyValue",
	"cronExpression",
	"cronTimezone",
	"graceMinutes",
	"serviceName",
])
export type TextField = typeof TextField.Type

export const Form = Schema.Struct({
	kind: MonitorKind,
	name: Schema.String,
	/** The user typed a name; until then it follows the URL. */
	isNameEdited: Schema.Boolean,
	method: HttpMethod,
	url: Schema.String,
	/** `Name: value`, one header per line. */
	headers: Schema.String,
	body: Schema.String,
	assertions: Schema.Array(AssertionDraft),
	nextAssertionId: Schema.Number,
	intervalSeconds: Schema.Number,
	failuresToDown: Schema.String,
	timeoutMs: Schema.String,
	host: Schema.String,
	port: Schema.String,
	hostname: Schema.String,
	recordType: RecordType,
	expected: Schema.String,
	scheduleMode: ScheduleMode,
	everyValue: Schema.String,
	everyUnit: EveryUnit,
	cronExpression: Schema.String,
	cronTimezone: Schema.String,
	graceMinutes: Schema.String,
	serviceName: Schema.String,
	destinationIds: Schema.Array(AlertDestinationId),
})
export type Form = typeof Form.Type

/** The two rows a new HTTP check starts with: a 2xx status and a 2 s response. */
export const DEFAULT_ASSERTIONS: ReadonlyArray<AssertionDraft> = [
	{ id: 1, type: "status", op: "is", target: "", value: "2xx" },
	{ id: 2, type: "latency", op: "under", target: "", value: "2000" },
]

export const emptyForm = (fields: Partial<Form> = {}): Form => ({
	kind: "http",
	name: "",
	isNameEdited: false,
	method: "GET",
	url: "",
	headers: "",
	body: "",
	assertions: DEFAULT_ASSERTIONS,
	nextAssertionId: 3,
	intervalSeconds: 60,
	failuresToDown: "2",
	timeoutMs: "10000",
	host: "",
	port: "",
	hostname: "",
	recordType: "A",
	expected: "",
	scheduleMode: "interval",
	everyValue: "24",
	everyUnit: "hours",
	cronExpression: "0 2 * * *",
	cronTimezone: "UTC",
	graceMinutes: "30",
	serviceName: "",
	destinationIds: [],
	...fields,
})

/** The operators each assertion type offers, first one the default. */
export const ASSERTION_OPS = {
	status: [
		{ value: "is", label: "is" },
		{ value: "is_not", label: "is not" },
	],
	latency: [{ value: "under", label: "under" }],
	body: [
		{ value: "contains", label: "contains" },
		{ value: "not_contains", label: "does not contain" },
	],
	json_path: [
		{ value: "equals", label: "equals" },
		{ value: "exists", label: "exists" },
	],
	header: [
		{ value: "equals", label: "equals" },
		{ value: "contains", label: "contains" },
		{ value: "exists", label: "exists" },
	],
} satisfies Record<AssertionType, ReadonlyArray<{ value: string; label: string }>>

export const ASSERTION_TYPES: ReadonlyArray<{ value: AssertionType; label: string }> = [
	{ value: "status", label: "Status code" },
	{ value: "latency", label: "Response time" },
	{ value: "body", label: "Body" },
	{ value: "json_path", label: "JSON path" },
	{ value: "header", label: "Header" },
]

export const INTERVALS: ReadonlyArray<{ seconds: number; label: string }> = [
	{ seconds: 30, label: "30s" },
	{ seconds: 60, label: "1m" },
	{ seconds: 300, label: "5m" },
	{ seconds: 900, label: "15m" },
]
