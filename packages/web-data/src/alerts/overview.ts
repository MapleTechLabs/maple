import type { AlertDeliveryEventDocument, AlertIncidentDocument, AlertRuleDocument } from "@maple/domain/http"

import type { AlertRuleStateRow } from "../collections/alerts"
import { deriveRuleStatus, type DerivedRuleStatus, needsAttention } from "./rule-status"

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * Oldest resolved incident the overview still processes — the widest window any
 * consumer renders (the summary strip's 30d "Triggered" count). The synced
 * collection holds the org's full incident history; without this cutoff every
 * derivation re-sorts and re-groups an ever-growing set, which is what
 * gradually locked up the tab during long firing stretches. Open incidents are
 * always kept.
 */
const INCIDENT_WINDOW_MS = 30 * DAY_MS

export interface AlertsHealthCounts {
	firing: number
	attention: number
	healthy: number
	disabled: number
}

/** The fully derived overview — everything the tab renders per rule. */
export interface AlertsOverviewReady {
	readonly phase: "ready"
	readonly rules: ReadonlyArray<AlertRuleDocument>
	readonly incidents: ReadonlyArray<AlertIncidentDocument>
	readonly openIncidents: ReadonlyArray<AlertIncidentDocument>
	readonly statesByRule: Map<string, AlertRuleStateRow[]>
	readonly incidentsByRule: Map<string, AlertIncidentDocument[]>
	readonly derivedByRuleId: Map<string, DerivedRuleStatus>
	readonly healthCounts: AlertsHealthCounts
	readonly timelineRange: { readonly min: number; readonly max: number }
}

/** The derived overview, in the phases the tab renders distinctly. */
export type AlertsOverviewData =
	| { readonly phase: "loading" }
	| { readonly phase: "error"; readonly message: string }
	| AlertsOverviewReady

export interface OverviewInputs {
	readonly rules: ReadonlyArray<AlertRuleDocument>
	readonly incidents: ReadonlyArray<AlertIncidentDocument>
	readonly states: ReadonlyArray<AlertRuleStateRow>
	readonly deliveryEvents: ReadonlyArray<AlertDeliveryEventDocument>
	readonly now: number
}

const groupByRuleId = <T extends { readonly ruleId: string }>(items: ReadonlyArray<T>): Map<string, T[]> => {
	const map = new Map<string, T[]>()
	for (const item of items) {
		const list = map.get(item.ruleId)
		if (list) list.push(item)
		else map.set(item.ruleId, [item])
	}
	return map
}

/**
 * The whole overview derivation as one pure function over domain documents —
 * unit-testable without React or a registry. Replaces the useMemo chain the
 * overview tab used to run per render.
 */
export const deriveOverview = (inputs: OverviewInputs): AlertsOverviewReady => {
	const { now } = inputs
	// ISO timestamps order lexicographically; newest first, as the server lists do.
	const byIsoDesc = (a: string, b: string) => (a < b ? 1 : a > b ? -1 : 0)
	const rules = [...inputs.rules].sort((a, b) => byIsoDesc(a.updatedAt, b.updatedAt))
	const incidentCutoff = now - INCIDENT_WINDOW_MS
	const incidents = inputs.incidents
		.filter(
			(incident) =>
				incident.status === "open" || Date.parse(incident.lastTriggeredAt) >= incidentCutoff,
		)
		.sort((a, b) => byIsoDesc(a.lastTriggeredAt, b.lastTriggeredAt))

	const openIncidents = incidents.filter((incident) => incident.status === "open")
	const incidentsByRule = groupByRuleId(incidents)
	const openIncidentsByRule = groupByRuleId(openIncidents)
	// The delivery-events list arrives newest-first; deriveRuleStatus relies on it.
	const deliveriesByRule = groupByRuleId(inputs.deliveryEvents)

	const statesByRule = new Map<string, AlertRuleStateRow[]>()
	for (const state of inputs.states) {
		const list = statesByRule.get(state.rule_id)
		if (list) list.push(state)
		else statesByRule.set(state.rule_id, [state])
	}

	const derivedByRuleId = new Map<string, DerivedRuleStatus>()
	const healthCounts: AlertsHealthCounts = { firing: 0, attention: 0, healthy: 0, disabled: 0 }
	for (const rule of rules) {
		const derived = deriveRuleStatus({
			rule,
			states: statesByRule.get(rule.id) ?? [],
			openIncidents: openIncidentsByRule.get(rule.id) ?? [],
			deliveryEvents: deliveriesByRule.get(rule.id) ?? [],
			now,
		})
		derivedByRuleId.set(rule.id, derived)
		if (derived.status === "firing") healthCounts.firing++
		else if (derived.status === "healthy") healthCounts.healthy++
		else if (derived.status === "disabled") healthCounts.disabled++
		if (needsAttention(derived)) healthCounts.attention++
	}

	return {
		phase: "ready",
		rules,
		incidents,
		openIncidents,
		statesByRule,
		incidentsByRule,
		derivedByRuleId,
		healthCounts,
		timelineRange: { min: now - DAY_MS, max: now },
	}
}

