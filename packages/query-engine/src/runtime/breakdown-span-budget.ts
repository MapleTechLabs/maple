// Span budget for raw `traces` breakdowns: decide from `service_usage` counts
// whether a breakdown can finish inside its time limit, before running it.

import type { AttributeFilter } from "@maple/domain/query-engine"
import { MAX_RAW_BREAKDOWN_SPANS, MIN_SPAN_ESTIMATE_RANGE_SECONDS, formatRangeSeconds } from "../limits"
import { inclusionValues, soleValue } from "../ch/queries/query-helpers"

export interface SpanBudgetFilter {
	readonly serviceName?: string
	readonly serviceNames?: ReadonlyArray<string>
	readonly excludedServiceNames?: ReadonlyArray<string>
	readonly matchModes?: { readonly serviceName?: "contains" }
	readonly attributeFilters?: ReadonlyArray<AttributeFilter>
	readonly resourceAttributeFilters?: ReadonlyArray<AttributeFilter>
}

export interface SpanBudgetVerdict {
	readonly estimatedSpans: number
	/** Present when the estimate is over budget. */
	readonly exceeded?: {
		readonly message: string
		readonly details: ReadonlyArray<string>
	}
}

const SECONDS_PER_HOUR = 3600

/**
 * Whether a per-service span count can size this breakdown. A positive span or resource
 * attribute match may be pruned by the attribute bloom index, which the count cannot see.
 */
export function spanBudgetApplies(filter: SpanBudgetFilter, rangeSeconds: number): boolean {
	if (rangeSeconds <= MIN_SPAN_ESTIMATE_RANGE_SECONDS) return false
	return ![...(filter.attributeFilters ?? []), ...(filter.resourceAttributeFilters ?? [])].some(
		(f) => !f.negated && (f.mode === "equals" || f.mode === "in"),
	)
}

const compactCount = (n: number): string =>
	n >= 1e9 ? `${(n / 1e9).toFixed(1)}B` : n >= 1e6 ? `${Math.round(n / 1e6)}M` : `${Math.round(n)}`

/** Mirrors the breakdown's service WHERE: `inclusionValues` + `matchOrIn`, then exclusions. */
const serviceMatcher = (filter: SpanBudgetFilter): ((name: string) => boolean) => {
	const values = inclusionValues(filter.serviceName, filter.serviceNames)
	const needle = filter.matchModes?.serviceName === "contains" && values ? soleValue(values) : undefined
	const excluded = new Set(filter.excludedServiceNames ?? [])
	const included = (name: string) =>
		values === undefined ||
		(needle !== undefined ? name.toLowerCase().includes(needle.toLowerCase()) : values.includes(name))
	return (name) => !excluded.has(name) && included(name)
}

export interface SpanVolumeRow {
	readonly serviceName: string
	readonly spanCount: number
	readonly firstHourSpanCount: number
	readonly lastHourSpanCount: number
}

export interface SpanBudgetWindow {
	readonly startMs: number
	readonly endMs: number
}

const HOUR_MS = SECONDS_PER_HOUR * 1000

/**
 * Hourly counts minus the parts of the two boundary hours outside the window. An
 * in-progress last hour holds less than a full hour, so this errs toward running.
 */
const spansInWindow = (row: SpanVolumeRow, window: SpanBudgetWindow): number => {
	const startHourMs = Math.floor(window.startMs / HOUR_MS) * HOUR_MS
	const endHourMs = Math.floor(window.endMs / HOUR_MS) * HOUR_MS
	const before = (window.startMs - startHourMs) / HOUR_MS
	const after = (endHourMs + HOUR_MS - window.endMs) / HOUR_MS
	return Math.max(0, row.spanCount - row.firstHourSpanCount * before - row.lastHourSpanCount * after)
}

export function rawBreakdownSpanVerdict(
	rows: ReadonlyArray<SpanVolumeRow>,
	filter: SpanBudgetFilter,
	window: SpanBudgetWindow,
	budget: number = MAX_RAW_BREAKDOWN_SPANS,
): SpanBudgetVerdict {
	const matches = serviceMatcher(filter)
	const estimatedSpans = Math.round(
		rows.reduce(
			(total, row) => (matches(row.serviceName) ? total + spansInWindow(row, window) : total),
			0,
		),
	)
	const rangeSeconds = (window.endMs - window.startMs) / 1000
	if (estimatedSpans <= budget) return { estimatedSpans }

	// Multiply first: `budget / (spans / hours)` lands on 59.999… for an exact 60.
	const fittingHours = Math.floor((budget * rangeSeconds) / SECONDS_PER_HOUR / estimatedSpans)
	const narrower =
		fittingHours >= 1
			? `Narrow the time range to ${formatRangeSeconds(fittingHours * SECONDS_PER_HOUR)} or less`
			: "Narrow the time range to under an hour"
	return {
		estimatedSpans,
		exceeded: {
			message: "Breakdown would scan too many spans",
			details: [
				`This window holds about ${compactCount(estimatedSpans)} spans for the selected services; a breakdown over raw spans can aggregate about ${compactCount(budget)} before it times out`,
				`${narrower}, or filter to fewer services`,
			],
		},
	}
}
