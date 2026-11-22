import { IngestRuleValidationError, type TenantContext } from "@maple/domain/http"
import { ingestRuleProblems, type IngestRuleSpec } from "@maple/domain/ingest-rules"
import { CH, formatWarehouseDateTime } from "@maple/query-engine"
import { Context, Effect, Layer, Array as Arr, Order } from "effect"
import { WarehouseQueryService } from "@maple/backend/services/warehouse/WarehouseQueryService"

// The settings dry run: what a draft rule's conditions match in recently stored logs and spans,
// and what dropping it would have kept off the bill.

export const PREVIEW_WINDOW_MS = 24 * 60 * 60 * 1000
const TOP_SERVICES = 10

export type PreviewSignal = "logs" | "traces"

export interface ServiceMatches {
	readonly serviceName: string
	readonly stored: number
	readonly matched: number
}

export interface SignalPreview {
	readonly signal: PreviewSignal
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

/**
 * Totals for one signal: each service's matches times the share dropped, and those drops times
 * that service's average record size. A service missing from the usage rollup counts no bytes.
 */
export const summarize = (
	signal: PreviewSignal,
	rows: ReadonlyArray<{ readonly serviceName: string; readonly total: number; readonly matched: number }>,
	sizes: RecordSizes,
	share: number,
): SignalPreview => {
	const services = Arr.map(rows, (row) => ({
		serviceName: row.serviceName,
		stored: Number(row.total),
		matched: Number(row.matched),
	}))
	const sum = (pick: (service: ServiceMatches) => number) =>
		Arr.reduce(services, 0, (total, service) => total + pick(service))
	return {
		signal,
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
		const params = {
			orgId: tenant.orgId,
			startTime: formatWarehouseDateTime(startMs),
			endTime: formatWarehouseDateTime(endMs),
		}
		const signals = Arr.filter(
			spec.signals,
			(signal): signal is PreviewSignal => signal === "logs" || signal === "traces",
		)
		yield* Effect.annotateCurrentSpan({
			"maple.ingest_rule.signals": Arr.join(signals, ","),
			"maple.ingest_rule.conditions": spec.conditions.length,
		})
		const matchesOf = (signal: PreviewSignal) =>
			signal === "logs"
				? warehouse.compiledQuery(
						tenant,
						CH.compile(CH.ingestRuleLogMatchesQuery({ conditions: spec.conditions }), params),
						{ profile: "aggregation", context: "ingestRulePreviewLogs" },
					)
				: warehouse.compiledQuery(
						tenant,
						CH.compile(CH.ingestRuleSpanMatchesQuery({ conditions: spec.conditions }), params),
						{ profile: "aggregation", context: "ingestRulePreviewSpans" },
					)
		const [matches, usage] = yield* Effect.all(
			[
				Effect.forEach(signals, matchesOf, { concurrency: "unbounded" }),
				signals.length === 0
					? Effect.succeed([])
					: warehouse.compiledQuery(tenant, CH.compile(CH.serviceUsageQuery({}), params), {
							profile: "aggregation",
							context: "ingestRulePreviewUsage",
						}),
			],
			{ concurrency: "unbounded" },
		)
		const sizesOf = (signal: PreviewSignal): RecordSizes =>
			new Map(
				Arr.map(usage, (row) => {
					const count = Number(signal === "logs" ? row.totalLogCount : row.totalTraceCount)
					const bytes = Number(signal === "logs" ? row.totalLogSizeBytes : row.totalTraceSizeBytes)
					return [row.serviceName, count > 0 ? bytes / count : 0] as const
				}),
			)
		const share = dropShare(spec)
		return {
			startMs,
			endMs,
			signals: Arr.map(signals, (signal, index) =>
				summarize(signal, matches[index] ?? [], sizesOf(signal), share),
			),
		} satisfies IngestRulePreviewResult
	})

	return { preview }
})

export class IngestRulePreviewService extends Context.Service<IngestRulePreviewService>()(
	"@maple/backend/services/IngestRulePreviewService",
	{ make },
) {
	static readonly layer = Layer.effect(this, this.make).pipe(Layer.provide(WarehouseQueryService.layer))
}
