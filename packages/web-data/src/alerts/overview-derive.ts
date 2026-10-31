import type { AlertIncidentDocument, AlertRuleDocument } from "@maple/domain/http"

import {
	comparatorLabels,
	displaySignalType,
	formatSignalValue,
	isRangeComparator,
	signalLabels,
} from "./form-utils"
import { incidentGroup } from "./incident-timeline"
import { type DerivedRuleStatus, needsAttention } from "./rule-status"

/** The four mutually exclusive buckets the Rules tab filters by. */
export type RuleBucket = "firing" | "blind" | "healthy" | "disabled"

export function ruleBucket(derived: DerivedRuleStatus | undefined): RuleBucket {
	if (derived === undefined) return "healthy"
	if (derived.status === "disabled") return "disabled"
	if (derived.status === "firing") return "firing"
	if (needsAttention(derived)) return "blind"
	return "healthy"
}

/** "Error rate > 5% · 5m · per service.name · checkout" */
export function ruleConditionSummary(rule: AlertRuleDocument): string {
	// Builder rules format in the display unit (5%, not the stored 0.05) and name their aggregation.
	const display = displaySignalType({
		signalType: rule.signalType,
		queryBuilderDraft: rule.queryBuilderDraft ?? undefined,
	})
	const threshold = isRangeComparator(rule.comparator)
		? `${formatSignalValue(display, rule.threshold)} and ${formatSignalValue(display, rule.thresholdUpper)}`
		: formatSignalValue(display, rule.threshold)
	const subject =
		rule.signalType === "builder_query" && rule.queryBuilderDraft
			? rule.queryBuilderDraft.aggregation.replaceAll("_", " ")
			: signalLabels[rule.signalType]
	const parts = [`${subject} ${comparatorLabels[rule.comparator]} ${threshold}`, `${rule.windowMinutes}m`]
	if (rule.groupBy !== null) parts.push(`per ${rule.groupBy.join(", ")}`)
	if (rule.serviceNames.length === 1) parts.push(rule.serviceNames[0] ?? "")
	else if (rule.serviceNames.length > 1) parts.push(`${rule.serviceNames.length} services`)
	return parts.join(" · ")
}

type IncidentLine = Pick<
	AlertIncidentDocument,
	"signalType" | "ruleName" | "groupKey" | "status" | "lastObservedValue" | "threshold"
>

/** Uptime incidents name the monitor ("checkout-api is down"), not a signal and a value. */
const isUptime = (incident: Pick<AlertIncidentDocument, "signalType">) => incident.signalType === "uptime"

/** Raw SQL and builder rules: "Raw SQL 5" says nothing, so the rule name is what fired. */
export const isQueryIncident = (incident: Pick<AlertIncidentDocument, "signalType">) =>
	incident.signalType === "raw_query" || incident.signalType === "builder_query"

/** "Error rate 8.4% on checkout", "checkout-api is down", or a query rule's name: what an incident is about, in one line. */
export function incidentTitle(incident: IncidentLine): string {
	if (isUptime(incident))
		return `${incident.ruleName} ${incident.status === "resolved" ? "is back up" : "is down"}`
	if (isQueryIncident(incident)) return incident.ruleName
	const value = formatSignalValue(incident.signalType, incident.lastObservedValue)
	const base = `${signalLabels[incident.signalType]} ${value}`
	return incident.groupKey === null ? base : `${base} on ${incident.groupKey}`
}

/** The group shown next to the rule name: an uptime incident's only when it is a real service. */
export function incidentScope(incident: IncidentLine): string | null {
	return isUptime(incident) ? incidentGroup(incident) : incident.groupKey
}

/** The line under the title: the rule and group, or a query rule's kind and group (its name is the title). */
export function incidentSubline(incident: IncidentLine): string {
	const scope = incidentScope(incident)
	const lead = isQueryIncident(incident) ? signalLabels[incident.signalType] : incident.ruleName
	return scope === null ? lead : `${lead} · ${scope}`
}

/** An empty cell, without an em dash. */
export const NO_THRESHOLD = "–"

/** The Now / threshold cells: an uptime incident is "Down" (or "Up") with no threshold. */
export function incidentValues(incident: IncidentLine): Readonly<{ now: string; threshold: string }> {
	if (isUptime(incident))
		return { now: incident.status === "resolved" ? "Up" : "Down", threshold: NO_THRESHOLD }
	return {
		now: formatSignalValue(incident.signalType, incident.lastObservedValue),
		threshold: formatSignalValue(incident.signalType, incident.threshold),
	}
}

export interface Headroom {
	/** Fill fraction 0..1 for the current value. */
	readonly fill: number
	/** Tick positions 0..1 for the threshold(s). */
	readonly ticks: ReadonlyArray<number>
	readonly breached: boolean
	/** Fraction of the threshold left before breaching; null for range/equality comparators. */
	readonly headroom: number | null
}

const breaches = (rule: AlertRuleDocument, value: number): boolean => {
	const upper = rule.thresholdUpper ?? rule.threshold
	switch (rule.comparator) {
		case "gt":
			return value > rule.threshold
		case "gte":
			return value >= rule.threshold
		case "lt":
			return value < rule.threshold
		case "lte":
			return value <= rule.threshold
		case "eq":
			return value === rule.threshold
		case "neq":
			return value !== rule.threshold
		case "between":
			return value >= rule.threshold && value <= upper
		case "not_between":
			return value < rule.threshold || value > upper
	}
}

/** Current value against the threshold on a shared 0..max scale. */
export function ruleHeadroom(rule: AlertRuleDocument, value: number): Headroom {
	const thresholds = [rule.threshold, ...(rule.thresholdUpper !== null ? [rule.thresholdUpper] : [])]
	const max = Math.max(value * 1.1, ...thresholds.map((t) => t * 1.5), Number.EPSILON)
	const above = rule.comparator === "gt" || rule.comparator === "gte"
	const below = rule.comparator === "lt" || rule.comparator === "lte"
	const headroom =
		rule.threshold === 0
			? null
			: above
				? (rule.threshold - value) / rule.threshold
				: below
					? (value - rule.threshold) / rule.threshold
					: null
	return {
		fill: Math.min(1, Math.max(0, value / max)),
		ticks: thresholds.map((t) => Math.min(1, Math.max(0, t / max))),
		breached: breaches(rule, value),
		headroom,
	}
}

export interface FireBar {
	readonly id: string
	/** 0..1 offsets inside the window. */
	readonly start: number
	readonly end: number
	readonly open: boolean
	readonly held: boolean
	readonly severity: AlertIncidentDocument["severity"]
}

export interface FireLane {
	readonly ruleId: string
	readonly ruleName: string
	readonly bars: ReadonlyArray<FireBar>
}

const MIN_BAR_FRACTION = 0.004

/** One lane per rule that had an incident overlapping the window, busiest first. */
export function fireLanes(
	incidents: ReadonlyArray<AlertIncidentDocument>,
	range: { readonly min: number; readonly max: number },
): FireLane[] {
	const span = Math.max(1, range.max - range.min)
	const lanes = new Map<string, { ruleName: string; bars: FireBar[] }>()
	for (const incident of incidents) {
		const start = Date.parse(incident.firstTriggeredAt)
		const end = incident.resolvedAt === null ? range.max : Date.parse(incident.resolvedAt)
		if (end < range.min || start > range.max) continue
		const s = (Math.max(start, range.min) - range.min) / span
		const e = (Math.min(end, range.max) - range.min) / span
		const bar: FireBar = {
			id: incident.id,
			start: s,
			end: Math.max(e, s + MIN_BAR_FRACTION),
			open: incident.status === "open",
			held: incident.status === "open" && incident.holdReason !== null,
			severity: incident.severity,
		}
		const lane = lanes.get(incident.ruleId)
		if (lane) lane.bars.push(bar)
		else lanes.set(incident.ruleId, { ruleName: incident.ruleName, bars: [bar] })
	}
	return [...lanes.entries()]
		.map(([ruleId, lane]) => ({ ruleId, ruleName: lane.ruleName, bars: lane.bars }))
		.sort((a, b) => b.bars.length - a.bars.length || a.ruleName.localeCompare(b.ruleName))
}

export type RibbonCell = "quiet" | "warning" | "critical"

/** Fixed-width cells over the window; the worst incident severity in a cell wins. */
export function ruleRibbon(
	incidents: ReadonlyArray<AlertIncidentDocument>,
	range: { readonly min: number; readonly max: number },
	cells: number,
): RibbonCell[] {
	const width = (range.max - range.min) / cells
	return Array.from({ length: cells }, (_, i) => {
		const cellStart = range.min + i * width
		const cellEnd = cellStart + width
		const hits = incidents.filter((incident) => {
			const start = Date.parse(incident.firstTriggeredAt)
			const end = incident.resolvedAt === null ? range.max : Date.parse(incident.resolvedAt)
			return end > cellStart && start < cellEnd
		})
		if (hits.some((incident) => incident.severity === "critical")) return "critical"
		return hits.length > 0 ? "warning" : "quiet"
	})
}

export type BlindSpotKind = "error" | "stale" | "no-data" | "unrouted" | "delivery" | "slowed"

export interface BlindSpot {
	readonly rule: AlertRuleDocument
	readonly kind: BlindSpotKind
	readonly detail: string
}

const BLIND_SPOT_ORDER: Record<BlindSpotKind, number> = {
	error: 0,
	stale: 1,
	"no-data": 2,
	unrouted: 3,
	delivery: 4,
	slowed: 5,
} satisfies Record<BlindSpotKind, number>

/** Enabled rules that cannot fire, reach nobody, or were slowed to keep up. One entry per rule, worst first. */
export function blindSpots(
	rules: ReadonlyArray<AlertRuleDocument>,
	derivedByRuleId: ReadonlyMap<string, DerivedRuleStatus>,
): BlindSpot[] {
	const spots: BlindSpot[] = []
	for (const rule of rules) {
		const derived = derivedByRuleId.get(rule.id)
		if (derived === undefined || derived.status === "disabled") continue
		const reason = derived.reason ?? ""
		if (derived.status === "error") spots.push({ rule, kind: "error", detail: reason })
		else if (derived.status === "stale") spots.push({ rule, kind: "stale", detail: reason })
		else if (derived.status === "no-data") spots.push({ rule, kind: "no-data", detail: reason })
		else if (derived.attention.noDestinations)
			spots.push({ rule, kind: "unrouted", detail: "No destinations, so nobody is notified" })
		else if (derived.attention.recentDeliveryFailure)
			spots.push({ rule, kind: "delivery", detail: "The last notification failed to deliver" })
		// Last: a slowed rule still fires, so a rule that reaches nobody outranks it.
		else if (derived.attention.slowedDown && rule.slowedIntervalMinutes !== null)
			spots.push({
				rule,
				kind: "slowed",
				detail: `Checked every ${rule.slowedIntervalMinutes} min because its query kept hitting its limit`,
			})
	}
	return spots.sort((a, b) => BLIND_SPOT_ORDER[a.kind] - BLIND_SPOT_ORDER[b.kind])
}
