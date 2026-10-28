import type { IngestRuleSpec } from "@maple/domain/ingest-rules"
import {
	applyRules,
	type AttrMap,
	type AttrValue,
	compileRules,
	logSampleToRecord,
	type RuleRecord,
	spanSampleToRecord,
} from "@maple/ingest-rules"
import { Schema } from "effect"

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
	samples._tag === "logs" ? samples.rows.map(logSampleToRecord) : samples.rows.map(spanSampleToRecord)

export interface ValueChange {
	readonly where: string
	readonly key: string
	readonly before: string
	/** `null` when the value was removed. */
	readonly after: string | null
}

export type PreviewRow =
	| { readonly _tag: "dropped"; readonly record: RuleRecord }
	| { readonly _tag: "redacted"; readonly record: RuleRecord; readonly changes: ReadonlyArray<ValueChange> }

export interface PreviewResult {
	readonly total: number
	readonly dropped: number
	readonly redacted: number
	readonly rows: ReadonlyArray<PreviewRow>
}

const show = (value: AttrValue | undefined): string =>
	value === undefined
		? ""
		: typeof value === "string"
			? value
			: JSON.stringify(value, (_key, inner) => (typeof inner === "bigint" ? String(inner) : inner))

const mapChanges = (where: string, before: AttrMap, after: AttrMap): ReadonlyArray<ValueChange> =>
	Object.keys(before).flatMap((key) => {
		const was = show(before[key])
		const now = key in after ? show(after[key]) : null
		return now === was ? [] : [{ where, key, before: was, after: now }]
	})

const changesOf = (before: RuleRecord, after: RuleRecord): ReadonlyArray<ValueChange> => [
	...mapChanges("attribute", before.attributes, after.attributes),
	...mapChanges("resource", before.resource, after.resource),
	...(before.body !== undefined && show(before.body) !== show(after.body)
		? [{ where: "body", key: "body", before: show(before.body), after: show(after.body) }]
		: []),
	...(before.events ?? []).flatMap((event, index) =>
		mapChanges(`event ${event.name}`, event.attributes, after.events?.[index]?.attributes ?? {}),
	),
]

/** Runs the draft over the samples with the same engine the gateway's twin uses. */
export const runPreview = (spec: IngestRuleSpec, records: ReadonlyArray<RuleRecord>): PreviewResult => {
	const compiled = compileRules([spec], PREVIEW_SALT)
	const rows = records.flatMap((record, index): ReadonlyArray<PreviewRow> => {
		// Records without a trace id sample at random in the gateway; a fixed draw per row keeps
		// the preview's counts steady between renders.
		const outcome = applyRules(compiled, record, () => (((index * 0.618_033_988_75) % 1) + 1) % 1)
		if (outcome._tag === "dropped") return [{ _tag: "dropped", record }]
		const changes = changesOf(record, outcome.record)
		return changes.length === 0 ? [] : [{ _tag: "redacted", record, changes }]
	})
	return {
		total: records.length,
		dropped: rows.filter((row) => row._tag === "dropped").length,
		redacted: rows.filter((row) => row._tag === "redacted").length,
		rows,
	}
}

/** Replacement text the engine writes: `[REDACTED]`, `[REDACTED:email]` or `hash:<hex16>`. */
export const REPLACEMENT = /\[REDACTED(?::[a-z_]+)?\]|hash:[0-9a-f]{16}/gu

export type Segment = { readonly isReplacement: boolean; readonly text: string }

export const segmentsOf = (value: string): ReadonlyArray<Segment> => {
	const matches = [...value.matchAll(REPLACEMENT)]
	const ends = matches.map((match) => (match.index ?? 0) + match[0].length)
	const segments = matches.flatMap((match, index) => {
		const start = match.index ?? 0
		const previousEnd = index === 0 ? 0 : (ends[index - 1] ?? 0)
		return [
			{ isReplacement: false, text: value.slice(previousEnd, start) },
			{ isReplacement: true, text: match[0] },
		]
	})
	const tail = value.slice(ends.at(-1) ?? 0)
	return [...segments, { isReplacement: false, text: tail }].filter((segment) => segment.text.length > 0)
}
