import { IngestRuleValidationError, type TenantContext, type WarehouseQueryError } from "@maple/domain/http"
import { ingestRuleProblems, type IngestRuleSpec } from "@maple/domain/ingest-rules"
import { CH, formatWarehouseDateTime } from "@maple/query-engine"
import { Context, Effect, Layer, Array as Arr, Order } from "effect"
import { WarehouseQueryService } from "@maple/backend/services/warehouse/WarehouseQueryService"

// The settings dry run: what a draft rule's conditions match in recently stored logs and spans,
// and what dropping it would have kept off the bill.

const HOUR_MS = 60 * 60 * 1000
export const PREVIEW_WINDOW_MS = 24 * HOUR_MS
const TOP_SERVICES = 10
/**
 * The most stored records one preview scans per signal. A day above it scans the latest hours
 * that fit and scales the counts to a day, so a keystroke never reads a large org's whole day.
 */
export const PREVIEW_MAX_SCAN_ROWS = 50_000_000

/** Whole hours of a signal the preview scans: all 24, or as many of the latest as fit the budget. */
export const scanHours = (storedPerDay: number): number =>
	storedPerDay <= PREVIEW_MAX_SCAN_ROWS
		? 24
		: Math.max(1, Math.floor((24 * PREVIEW_MAX_SCAN_ROWS) / storedPerDay))

export type PreviewSignal = "logs" | "traces"

export interface ServiceMatches {
	readonly serviceName: string
	readonly stored: number
	readonly matched: number
}

export interface SignalPreview {
	readonly signal: PreviewSignal
	/** Hours actually scanned; the counts are scaled to 24 hours when fewer. */
	readonly scannedHours: number
	readonly stored: number
	readonly matched: number
	readonly estimatedDropped: number
	readonly estimatedDroppedBytes: number
	readonly services: ReadonlyArray<ServiceMatches>
}

export interface IngestRulePreviewResult {
	readonly startMs: number
	readonly endMs: number
	readonly signals: ReadonlyArray<SignalPreview>
}

/** The share of matches a rule drops: `keepPercent` keeps the rest; redaction drops nothing. */
const dropShare = (spec: IngestRuleSpec): number =>
	spec.action._tag === "drop" ? (100 - spec.action.keepPercent) / 100 : 0

/** Bytes per stored record of one signal, per service, from the hourly usage rollup. */
type RecordSizes = ReadonlyMap<string, number>

const sizesFrom = (usage: ReadonlyArray<CH.ServiceUsageOutput>, signal: PreviewSignal): RecordSizes =>
	new Map(
		Arr.map(usage, (row) => {
			const count = Number(signal === "logs" ? row.totalLogCount : row.totalTraceCount)
			const bytes = Number(signal === "logs" ? row.totalLogSizeBytes : row.totalTraceSizeBytes)
			return [row.serviceName, count > 0 ? bytes / count : 0] as const
		}),
	)

/**
 * Totals for one signal: each service's matches times the share dropped, and those drops times
 * that service's average record size. A service missing from the usage rollup counts no bytes.
 */
export const summarize = (
	signal: PreviewSignal,
	rows: ReadonlyArray<{ readonly serviceName: string; readonly total: number; readonly matched: number }>,
	sizes: RecordSizes,
	share: number,
	scannedHours = 24,
): SignalPreview => {
	const toDay = 24 / scannedHours
	const services = Arr.map(rows, (row) => ({
		serviceName: row.serviceName,
		stored: Math.round(Number(row.total) * toDay),
		matched: Math.round(Number(row.matched) * toDay),
	}))
	const sum = (pick: (service: ServiceMatches) => number) =>
		Arr.reduce(services, 0, (total, service) => total + pick(service))
	return {
		signal,
		scannedHours,
		stored: sum((service) => service.stored),
		matched: sum((service) => service.matched),
		estimatedDropped: Math.round(sum((service) => service.matched) * share),
		estimatedDroppedBytes: Math.round(
			sum((service) => service.matched * share * (sizes.get(service.serviceName) ?? 0)),
		),
		services: Arr.take(
			Arr.sort(
				Arr.filter(services, (service) => service.matched > 0),
				Order.mapInput(Order.flip(Order.Number), (service: ServiceMatches) => service.matched),
			),
			TOP_SERVICES,
		),
	}
}

export type SuggestionReason = "debug_logs" | "info_logs" | "health_checks" | "busy_operation"

/** A rule the org's last 24 hours suggest, with what it would have kept off the bill. */
export interface RuleSuggestion {
	readonly signal: PreviewSignal
	readonly serviceName: string
	/** Logs: the level the rule covers, and every level below it; `null` for traces. */
	readonly level: "debug" | "info" | null
	/** Traces: the exact span name the rule covers; `null` for logs. */
	readonly spanName: string | null
	readonly reason: SuggestionReason
	readonly keepPercent: number
	readonly records: number
	readonly bytes: number
	readonly savedBytes: number
	/** `bytes` as a share of the signal's stored bytes. */
	readonly share: number
}

export interface IngestRuleSuggestionsResult {
	readonly startMs: number
	readonly endMs: number
	readonly suggestions: ReadonlyArray<RuleSuggestion>
}

const SAMPLE_KEEP_PERCENT = 10
const MAX_SUGGESTIONS = 6
/** A busy level or operation is worth sampling once it is this much of its signal's bytes. */
const DOMINANT_SHARE = 0.1
/** Below this share of all stored bytes, a suggestion is not worth a rule. */
const MIN_SAVED_SHARE = 0.005
const MIN_RECORDS = 1000
/** A probe's span name: a whole word, so `shipping` is not `ping`. */
const HEALTH_CHECK =
	/(?:^|[^a-z])(?:healthz?|health[-_]?checks?|readyz|readiness|livez|liveness|ping|heartbeat)(?:[^a-z]|$)/iu

/**
 * Rules worth suggesting from the day's volume: drop debug logs and health-check spans; sample a
 * log level or an operation that is a tenth of its signal's bytes. Busiest savings first.
 */
export const suggestRules = (
	logs: ReadonlyArray<{
		readonly serviceName: string
		readonly level: string
		readonly records: number
		readonly bytes: number
	}>,
	spans: ReadonlyArray<{
		readonly serviceName: string
		readonly spanName: string
		readonly records: number
	}>,
	spanSizes: RecordSizes,
	/** Every stored log and span byte in the window; the rows above are only the busiest groups. */
	totals: { readonly logBytes: number; readonly spanBytes: number },
): ReadonlyArray<RuleSuggestion> => {
	const { logBytes, spanBytes } = totals
	const spanRows = Arr.map(spans, (row) => ({
		...row,
		records: Number(row.records),
		bytes: Number(row.records) * (spanSizes.get(row.serviceName) ?? 0),
	}))
	const allBytes = logBytes + spanBytes
	const sampled = (bytes: number) => bytes * (1 - SAMPLE_KEEP_PERCENT / 100)
	const fromLogs = Arr.flatMap(logs, (row): ReadonlyArray<RuleSuggestion> => {
		const bytes = Number(row.bytes)
		const share = logBytes > 0 ? bytes / logBytes : 0
		const base = {
			signal: "logs" as const,
			spanName: null,
			serviceName: row.serviceName,
			records: Number(row.records),
			bytes,
			share,
		}
		if (row.level === "debug")
			return [{ ...base, level: "debug", reason: "debug_logs", keepPercent: 0, savedBytes: bytes }]
		if (row.level === "info" && share >= DOMINANT_SHARE)
			return [
				{
					...base,
					level: "info",
					reason: "info_logs",
					keepPercent: SAMPLE_KEEP_PERCENT,
					savedBytes: sampled(bytes),
				},
			]
		return []
	})
	const fromSpans = Arr.flatMap(spanRows, (row): ReadonlyArray<RuleSuggestion> => {
		const share = spanBytes > 0 ? row.bytes / spanBytes : 0
		const base = {
			signal: "traces" as const,
			level: null,
			serviceName: row.serviceName,
			spanName: row.spanName,
			records: row.records,
			bytes: row.bytes,
			share,
		}
		if (HEALTH_CHECK.test(row.spanName))
			return [{ ...base, reason: "health_checks", keepPercent: 0, savedBytes: row.bytes }]
		if (share >= DOMINANT_SHARE)
			return [
				{
					...base,
					reason: "busy_operation",
					keepPercent: SAMPLE_KEEP_PERCENT,
					savedBytes: sampled(row.bytes),
				},
			]
		return []
	})
	return Arr.take(
		Arr.sort(
			Arr.filter(
				[...fromLogs, ...fromSpans],
				(suggestion) =>
					suggestion.records >= MIN_RECORDS &&
					allBytes > 0 &&
					suggestion.savedBytes / allBytes >= MIN_SAVED_SHARE,
			),
			Order.mapInput(Order.flip(Order.Number), (suggestion: RuleSuggestion) => suggestion.savedBytes),
		),
		MAX_SUGGESTIONS,
	)
}

const make = Effect.gen(function* () {
	const warehouse = yield* WarehouseQueryService

	const preview = Effect.fn("IngestRulePreviewService.preview")(function* (
		tenant: TenantContext,
		spec: IngestRuleSpec,
		endMs: number,
	) {
		const problems = ingestRuleProblems(spec)
		if (problems.length > 0) {
			return yield* new IngestRuleValidationError({
				message: Arr.join(problems, "; "),
				problems: [...problems],
			})
		}
		const startMs = endMs - PREVIEW_WINDOW_MS
		const windowFrom = (fromMs: number) => ({
			orgId: tenant.orgId,
			startTime: formatWarehouseDateTime(fromMs),
			endTime: formatWarehouseDateTime(endMs),
		})
		const signals = Arr.filter(
			spec.signals,
			(signal): signal is PreviewSignal => signal === "logs" || signal === "traces",
		)
		yield* Effect.annotateCurrentSpan({
			"maple.ingest_rule.signals": Arr.join(signals, ","),
			"maple.ingest_rule.conditions": spec.conditions.length,
		})
		if (signals.length === 0) return { startMs, endMs, signals: [] } satisfies IngestRulePreviewResult
		// Sized first from the hourly rollup, so the scan below can stay inside its budget.
		const usage = yield* warehouse.compiledQuery(
			tenant,
			CH.compile(CH.serviceUsageQuery({}), windowFrom(startMs)),
			{ profile: "aggregation", context: "ingestRulePreviewUsage" },
		)
		const storedPerDay = (signal: PreviewSignal) =>
			Arr.reduce(
				usage,
				0,
				(total, row) => total + Number(signal === "logs" ? row.totalLogCount : row.totalTraceCount),
			)
		const scan = (signal: PreviewSignal) => {
			const hours = scanHours(storedPerDay(signal))
			const params = windowFrom(endMs - hours * HOUR_MS)
			const rows =
				signal === "logs"
					? warehouse.compiledQuery(
							tenant,
							CH.compile(CH.ingestRuleLogMatchesQuery({ conditions: spec.conditions }), params),
							{ profile: "aggregation", context: "ingestRulePreviewLogs" },
						)
					: warehouse.compiledQuery(
							tenant,
							CH.compile(
								CH.ingestRuleSpanMatchesQuery({ conditions: spec.conditions }),
								params,
							),
							{ profile: "aggregation", context: "ingestRulePreviewSpans" },
						)
			return Effect.map(rows, (matched) =>
				summarize(signal, matched, sizesFrom(usage, signal), dropShare(spec), hours),
			)
		}
		const previews = yield* Effect.forEach(signals, scan, { concurrency: "unbounded" }).pipe(
			Effect.catchTag(
				"@maple/http/errors/WarehouseQueryError",
				(error): Effect.Effect<never, IngestRuleValidationError | WarehouseQueryError> =>
					error.clickhouseType === "CANNOT_COMPILE_REGEXP" || error.clickhouseCode === "427"
						? Effect.fail(
								new IngestRuleValidationError({
									message:
										"A pattern in this rule cannot be previewed; the gateway still applies it.",
									problems: ["a regex uses syntax the preview's engine cannot run"],
								}),
							)
						: Effect.fail(error),
			),
		)
		yield* Effect.annotateCurrentSpan({
			"maple.ingest_rule.scanned_hours": Arr.join(
				Arr.map(previews, (entry) => String(entry.scannedHours)),
				",",
			),
		})
		return { startMs, endMs, signals: previews } satisfies IngestRulePreviewResult
	})

	const suggestions = Effect.fn("IngestRulePreviewService.suggestions")(function* (
		tenant: TenantContext,
		endMs: number,
	) {
		const startMs = endMs - PREVIEW_WINDOW_MS
		const params = {
			orgId: tenant.orgId,
			startTime: formatWarehouseDateTime(startMs),
			endTime: formatWarehouseDateTime(endMs),
		}
		const [logs, spans, usage] = yield* Effect.all(
			[
				warehouse.compiledQuery(tenant, CH.compile(CH.ingestRuleLogVolumeQuery(), params), {
					profile: "aggregation",
					context: "ingestRuleSuggestLogs",
				}),
				warehouse.compiledQuery(tenant, CH.compile(CH.ingestRuleSpanVolumeQuery(), params), {
					profile: "aggregation",
					context: "ingestRuleSuggestSpans",
				}),
				warehouse.compiledQuery(tenant, CH.compile(CH.serviceUsageQuery({}), params), {
					profile: "aggregation",
					context: "ingestRuleSuggestUsage",
				}),
			],
			{ concurrency: "unbounded" },
		)
		const suggested = suggestRules(logs, spans, sizesFrom(usage, "traces"), {
			logBytes: Arr.reduce(usage, 0, (total, row) => total + Number(row.totalLogSizeBytes)),
			spanBytes: Arr.reduce(usage, 0, (total, row) => total + Number(row.totalTraceSizeBytes)),
		})
		yield* Effect.annotateCurrentSpan({ "maple.ingest_rule.suggestions": suggested.length })
		return { startMs, endMs, suggestions: suggested } satisfies IngestRuleSuggestionsResult
	})

	return { preview, suggestions }
})

export class IngestRulePreviewService extends Context.Service<IngestRulePreviewService>()(
	"@maple/backend/services/IngestRulePreviewService",
	{ make },
) {
	static readonly layer = Layer.effect(this, this.make).pipe(Layer.provide(WarehouseQueryService.layer))
}
