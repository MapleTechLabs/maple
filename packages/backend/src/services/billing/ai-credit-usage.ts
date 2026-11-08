import { AI_CREDITS_FEATURE_ID, AiCreditSource } from "@maple/domain/billing"
import { AiCreditDay, AiCreditSourceUsage, AiCreditUsageResponse } from "@maple/domain/http"
import { Array as Arr, Number as Num, Option, Order, Record as Rec, Schema, String as Str } from "effect"

/** The event property every AI credit charge is tracked with (`trackAiCredits`, `trackSecurityAuditCharge`). */
export const AI_CREDIT_SOURCE_PROPERTY = "properties.source"

/** `/v1/events.aggregate` with `group_by`: per-day values, split per group. */
export const AutumnGroupedAggregate = Schema.Struct({
	list: Schema.Array(
		Schema.Struct({
			period: Schema.Number,
			values: Schema.Record(Schema.String, Schema.Number),
			grouped_values: Schema.optionalKey(
				Schema.Record(Schema.String, Schema.Record(Schema.String, Schema.Number)),
			),
		}),
	),
})
export type AutumnGroupedAggregate = typeof AutumnGroupedAggregate.Type

type Source = AiCreditSourceUsage["source"]

const utcDate = (epochMs: number) => Str.slice(0, 10)(new Date(epochMs).toISOString())

/** Anything Maple does not track under (Autumn's overflow bucket, an unset source) is `other`. */
const sourceOf = (raw: string): Source =>
	Option.getOrElse(Schema.decodeUnknownOption(AiCreditSource)(raw), (): Source => "other")

/** This cycle's AI credit spend from Autumn's day-binned aggregate, split by source and by day. */
export const aiCreditUsageOf = (aggregate: AutumnGroupedAggregate): AiCreditUsageResponse => {
	const totals = new Map<Source, number>()
	Arr.forEach(aggregate.list, (entry) =>
		Arr.forEach(Rec.toEntries(entry.grouped_values?.[AI_CREDITS_FEATURE_ID] ?? {}), ([raw, credits]) => {
			const source = sourceOf(raw)
			totals.set(source, (totals.get(source) ?? 0) + credits)
		}),
	)
	return new AiCreditUsageResponse({
		bySource: Arr.sort(
			Arr.flatMap(Arr.fromIterable(totals), ([source, credits]) =>
				credits > 0 ? [new AiCreditSourceUsage({ source, credits })] : [],
			),
			Order.combine(
				Order.mapInput(Order.Boolean, (entry: AiCreditSourceUsage) => entry.source === "other"),
				Order.mapInput(Order.flip(Num.Order), (entry: AiCreditSourceUsage) => entry.credits),
			),
		),
		days: Arr.sort(
			Arr.flatMap(aggregate.list, (entry) => {
				const credits = entry.values[AI_CREDITS_FEATURE_ID] ?? 0
				return credits > 0 ? [new AiCreditDay({ date: utcDate(entry.period), credits })] : []
			}),
			Order.mapInput(Order.String, (day: AiCreditDay) => day.date),
		),
	})
}
