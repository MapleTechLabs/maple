import { UNGROUPED_GROUP_KEY, type AlertIncidentDocument, type AlertRuleDocument } from "@maple/domain/http"

import type { AlertRuleStateRow } from "../collections/alerts"

/** How close one enabled rule's nearest group sits to firing, from its last recorded check. */
export interface RuleHeadroom {
	readonly rule: AlertRuleDocument
	/** The group nearest its threshold; null for an ungrouped rule. */
	readonly groupKey: string | null
	readonly value: number
	/**
	 * 0 = far from firing, 1 = at the threshold. Null for comparators with no
	 * single direction (equality and ranges), which still list their value.
	 */
	readonly closeness: number | null
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
 * to measure yet, and the blind-spots list already names them.
 */
export function ruleHeadroom(
	rules: ReadonlyArray<AlertRuleDocument>,
	statesByRule: ReadonlyMap<string, ReadonlyArray<AlertRuleStateRow>>,
): RuleHeadroom[] {
	return rules
		.filter((rule) => rule.enabled)
		.flatMap((rule) => {
			const measured = (statesByRule.get(rule.id) ?? []).flatMap((state) =>
				state.last_value === null
					? []
					: [
							{
								groupKey: state.group_key === UNGROUPED_GROUP_KEY ? null : state.group_key,
								value: state.last_value,
								closeness: closenessOf(rule, state.last_value),
								checkedAt:
									state.last_evaluated_at === null
										? null
										: Date.parse(state.last_evaluated_at),
							},
						],
			)
			const nearest = measured.toSorted((a, b) => (b.closeness ?? -1) - (a.closeness ?? -1))[0]
			return nearest === undefined ? [] : [{ rule, ...nearest }]
		})
		.toSorted((a, b) => (b.closeness ?? -1) - (a.closeness ?? -1))
}

/**
 * Milliseconds since the org was last firing: since the latest resolve, or
 * null when nothing has fired in the incidents on hand.
 */
export function quietForMs(incidents: ReadonlyArray<AlertIncidentDocument>, now: number): number | null {
	const lastResolve = incidents.reduce(
		(latest, incident) =>
			incident.resolvedAt === null ? latest : Math.max(latest, Date.parse(incident.resolvedAt)),
		Number.NEGATIVE_INFINITY,
	)
	return Number.isFinite(lastResolve) ? Math.max(0, now - lastResolve) : null
}
