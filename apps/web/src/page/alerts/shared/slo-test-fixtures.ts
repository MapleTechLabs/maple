import { V2Slo, V2SloHistory, V2SloStatus } from "@maple/domain/http/v2"
import { Array as Arr, Schema } from "effect"
import { DESTINATION_ID, NOW, ruleId } from "./test-rows"

// SLOs, statuses and budget histories as the v2 client decodes them, for the scene tests and the lab.

export const sloUuid = (n: number) => `0199a00a-0000-7000-8000-00000000000${n}`
/** The burn-rate rule behind the default SLO; its incidents carry it as `rule_id`. */
export const SLO_RULE_UUID = ruleId(8)
export const WARNING_DESTINATION_UUID = "0199a001-0000-7000-8000-000000000002"

const decodeSlo = Schema.decodeUnknownSync(V2Slo)
const decodeStatus = Schema.decodeUnknownSync(V2SloStatus)
const decodeHistory = Schema.decodeUnknownSync(V2SloHistory)

const HOUR = 3_600_000
const DAY = 24 * HOUR
const iso = (msBefore: number) => new Date(NOW - msBefore).toISOString()

/** `checkout` availability at 99.9% over 30 days, paging the on-call webhook. */
export const checkoutSlo = (fields: Record<string, unknown> = {}): V2Slo =>
	decodeSlo({
		id: sloUuid(1),
		object: "slo",
		name: "Checkout API",
		description: "Checkout requests succeed.",
		service_name: "checkout",
		environments: ["production"],
		sli: { type: "availability" },
		target_percent: 99.9,
		window_days: 30,
		alert_rule_id: SLO_RULE_UUID,
		alerting: {
			enabled: true,
			critical_destination_ids: [DESTINATION_ID],
			warning_destination_ids: [],
		},
		created_at: iso(40 * DAY),
		updated_at: iso(2 * DAY),
		...fields,
	})

/** `search` latency under 500 ms at 99.5% over 28 days, alerting off. */
export const searchSlo = (fields: Record<string, unknown> = {}): V2Slo =>
	decodeSlo({
		id: sloUuid(2),
		object: "slo",
		name: "Search latency",
		description: null,
		service_name: "search",
		environments: [],
		sli: { type: "latency", threshold_ms: 500 },
		target_percent: 99.5,
		window_days: 28,
		alert_rule_id: ruleId(9),
		alerting: { enabled: false, critical_destination_ids: [], warning_destination_ids: [] },
		created_at: iso(20 * DAY),
		updated_at: iso(20 * DAY),
		...fields,
	})

export type SloScenario = "healthy" | "burning" | "exhausted"

/** Budget left over the window, and the 5m, 30m, 1h and 6h burn rates, per scenario. */
const SCENARIOS = {
	healthy: { budget: 0.62, burns: [0.4, 0.6, 0.5, 0.45] },
	// Both critical windows (1h, 5m) at 14.4x or more: the page tier fires.
	burning: { budget: 0.12, burns: [18.2, 9.4, 16.1, 7.3] },
	exhausted: { budget: -0.35, burns: [2.1, 1.8, 1.6, 1.4] },
} as const satisfies Record<SloScenario, { budget: number; burns: readonly [number, number, number, number] }>

const WINDOWS = [5, 30, 60, 360] as const
const TOTAL = 1_240_000

/** A status for an SLO with `targetPercent`, its counts consistent with the budget and burns. */
export const sloStatus = (
	scenario: SloScenario,
	options: Readonly<{ sloId?: string; targetPercent?: number }> = {},
): V2SloStatus => {
	const budgetRatio = 1 - (options.targetPercent ?? 99.9) / 100
	const { budget, burns } = SCENARIOS[scenario]
	const badShare = (1 - budget) * budgetRatio
	return decodeStatus({
		object: "slo.status",
		slo_id: options.sloId ?? sloUuid(1),
		as_of: iso(0),
		total_events: TOTAL,
		good_events: TOTAL * (1 - badShare),
		sli: 1 - badShare,
		budget_remaining: budget,
		burn_windows: Arr.map(WINDOWS, (minutes, index) => {
			const rate = burns[index] ?? 0
			const total = (TOTAL / (30 * 24 * 60)) * minutes
			return {
				window_minutes: minutes,
				burn_rate: rate,
				total_events: total,
				good_events: total * (1 - rate * budgetRatio),
			}
		}),
	})
}

/** Hourly points over `days`, oldest first, the budget falling to the scenario's figure. */
export const sloHistory = (
	scenario: SloScenario,
	options: Readonly<{ sloId?: string; days?: number; targetPercent?: number }> = {},
): V2SloHistory => {
	const hours = (options.days ?? 30) * 24
	const budgetRatio = 1 - (options.targetPercent ?? 99.9) / 100
	const end = SCENARIOS[scenario].budget
	// A steady spend, then the last day burning hard when the scenario is burning.
	const budgetAt = (index: number): number => {
		const share = index / (hours - 1)
		if (scenario !== "burning") return 1 - (1 - end) * share
		const steady = 0.7
		const cutoff = (hours - 24) / (hours - 1)
		return share <= cutoff
			? 1 - (1 - steady) * (share / cutoff)
			: steady - (steady - end) * ((share - cutoff) / (1 - cutoff))
	}
	return decodeHistory({
		object: "slo.history",
		slo_id: options.sloId ?? sloUuid(1),
		as_of: iso(0),
		bucket_seconds: 3600,
		points: Arr.makeBy(hours, (index) => {
			const budget = budgetAt(index)
			const previous = index === 0 ? 1 : budgetAt(index - 1)
			const burn = Math.max(0, (previous - budget) * hours)
			return {
				at: iso((hours - 1 - index) * HOUR),
				sli: 1 - burn * budgetRatio,
				budget_remaining: budget,
				burn_rate: burn,
			}
		}),
	})
}
