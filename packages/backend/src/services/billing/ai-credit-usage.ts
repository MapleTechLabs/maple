import { AI_CREDITS_FEATURE_ID, AiCreditSource } from "@maple/domain/billing"
// The same day keys as `DailyVolume.date`, which the chart joins against.
import { toUtcDateKey } from "@maple/backend/services/billing/DailySpendService"
import {
	AiCreditDay,
	AiCreditModelUsage,
	AiCreditSourceUsage,
	AiCreditUsageResponse,
	type CodeReviewSpend,
} from "@maple/domain/http"
import { Array as Arr, Number as Num, Option, Order, Record as Rec, Schema } from "effect"

/** The event property every AI credit charge is tracked with (`trackAiCredits`, `trackSecurityAuditCharge`). */
export const AI_CREDIT_SOURCE_PROPERTY = "properties.source"

/** The model a charge was for: Autumn's own on `track_tokens`, Maple's on a dollar charge. */
export const AI_CREDIT_MODEL_PROPERTY = "properties.model"

/** `/v1/events.aggregate` with `group_by`: per-day values, split per group. */
export const AutumnGroupedAggregate = Schema.Struct({
	list: Schema.Array(
		Schema.Struct({
			period: Schema.Number,
			values: Schema.Record(Schema.String, Schema.Number),
			// The client camelizes this key (and keeps the data keys under it as they are).
			groupedValues: Schema.optionalKey(
				Schema.Record(Schema.String, Schema.Record(Schema.String, Schema.Number)),
			),
		}),
	),
})
export type AutumnGroupedAggregate = typeof AutumnGroupedAggregate.Type

type Source = AiCreditSourceUsage["source"]

/** Anything Maple does not track under (Autumn's overflow bucket, an unset source) is `other`. */
const sourceOf = (raw: string): Source =>
	Option.getOrElse(Schema.decodeUnknownOption(AiCreditSource)(raw), (): Source => "other")

/** One group's credits over every day of a grouped aggregate. */
const groupTotals = (aggregate: AutumnGroupedAggregate): ReadonlyMap<string, number> => {
	const totals = new Map<string, number>()
	Arr.forEach(aggregate.list, (entry) =>
		Arr.forEach(Rec.toEntries(entry.groupedValues?.[AI_CREDITS_FEATURE_ID] ?? {}), ([group, credits]) =>
			totals.set(group, (totals.get(group) ?? 0) + credits),
		),
	)
	return totals
}

const byCreditsDesc = <A extends { readonly credits: number }>() =>
	Order.mapInput(Order.flip(Num.Order), (entry: A) => entry.credits)

/**
 * This cycle's AI credit spend from Autumn's day-binned aggregates, one grouped by source and one by
 * model, beside the org's code review spend.
 */
export const aiCreditUsageOf = (
	cycle: { readonly start: number; readonly end: number },
	bySourceAggregate: AutumnGroupedAggregate,
	byModelAggregate: AutumnGroupedAggregate,
	codeReview: CodeReviewSpend | null,
): AiCreditUsageResponse => {
	const sources = new Map<Source, number>()
	Arr.forEach(Arr.fromIterable(groupTotals(bySourceAggregate)), ([raw, credits]) => {
		const source = sourceOf(raw)
		sources.set(source, (sources.get(source) ?? 0) + credits)
	})
	return new AiCreditUsageResponse({
		cycleStartMs: cycle.start,
		cycleEndMs: cycle.end,
		bySource: Arr.sort(
			Arr.flatMap(Arr.fromIterable(sources), ([source, credits]) =>
				credits > 0 ? [new AiCreditSourceUsage({ source, credits })] : [],
			),
			Order.combine(
				Order.mapInput(Order.Boolean, (entry: AiCreditSourceUsage) => entry.source === "other"),
				byCreditsDesc<AiCreditSourceUsage>(),
			),
		),
		days: Arr.sort(
			Arr.flatMap(bySourceAggregate.list, (entry) => {
				const credits = entry.values[AI_CREDITS_FEATURE_ID] ?? 0
				return credits > 0 ? [new AiCreditDay({ date: toUtcDateKey(entry.period), credits })] : []
			}),
			Order.mapInput(Order.String, (day: AiCreditDay) => day.date),
		),
		byModel: Arr.sort(
			Arr.flatMap(Arr.fromIterable(groupTotals(byModelAggregate)), ([model, credits]) =>
				// Autumn reports spend with no model (a security audit's) as the empty key: the page shows
				// it as Unattributed, the total less every named model.
				credits > 0 && model !== "" ? [new AiCreditModelUsage({ model, credits })] : [],
			),
			byCreditsDesc<AiCreditModelUsage>(),
		),
		codeReview,
	})
}
