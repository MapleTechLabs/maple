import { UNGROUPED_GROUP_KEY, type AlertIncidentDocument, type AlertRuleDocument } from "@maple/domain/http"

import type { AlertRuleStateRow } from "../collections/alerts"
import { ruleHeadroom as thresholdHeadroom } from "./overview-derive"
import { Array as Arr, Order, Struct } from "effect"

/** How close one enabled rule's nearest group sits to firing, from its last recorded check. */
export interface RuleHeadroom {
	readonly rule: AlertRuleDocument
	/** The group nearest its threshold; null for an ungrouped rule. */
	readonly groupKey: string | null
	/** What to show for the group: an incident's stored label, else the key; null hides it. */
	readonly groupLabel: string | null
	readonly value: number
	/**
	 * 0 = far from firing, 1 = at the threshold. Null for comparators with no
	 * single direction (equality and ranges), which still list their value.
	 */
	readonly closeness: number | null
	/** Share of the threshold left before breaching; null where `closeness` is. Sorts the list. */
	readonly headroom: number | null
	/** Past the threshold or close to it, by the same test as the Rules tab's meter. */
	readonly isNear: boolean
	readonly checkedAt: number | null
}

/** Value over threshold for a ceiling, threshold over value for a floor; clamped to [0, 1]. */
function closenessOf(rule: AlertRuleDocument, value: number): number | null {
	const clamp = (n: number) => (Number.isFinite(n) ? Math.min(Math.max(n, 0), 1) : 1)
	switch (rule.comparator) {
		case "gt":
		case "gte":
			return rule.threshold <= 0 ? null : clamp(value / rule.threshold)
		case "lt":
		case "lte":
			return value <= 0 ? 1 : clamp(rule.threshold / value)
		default:
			return null
	}
}

/**
 * Every enabled rule's latest value against its threshold, nearest to firing
 * first. Rules that have never produced a value are left out: there is nothing
 * to measure yet, and the blind-spots list already names them. So are values
 * from skipped windows (too few samples keeps its value), which can never fire.
 */
export function ruleHeadroom(
	rules: ReadonlyArray<AlertRuleDocument>,
	statesByRule: ReadonlyMap<string, ReadonlyArray<AlertRuleStateRow>>,
	incidents: ReadonlyArray<AlertIncidentDocument> = [],
): RuleHeadroom[] {
	const labels = new Map(
		Arr.flatMap(incidents, (incident) =>
			incident.groupLabel == null
				? []
				: [[`${incident.ruleId}:${incident.groupKey}`, incident.groupLabel] as const],
		),
	)
	// An anomaly rule's group key is an incident id, which is never shown.
	const labelOf = (rule: AlertRuleDocument, groupKey: string | null): string | null =>
		groupKey === null
			? null
			: (labels.get(`${rule.id}:${groupKey}`) ?? (rule.signalType === "anomaly" ? null : groupKey))
	// Least headroom first, by the measure that also colours a row near firing.
	const nearestFirst = Order.mapInput(
		Order.Number,
		(entry: { readonly headroom: number | null }) => entry.headroom ?? Number.POSITIVE_INFINITY,
	)
	const enabled = Arr.filter(rules, (rule) => rule.enabled)
	return Arr.sort(
		Arr.flatMap(enabled, (rule) => {
			const measured = Arr.flatMap(statesByRule.get(rule.id) ?? [], (state) =>
				state.last_value === null || state.last_status === "skipped"
					? []
					: [
							{
								groupKey: state.group_key === UNGROUPED_GROUP_KEY ? null : state.group_key,
								groupLabel: labelOf(
									rule,
									state.group_key === UNGROUPED_GROUP_KEY ? null : state.group_key,
								),
								value: state.last_value,
								closeness: closenessOf(rule, state.last_value),
								...Struct.pick(thresholdHeadroom(rule, state.last_value), [
									"headroom",
									"isNear",
								]),
								checkedAt:
									state.last_evaluated_at === null
										? null
										: Date.parse(state.last_evaluated_at),
							},
						],
			)
			const nearest = Arr.sort(measured, nearestFirst)[0]
			return nearest === undefined ? [] : [{ rule, ...nearest }]
		}),
		nearestFirst,
	)
}

/**
 * Milliseconds since the org was last firing: since the latest resolve, or
 * null when nothing has fired in the incidents on hand.
 */
export function quietForMs(incidents: ReadonlyArray<AlertIncidentDocument>, now: number): number | null {
	const lastResolve = Arr.reduce(incidents, Number.NEGATIVE_INFINITY, (latest, incident) =>
		incident.resolvedAt === null ? latest : Math.max(latest, Date.parse(incident.resolvedAt)),
	)
	return Number.isFinite(lastResolve) ? Math.max(0, now - lastResolve) : null
}
