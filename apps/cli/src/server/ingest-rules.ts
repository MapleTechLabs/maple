import { IngestRuleSpec } from "@maple/domain/ingest-rules"
import {
	applyRules,
	compileRules,
	type AttrMap,
	type AttrValue,
	type CompiledRules,
	type RuleRecord,
} from "@maple/ingest-rules"
import { Option, Result, Schema } from "effect"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import {
	traceIdHex,
	type AnyValue,
	type Exemplar,
	type KeyValue,
	type LogsRequest,
	type MetricsRequest,
	type TraceRequest,
} from "./otlp/encode"

// Local mode's ingest rules: the same drop/redact rules as the gateway (docs/ingest-rules.md),
// read from a JSON file instead of Postgres. Applied to the decoded request before encoding.

/** `~/.maple/ingest-rules.json`, or `MAPLE_LOCAL_INGEST_RULES`. */
export const localIngestRulesPath = (): string =>
	process.env.MAPLE_LOCAL_INGEST_RULES ?? path.join(os.homedir(), ".maple", "ingest-rules.json")

const LocalRule = Schema.Struct({
	name: Schema.optionalKey(Schema.String),
	enabled: Schema.optionalKey(Schema.Boolean),
	...IngestRuleSpec.fields,
})
const LocalRulesFile = Schema.fromJsonString(Schema.Array(LocalRule))
const decodeRulesFile = Schema.decodeUnknownResult(LocalRulesFile)

export interface LocalIngestRules {
	readonly compiled: CompiledRules
	/** Why the file or a rule in it was skipped; logged once per file version. */
	readonly problems: ReadonlyArray<string>
}

const EMPTY: LocalIngestRules = { compiled: compileRules([], "local"), problems: [] }

/** Parses a rules file body. Invalid rules are skipped and named, never fatal. */
export const parseLocalIngestRules = (body: string): LocalIngestRules => {
	const decoded = decodeRulesFile(body)
	if (Result.isFailure(decoded))
		return { ...EMPTY, problems: [`ingest rules file is invalid: ${decoded.failure.message}`] }
	const enabled = decoded.success.filter((rule) => rule.enabled !== false)
	const compiled = compileRules(
		enabled.map((rule) => ({ signals: rule.signals, conditions: rule.conditions, action: rule.action })),
		"local",
	)
	return {
		compiled,
		problems: compiled.invalid.map(
			(invalid) =>
				`ingest rule ${enabled[invalid.index]?.name ?? invalid.index + 1} skipped: ${invalid.problems.join("; ")}`,
		),
	}
}

/** Re-reads the file only when its mtime changes, so edits apply without a restart. */
export const makeLocalIngestRulesSource = (file: string) => {
	let cached: { readonly mtimeMs: number; readonly rules: LocalIngestRules } | null = null
	/** `reloaded` is true the first time a file version is read, so its problems log once. */
	return (): { readonly rules: LocalIngestRules; readonly reloaded: boolean } => {
		const stat = Result.try(() => fs.statSync(file))
		if (Result.isFailure(stat)) return { rules: EMPTY, reloaded: false }
		if (cached !== null && cached.mtimeMs === stat.success.mtimeMs)
			return { rules: cached.rules, reloaded: false }
		const body = Result.try(() => fs.readFileSync(file, "utf8"))
		const rules = Result.isFailure(body) ? EMPTY : parseLocalIngestRules(body.success)
		cached = { mtimeMs: stat.success.mtimeMs, rules }
		return { rules, reloaded: true }
	}
}

// OTLP AnyValue <-> engine values. Unchanged values keep their original AnyValue, so an
// integral double is never rewritten as an int.

const base64ToBytes = (value: string) => Uint8Array.from(atob(value), (char) => char.charCodeAt(0))
const bytesToBase64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes))

const toValue = (value: AnyValue | undefined): AttrValue => {
	if (value === undefined) return ""
	if (value.stringValue !== undefined) return value.stringValue
	if (value.boolValue !== undefined) return value.boolValue
	if (value.intValue !== undefined) return BigInt(value.intValue)
	if (value.doubleValue !== undefined) return Number(value.doubleValue)
	if (value.bytesValue !== undefined) return base64ToBytes(value.bytesValue)
	if (value.arrayValue !== undefined) return (value.arrayValue.values ?? []).map(toValue)
	if (value.kvlistValue !== undefined) return toMap(value.kvlistValue.values)
	return ""
}
const toMap = (attributes: ReadonlyArray<KeyValue> | undefined): AttrMap =>
	Object.fromEntries((attributes ?? []).map((kv) => [kv.key ?? "", toValue(kv.value)]))

const isAttrList = (value: AttrValue): value is ReadonlyArray<AttrValue> => Array.isArray(value)

const fromValue = (value: AttrValue): AnyValue => {
	if (typeof value === "string") return { stringValue: value }
	if (typeof value === "boolean") return { boolValue: value }
	if (typeof value === "bigint") return { intValue: value.toString() }
	if (typeof value === "number") return { doubleValue: value }
	if (value instanceof Uint8Array) return { bytesValue: bytesToBase64(value) }
	if (isAttrList(value)) return { arrayValue: { values: value.map(fromValue) } }
	return { kvlistValue: { values: fromMap(value, undefined) } }
}
const fromMap = (map: AttrMap, original: ReadonlyArray<KeyValue> | undefined): KeyValue[] => {
	const before = new Map((original ?? []).map((kv) => [kv.key ?? "", kv]))
	return Object.entries(map).map(([key, value]) => {
		const kept = before.get(key)
		return kept !== undefined && sameValue(kept.value, value) ? kept : { key, value: fromValue(value) }
	})
}
const sameValue = (original: AnyValue | undefined, value: AttrValue): boolean =>
	JSON.stringify(toValue(original), jsonSafe) === JSON.stringify(value, jsonSafe)
const jsonSafe = (_key: string, value: unknown) =>
	typeof value === "bigint" ? `${value}n` : value instanceof Uint8Array ? Array.from(value) : value

const safeTraceId = (raw: string | undefined): string | undefined =>
	Option.getOrUndefined(Result.getSuccess(Result.try(() => traceIdHex(raw, "traceId"))))

const SPAN_KINDS = ["unspecified", "internal", "server", "client", "producer", "consumer"] as const
const SPAN_STATUSES = ["unset", "ok", "error"] as const

const isObject = (value: unknown): value is object => typeof value === "object" && value !== null
const isTraceRequest = (value: unknown): value is TraceRequest =>
	isObject(value) && "resourceSpans" in value && Array.isArray(value.resourceSpans)
const isLogsRequest = (value: unknown): value is LogsRequest =>
	isObject(value) && "resourceLogs" in value && Array.isArray(value.resourceLogs)
const isMetricsRequest = (value: unknown): value is MetricsRequest =>
	isObject(value) && "resourceMetrics" in value && Array.isArray(value.resourceMetrics)

export interface LocalRuleOutcome {
	readonly dropped: number
	readonly redactedValues: number
}

/** Drops and redacts in place. Resources and scopes left empty are removed. */
export const applyLocalIngestRules = (
	signal: "traces" | "logs" | "metrics",
	request: unknown,
	compiled: CompiledRules,
): LocalRuleOutcome => {
	if (compiled.rules.length === 0) return { dropped: 0, redactedValues: 0 }
	let dropped = 0
	let redactedValues = 0
	const run = (record: RuleRecord): RuleRecord | null => {
		const outcome = applyRules(compiled, record)
		if (outcome._tag === "dropped") {
			dropped += 1
			return null
		}
		outcome.redactions.forEach((count) => {
			redactedValues += count
		})
		return outcome.redactions.size > 0 ? outcome.record : record
	}
	if (signal === "traces" && isTraceRequest(request)) applyToTraces(request, run)
	if (signal === "logs" && isLogsRequest(request)) applyToLogs(request, run)
	if (signal === "metrics" && isMetricsRequest(request)) applyToMetrics(request, run)
	return { dropped, redactedValues }
}

type Run = (record: RuleRecord) => RuleRecord | null

interface Resource {
	attributes?: KeyValue[]
}

/** The first kept record's rewritten resource, if a rule changed it. */
const writeResource = (
	resource: Resource | undefined,
	records: ReadonlyArray<RuleRecord>,
	before: AttrMap,
) => {
	const changed = records.find((record) => record.resource !== before)
	if (resource !== undefined && changed !== undefined)
		resource.attributes = fromMap(changed.resource, resource.attributes)
}

const applyToTraces = (request: TraceRequest, run: Run) => {
	request.resourceSpans = (request.resourceSpans ?? []).filter((resourceSpans) => {
		const resource = toMap(resourceSpans.resource?.attributes)
		const kept: Array<RuleRecord> = []
		resourceSpans.scopeSpans = (resourceSpans.scopeSpans ?? []).filter((scopeSpans) => {
			scopeSpans.spans = (scopeSpans.spans ?? []).filter((span) => {
				const record = run({
					signal: "traces",
					resource,
					attributes: toMap(span.attributes),
					name: span.name ?? "",
					traceId: safeTraceId(span.traceId),
					spanKind: SPAN_KINDS[span.kind ?? 0] ?? "unspecified",
					spanStatus: SPAN_STATUSES[span.status?.code ?? 0] ?? "unset",
					events: (span.events ?? []).map((event) => ({
						name: event.name ?? "",
						attributes: toMap(event.attributes),
					})),
				})
				if (record === null) return false
				kept.push(record)
				span.attributes = fromMap(record.attributes, span.attributes)
				record.events?.forEach((event, index) => {
					const original = span.events?.[index]
					if (original !== undefined)
						original.attributes = fromMap(event.attributes, original.attributes)
				})
				return true
			})
			return scopeSpans.spans.length > 0
		})
		writeResource(resourceSpans.resource, kept, resource)
		return resourceSpans.scopeSpans.length > 0
	})
}

const applyToLogs = (request: LogsRequest, run: Run) => {
	request.resourceLogs = (request.resourceLogs ?? []).filter((resourceLogs) => {
		const resource = toMap(resourceLogs.resource?.attributes)
		const kept: Array<RuleRecord> = []
		resourceLogs.scopeLogs = (resourceLogs.scopeLogs ?? []).filter((scopeLogs) => {
			scopeLogs.logRecords = (scopeLogs.logRecords ?? []).filter((log) => {
				const body = log.body === undefined ? undefined : toValue(log.body)
				const record = run({
					signal: "logs",
					resource,
					attributes: toMap(log.attributes),
					body,
					severityNumber: log.severityNumber,
					severityText: log.severityText,
					traceId: safeTraceId(log.traceId),
				})
				if (record === null) return false
				kept.push(record)
				log.attributes = fromMap(record.attributes, log.attributes)
				if (record.body !== undefined && record.body !== body) log.body = fromValue(record.body)
				return true
			})
			return scopeLogs.logRecords.length > 0
		})
		writeResource(resourceLogs.resource, kept, resource)
		return resourceLogs.scopeLogs.length > 0
	})
}

interface DataPoint {
	attributes?: KeyValue[]
	exemplars?: Exemplar[]
}

const applyToMetrics = (request: MetricsRequest, run: Run) => {
	request.resourceMetrics = (request.resourceMetrics ?? []).filter((resourceMetrics) => {
		const resource = toMap(resourceMetrics.resource?.attributes)
		const kept: Array<RuleRecord> = []
		const keepPoints = <P extends DataPoint>(name: string, points: ReadonlyArray<P> | undefined): P[] =>
			(points ?? []).filter((point) => {
				const record = run({ signal: "metrics", resource, attributes: toMap(point.attributes), name })
				if (record === null) return false
				kept.push(record)
				point.attributes = fromMap(record.attributes, point.attributes)
				return true
			})
		resourceMetrics.scopeMetrics = (resourceMetrics.scopeMetrics ?? []).filter((scopeMetrics) => {
			scopeMetrics.metrics = (scopeMetrics.metrics ?? []).filter((metric) => {
				const name = metric.name ?? ""
				if (metric.gauge !== undefined)
					metric.gauge.dataPoints = keepPoints(name, metric.gauge.dataPoints)
				if (metric.sum !== undefined) metric.sum.dataPoints = keepPoints(name, metric.sum.dataPoints)
				if (metric.histogram !== undefined)
					metric.histogram.dataPoints = keepPoints(name, metric.histogram.dataPoints)
				if (metric.exponentialHistogram !== undefined)
					metric.exponentialHistogram.dataPoints = keepPoints(
						name,
						metric.exponentialHistogram.dataPoints,
					)
				const remaining =
					(metric.gauge?.dataPoints?.length ?? 0) +
					(metric.sum?.dataPoints?.length ?? 0) +
					(metric.histogram?.dataPoints?.length ?? 0) +
					(metric.exponentialHistogram?.dataPoints?.length ?? 0)
				return remaining > 0 || metric.summary !== undefined
			})
			return scopeMetrics.metrics.length > 0
		})
		writeResource(resourceMetrics.resource, kept, resource)
		return resourceMetrics.scopeMetrics.length > 0
	})
}
