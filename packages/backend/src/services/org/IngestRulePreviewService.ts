import { IngestRuleValidationError, type TenantContext, type WarehouseQueryError } from "@maple/domain/http"
import { ingestRuleProblems, type IngestRuleSpec } from "@maple/domain/ingest-rules"
import { CH, formatWarehouseDateTime } from "@maple/query-engine"
import { Context, Effect, Layer, Array as Arr, Order } from "effect"
import { WarehouseQueryService } from "@maple/backend/services/warehouse/WarehouseQueryService"

// The settings dry run: what a draft rule's conditions match in recently stored logs and spans,
// and what dropping it would have kept off the bill.

const MINUTE_MS = 60 * 1000
const HOUR_MS = 60 * MINUTE_MS
export const PREVIEW_WINDOW_MS = 24 * HOUR_MS
const DAY_MINUTES = 24 * 60
const TOP_SERVICES = 10
/**
 * The most stored records one preview scans per signal. A busier day scans only the latest
 * stretch that fits, so a keystroke never reads a large org's whole day.
 */
export const PREVIEW_MAX_SCAN_ROWS = 50_000_000

/**
 * Minutes of a signal to scan, from its stored records per UTC hour bucket, newest (the current,
 * partial hour) first. A window of `k` hours ending now touches `k + 1` buckets, so the longest
 * `k` whose newest `k + 1` buckets fit the budget wins. When not even the last hour fits, the
 * minutes that fit at the busier of the two newest buckets' rates, at least one.
 */
export const scanMinutes = (newestFirst: ReadonlyArray<number>): number => {
	const within = (hours: number) =>
		Arr.reduce(Arr.take(newestFirst, hours + 1), 0, (total, count) => total + count) <=
		PREVIEW_MAX_SCAN_ROWS
	const hours = Arr.findFirst(
		Arr.makeBy(24, (index) => 24 - index),
		within,
	)
	if (hours._tag === "Some") return hours.value * 60
	const busiest = Math.max(1, ...Arr.take(newestFirst, 2))
	return Math.max(1, Math.floor((60 * PREVIEW_MAX_SCAN_ROWS) / busiest))
}

export type PreviewSignal = "logs" | "traces"

export interface ServiceMatches {
	readonly serviceName: string
	readonly stored: number
	readonly matched: number
}

export interface SignalPreview {
	readonly signal: PreviewSignal
	/** Minutes actually scanned; under a day, each service's match rate is applied to its day. */
	readonly scannedMinutes: number
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
 * Under a day scanned, each service's share of matches is applied to its stored records for the
 * day (`dayCounts`), so a burst in the scanned stretch does not stand for the whole day.
 */
export const summarize = (
	signal: PreviewSignal,
	rows: ReadonlyArray<{ readonly serviceName: string; readonly total: number; readonly matched: number }>,
	sizes: RecordSizes,
	share: number,
	scannedMinutes = DAY_MINUTES,
	dayCounts: ReadonlyMap<string, number> = new Map(),
): SignalPreview => {
	const services = Arr.map(rows, (row) => {
		const total = Number(row.total)
		const matched = Number(row.matched)
		if (scannedMinutes >= DAY_MINUTES || total === 0)
			return { serviceName: row.serviceName, stored: total, matched }
		const stored = dayCounts.get(row.serviceName) ?? Math.round((total * DAY_MINUTES) / scannedMinutes)
		return { serviceName: row.serviceName, stored, matched: Math.round((matched / total) * stored) }
	})
	const sum = (pick: (service: ServiceMatches) => number) =>
		Arr.reduce(services, 0, (total, service) => total + pick(service))
	return {
		signal,
		scannedMinutes,
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
		const [usage, hourly] = yield* Effect.all(
			[
				warehouse.compiledQuery(tenant, CH.compile(CH.serviceUsageQuery({}), windowFrom(startMs)), {
					profile: "aggregation",
					context: "ingestRulePreviewUsage",
				}),
				warehouse.compiledQuery(
					tenant,
					CH.compile(CH.ingestRuleHourlyVolumeQuery(), windowFrom(startMs)),
					{ profile: "aggregation", context: "ingestRulePreviewHourly" },
				),
			],
			{ concurrency: "unbounded" },
		)
		const newestFirst = (signal: PreviewSignal) =>
			Arr.map(hourly, (row) => Number(signal === "logs" ? row.logs : row.spans))
		const dayCounts = (signal: PreviewSignal) =>
			new Map(
				Arr.map(usage, (row) => [
					row.serviceName,
					Number(signal === "logs" ? row.totalLogCount : row.totalTraceCount),
				]),
			)
		const scan = (signal: PreviewSignal) => {
			const minutes = Math.min(DAY_MINUTES, scanMinutes(newestFirst(signal)))
			const params = windowFrom(endMs - minutes * MINUTE_MS)
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
				summarize(
					signal,
					matched,
					sizesFrom(usage, signal),
					dropShare(spec),
					minutes,
					dayCounts(signal),
				),
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
			"maple.ingest_rule.scanned_minutes": Arr.join(
				Arr.map(previews, (entry) => String(entry.scannedMinutes)),
				",",
			),
		})
		return { startMs, endMs, signals: previews } satisfies IngestRulePreviewResult
	})

	return { preview }
})

export class IngestRulePreviewService extends Context.Service<IngestRulePreviewService>()(
	"@maple/backend/services/IngestRulePreviewService",
	{ make },
) {
	static readonly layer = Layer.effect(this, this.make).pipe(Layer.provide(WarehouseQueryService.layer))
}
