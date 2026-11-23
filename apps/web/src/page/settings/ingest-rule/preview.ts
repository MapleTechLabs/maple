import type { IngestRuleSpec } from "@maple/domain/ingest-rules"
import {
	applyRules,
	type AttrMap,
	type AttrValue,
	compileRules,
	hasAttr,
	logSampleToRecord,
	type RuleRecord,
	spanSampleToRecord,
} from "@maple/ingest-rules"
import { Schema, Array as Arr, String as Str, Struct } from "effect"

const encodeAttrJson = Schema.encodeSync(
	Schema.fromJsonString(Schema.Unknown, {
		replacer: (_key: string, inner: unknown) => (typeof inner === "bigint" ? String(inner) : inner),
	}),
)

// Recent rows the preview runs the draft over, and what the draft would do to them.

const StringMap = Schema.Record(Schema.String, Schema.String)

export const LogSample = Schema.Struct({
	serviceName: Schema.String,
	body: Schema.String,
	severityNumber: Schema.Number,
	severityText: Schema.String,
	traceId: Schema.String,
	logAttributes: StringMap,
	resourceAttributes: StringMap,
})
export type LogSample = typeof LogSample.Type

export const SpanSample = Schema.Struct({
	serviceName: Schema.String,
	spanName: Schema.String,
	spanKind: Schema.String,
	statusCode: Schema.String,
	statusMessage: Schema.optionalKey(Schema.String),
	traceId: Schema.String,
	spanAttributes: StringMap,
	resourceAttributes: StringMap,
})
export type SpanSample = typeof SpanSample.Type

export const PreviewSignal = Schema.Literals(["traces", "logs"])
export type PreviewSignal = typeof PreviewSignal.Type

export const Samples = Schema.Union([
	Schema.TaggedStruct("logs", { rows: Schema.Array(LogSample) }),
	Schema.TaggedStruct("traces", { rows: Schema.Array(SpanSample) }),
])
export type Samples = typeof Samples.Type

/** Hashes in the preview use this salt, so they never match the org's stored hashes. */
export const PREVIEW_SALT = "maple-settings-preview"

export const recordsOf = (samples: Samples): ReadonlyArray<RuleRecord> =>
	samples._tag === "logs"
		? Arr.map(samples.rows, logSampleToRecord)
		: Arr.map(samples.rows, spanSampleToRecord)

export interface ValueChange {
	readonly where: string
	readonly key: string
	readonly before: string
	/** `null` when the value was removed. */
	readonly after: string | null
}

/** What a parse rule wrote: a new or changed attribute, the severity or the time. */
export interface ParsedField {
	readonly key: string
	readonly value: string
}

export type PreviewRow =
	| { readonly _tag: "dropped"; readonly record: RuleRecord }
	| { readonly _tag: "redacted"; readonly record: RuleRecord; readonly changes: ReadonlyArray<ValueChange> }
	| {
			readonly _tag: "parsed"
			readonly record: RuleRecord
			readonly fields: ReadonlyArray<ParsedField>
			/** `<step>: <reason>`, also written as `maple.parse.error`. */
			readonly failure: string | null
	  }

export interface PreviewResult {
	readonly total: number
	readonly dropped: number
	readonly redacted: number
	readonly parsed: number
	readonly failed: number
	readonly rows: ReadonlyArray<PreviewRow>
}

const show = (value: AttrValue | undefined): string =>
	value === undefined
		? ""
		: typeof value === "string" || typeof value === "bigint"
			? String(value)
			: encodeAttrJson(value)

const mapChanges = (where: string, before: AttrMap, after: AttrMap): ReadonlyArray<ValueChange> =>
	Arr.flatMap(Struct.keys(before), (key) => {
		const was = show(before[key])
		const now = hasAttr(after, key) ? show(after[key]) : null
		return now === was ? [] : [{ where, key, before: was, after: now }]
	})

const changesOf = (before: RuleRecord, after: RuleRecord): ReadonlyArray<ValueChange> => [
	...mapChanges("attribute", before.attributes, after.attributes),
	...mapChanges("resource", before.resource, after.resource),
	...(before.body !== undefined && show(before.body) !== show(after.body)
		? [{ where: "body", key: "body", before: show(before.body), after: show(after.body) }]
		: []),
	...(before.statusMessage !== undefined && before.statusMessage !== after.statusMessage
		? [
				{
					where: "status",
					key: "message",
					before: before.statusMessage,
					after: after.statusMessage ?? "",
				},
			]
		: []),
	...Arr.flatMap(before.events ?? [], (event, index) =>
		mapChanges(`event ${event.name}`, event.attributes, after.events?.[index]?.attributes ?? {}),
	),
]

const PARSE_ERROR = "maple.parse.error"

const parsedFields = (before: RuleRecord, after: RuleRecord): ReadonlyArray<ParsedField> => [
	...Arr.flatMap(Struct.keys(after.attributes), (key) => {
		const now = show(after.attributes[key])
		return key === PARSE_ERROR ||
			(hasAttr(before.attributes, key) && show(before.attributes[key]) === now)
			? []
			: [{ key, value: now }]
	}),
	...(after.severityText !== before.severityText || after.severityNumber !== before.severityNumber
		? [{ key: "severity", value: `${after.severityText ?? ""} (${after.severityNumber ?? 0})` }]
		: []),
	...(after.timeUnixNano !== undefined && after.timeUnixNano !== before.timeUnixNano
		? [{ key: "timestamp", value: new Date(Number(after.timeUnixNano / 1_000_000n)).toISOString() }]
		: []),
]

/** Runs the draft over the samples with the same engine the gateway's twin uses. */
export const runPreview = (spec: IngestRuleSpec, records: ReadonlyArray<RuleRecord>): PreviewResult => {
	const compiled = compileRules([spec], PREVIEW_SALT)
	const rows = Arr.flatMap(records, (record, index): ReadonlyArray<PreviewRow> => {
		// Records without a trace id sample at random in the gateway; a fixed draw per row keeps
		// the preview's counts steady between renders.
		const outcome = applyRules(compiled, record, () => (((index * 0.618_033_988_75) % 1) + 1) % 1)
		if (outcome._tag === "dropped") return [{ _tag: "dropped", record }]
		if (spec.action._tag === "parse")
			return outcome.matched.length === 0
				? []
				: [
						{
							_tag: "parsed",
							record,
							fields: parsedFields(record, outcome.record),
							failure: outcome.parseFailures.values().next().value ?? null,
						},
					]
		const changes = changesOf(record, outcome.record)
		return changes.length === 0 ? [] : [{ _tag: "redacted", record, changes }]
	})
	const isFailure = (row: PreviewRow) => row._tag === "parsed" && row.failure !== null
	return {
		total: records.length,
		dropped: Arr.filter(rows, (row) => row._tag === "dropped").length,
		redacted: Arr.filter(rows, (row) => row._tag === "redacted").length,
		parsed: Arr.filter(rows, (row) => row._tag === "parsed").length,
		failed: Arr.filter(rows, isFailure).length,
		// Failures first: they are what a draft pattern needs fixed.
		rows: [...Arr.filter(rows, isFailure), ...Arr.filter(rows, (row) => !isFailure(row))],
	}
}

/** Replacement text the engine writes: `[REDACTED]`, `[REDACTED:email]` or `hash:<hex16>`. */
export const REPLACEMENT = /\[REDACTED(?::[a-z0-9_]+)?\]|hash:[0-9a-f]{16}/gu

export type Segment = { readonly isReplacement: boolean; readonly text: string }

export const segmentsOf = (value: string): ReadonlyArray<Segment> => {
	const matches = [...Str.matchAll(REPLACEMENT)(value)]
	const ends = Arr.map(matches, (match) => (match.index ?? 0) + match[0].length)
	const segments = Arr.flatMap(matches, (match, index) => {
		const start = match.index ?? 0
		const previousEnd = index === 0 ? 0 : (ends[index - 1] ?? 0)
		return [
			{ isReplacement: false, text: Str.slice(previousEnd, start)(value) },
			{ isReplacement: true, text: match[0] },
		]
	})
	const tail = Str.slice(ends.at(-1) ?? 0)(value)
	return Arr.filter(
		[...segments, { isReplacement: false, text: tail }],
		(segment) => segment.text.length > 0,
	)
}
