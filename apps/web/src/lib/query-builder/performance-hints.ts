import { parseWhereClause, normalizeKey } from "@maple/domain/where-clause"
import { TRACE_LIST_MV_ATTR_MAP, TRACE_LIST_MV_RESOURCE_MAP } from "@maple/query-engine/traces-shared"
import { Array as Arr, String as Str } from "effect"

export interface PerformanceHint {
	key: string
	location: "filter" | "groupBy"
	speed: "fast" | "slow"
	reason: string
}

const FAST_FILTER_KEYS = new Set(["service.name", "span.name", "root_only", "has_error", "status.code"])

const FAST_GROUP_BY_KEYS = new Set(["service.name", "span.name", "status.code", "none"])

/**
 * Check if an attr.* or resource.* key has a materialized view column,
 * meaning it's fast when root_only is enabled.
 */
function hasMvMapping(normalizedKey: string): boolean {
	if (Str.startsWith("attr.")(normalizedKey)) {
		return Str.slice(5)(normalizedKey) in TRACE_LIST_MV_ATTR_MAP
	}
	if (Str.startsWith("resource.")(normalizedKey)) {
		return Str.slice(9)(normalizedKey) in TRACE_LIST_MV_RESOURCE_MAP
	}
	if (normalizedKey === "deployment.environment") {
		return "deployment.environment" in TRACE_LIST_MV_RESOURCE_MAP
	}
	return false
}

export function getPerformanceHints(whereClause: string, groupByKeys: string[]): PerformanceHint[] {
	const hints: PerformanceHint[] = []

	const { clauses } = parseWhereClause(whereClause)
	for (const clause of clauses) {
		const key = normalizeKey(clause.key)
		if (Str.startsWith("attr.")(key) || Str.startsWith("resource.")(key)) {
			hints.push({
				key: clause.key,
				location: "filter",
				speed: "slow",
				reason: `"${clause.key}" scans Map column for every row`,
			})
		} else if (key === "deployment.environment" || key === "vcs.ref.head.revision") {
			hints.push({
				key: clause.key,
				location: "filter",
				speed: "slow",
				reason: `"${clause.key}" reads from ResourceAttributes Map`,
			})
		} else if (FAST_FILTER_KEYS.has(key)) {
			hints.push({
				key: clause.key,
				location: "filter",
				speed: "fast",
				reason: "Uses indexed column",
			})
		}
	}

	for (const raw of groupByKeys) {
		const token = Str.toLowerCase(Str.trim(raw))
		if (!token) continue

		if (Str.startsWith("attr.")(token)) {
			hints.push({
				key: raw,
				location: "groupBy",
				speed: "slow",
				reason: `Group by "${raw}" scans Map column`,
			})
		} else if (token === "http.method") {
			hints.push({
				key: raw,
				location: "groupBy",
				speed: "slow",
				reason: `Group by "${raw}" reads from SpanAttributes Map`,
			})
		} else if (FAST_GROUP_BY_KEYS.has(token)) {
			hints.push({
				key: raw,
				location: "groupBy",
				speed: "fast",
				reason: "Uses native column",
			})
		}
	}

	return hints
}

export function getListPerformanceHints(
	whereClause: string,
	limit: number,
	rootOnly: boolean,
): PerformanceHint[] {
	const hints: PerformanceHint[] = []
	const filterHints = getPerformanceHints(whereClause, [])

	// When rootOnly is on, attr filters that have MV columns are actually fast.
	// Only warn about truly slow filters.
	const slowFilters = Arr.filter(filterHints, (h) => h.speed === "slow")
	const trulySlowFilters: string[] = []
	const mvAcceleratedFilters: string[] = []

	for (const h of slowFilters) {
		const key = normalizeKey(h.key)
		if (rootOnly && hasMvMapping(key)) {
			mvAcceleratedFilters.push(h.key)
		} else {
			trulySlowFilters.push(h.key)
		}
	}

	if (trulySlowFilters.length > 0) {
		const keys = Arr.join(trulySlowFilters, ", ")
		hints.push({
			key: "_slow_filters",
			location: "filter",
			speed: "slow",
			reason: rootOnly
				? `Slow filters: ${keys}. No materialized column, scans Map for every row`
				: `Slow filters: ${keys}. Enable "Root spans only" to use materialized columns`,
		})
	}

	if (mvAcceleratedFilters.length > 0) {
		hints.push({
			key: "_mv_accelerated",
			location: "filter",
			speed: "fast",
			reason: `${Arr.join(mvAcceleratedFilters, ", ")}: accelerated by materialized view`,
		})
	}

	if (!Str.trim(whereClause)) {
		hints.push({
			key: "_no_filters",
			location: "filter",
			speed: "slow",
			reason: "No filters, so this scans the entire time range. Add service.name or other filters.",
		})
	}

	if (!rootOnly) {
		hints.push({
			key: "_no_root_only",
			location: "filter",
			speed: "slow",
			reason: 'Scanning all spans. Enable "Root spans only" to use the materialized view.',
		})
	}

	if (limit > 50) {
		hints.push({
			key: "_high_limit",
			location: "filter",
			speed: "slow",
			reason: `Limit ${limit} may be slow with wide time ranges. Recommended: 25-50.`,
		})
	}

	return hints
}

export function hasSlowHints(hints: PerformanceHint[]): boolean {
	return Arr.some(hints, (h) => h.speed === "slow")
}

export function slowHintsSummary(hints: PerformanceHint[]): string {
	const slow = Arr.filter(hints, (h) => h.speed === "slow")
	if (slow.length === 0) return ""
	const keys = Arr.join(
		Arr.map(slow, (h) => h.key),
		", ",
	)
	return `Slow Map column access: ${keys}. These filters/groups scan the full attributes Map for every row.`
}
