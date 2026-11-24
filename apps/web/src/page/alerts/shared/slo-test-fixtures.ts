import { V2Slo, V2SloHistory, V2SloStatus } from "@maple/domain/http/v2"
import { SLO_BUDGET_GROUP_KEY, sloRuleName } from "@maple/domain/slo"
import type { AlertIncidentRow } from "@maple/web-data/collections/alerts"
import { Array as Arr, Schema } from "effect"
import { DESTINATION_ID, incidentRow, NOW, ruleId } from "../../kit/alert-test-rows"

export const sloUuid = (n: number) => `0199a00a-0000-7000-8000-00000000000${n}`
/** The burn-rate rule behind the default SLO; its incidents carry it as `rule_id`. */
export const SLO_RULE_UUID = ruleId(8)
/** The spent-budget incident's id: it stays open beside the burn incident, so it needs its own. */
export const SLO_BUDGET_INCIDENT_ID = "0199a003-0000-7000-8000-000000000002"

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

/** An open burn incident of the default SLO's rule: critical, in the ungrouped alert group. */
export const burnIncidentRow = (fields: Partial<AlertIncidentRow> = {}): AlertIncidentRow =>
	incidentRow({
		rule_id: SLO_RULE_UUID,
		rule_name: sloRuleName("Checkout API"),
		signal_type: "slo_burn_rate",
		comparator: "gte",
		threshold: 14.4,
		last_observed_value: 16.1,
		...fields,
	})

/** The same rule's spent-budget incident: a warning in its own group, observing the share used. */
export const budgetIncidentRow = (fields: Partial<AlertIncidentRow> = {}): AlertIncidentRow =>
	burnIncidentRow({
		id: SLO_BUDGET_INCIDENT_ID,
		incident_key: "slo:budget",
		dedupe_key: "slo:budget",
		group_key: SLO_BUDGET_GROUP_KEY,
		severity: "warning",
		threshold: 1,
		last_observed_value: 1.35,
		...fields,
	})

/** `exports` availability at 90% over 30 days: a target so low its tiers fire under their own factors. */
export const lowTargetSlo = (fields: Record<string, unknown> = {}): V2Slo =>
	checkoutSlo({
		id: sloUuid(4),
		name: "Batch exports",
		description: "Nightly exports finish.",
		service_name: "exports",
		target_percent: 90,
		alert_rule_id: ruleId(7),
		...fields,
	})

/** Scenarios told by their burn rates, on a busy service. */
type RateScenario = "healthy" | "burning" | "exhausted" | "spent-burning" | "holding" | "slow" | "capped"

/** `sparse`: a quiet service that burns on a handful of events. `no-data`: the window counted nothing. */
export type SloScenario = RateScenario | "sparse" | "no-data"

type Burns = readonly [
	number | null,
	number | null,
	number | null,
	number | null,
	number | null,
	number | null,
]

/** Budget left over the window, and the 5m, 30m, 1h, 2h, 6h and 24h burn rates (`null`: no events). */
const SCENARIOS = {
	healthy: { budget: 0.62, burns: [0.4, 0.6, 0.5, 0.5, 0.45, 0.4] },
	// Both critical windows (1h, 5m) at 14.4x or more: the page tier fires.
	burning: { budget: 0.12, burns: [18.2, 9.4, 16.1, 11.8, 7.3, 2.4] },
	exhausted: { budget: -0.35, burns: [2.1, 1.8, 1.6, 1.5, 1.4, 1.3] },
	// Out of budget and still burning hard: the burn and the spent budget are open at once.
	"spent-burning": { budget: -0.08, burns: [18.2, 9.4, 16.1, 11.8, 7.3, 2.4] },
	// An outage: no events in 5m or 30m, so the two fast tiers hold after the 1h burned hard.
	holding: { budget: 0.12, burns: [null, null, 16.1, 11.8, 7.3, 2.4] },
	// A steady leak: under both fast tiers, over 3x for the whole day, so only the slow tier fires.
	slow: { budget: 0.55, burns: [3.4, 3.6, 3.8, 3.5, 3.9, 3.2] },
	// For a 90% target: 1h and 5m pass its capped 8x, a burn 14.4x could never see.
	capped: { budget: 0.4, burns: [8.6, 5.2, 8.3, 6.1, 5, 1.6] },
} as const satisfies Record<RateScenario, { budget: number; burns: Burns }>

const WINDOWS = [5, 30, 60, 120, 360, 1440] as const
const TOTAL = 1_240_000

/** A quiet service: one failed request per window, so every tier burns on too few events to judge. */
const SPARSE = { total: 300, bad: 1, windows: [2, 4, 6, 9, 20, 70] } as const

/** A status for an SLO with `targetPercent`, its counts consistent with the budget and burns. */
export const sloStatus = (
	scenario: SloScenario,
	options: Readonly<{ sloId?: string; targetPercent?: number }> = {},
): V2SloStatus => {
	const budgetRatio = 1 - (options.targetPercent ?? 99.9) / 100
	const head = { object: "slo.status", slo_id: options.sloId ?? sloUuid(1), as_of: iso(0) }
	// No events at all: no SLI, an untouched budget, every window empty.
	if (scenario === "no-data")
		return decodeStatus({
			...head,
			total_events: 0,
			good_events: 0,
			sample_count: 0,
			sli: null,
			budget_remaining: 1,
			burn_windows: Arr.map(WINDOWS, (minutes) => ({
				window_minutes: minutes,
				burn_rate: 0,
				total_events: 0,
				good_events: 0,
				sample_count: 0,
			})),
		})
	if (scenario === "sparse") {
		const badShare = SPARSE.bad / SPARSE.total
		return decodeStatus({
			...head,
			total_events: SPARSE.total,
			good_events: SPARSE.total - SPARSE.bad,
			sample_count: SPARSE.total,
			sli: 1 - badShare,
			budget_remaining: 1 - badShare / budgetRatio,
			burn_windows: Arr.map(WINDOWS, (minutes, index) => {
				const total = SPARSE.windows[index] ?? 0
				return {
					window_minutes: minutes,
					burn_rate: SPARSE.bad / total / budgetRatio,
					total_events: total,
					good_events: total - SPARSE.bad,
					sample_count: total,
				}
			}),
		})
	}
	const { budget, burns } = SCENARIOS[scenario]
	const badShare = (1 - budget) * budgetRatio
	return decodeStatus({
		...head,
		total_events: TOTAL,
		good_events: TOTAL * (1 - badShare),
		sample_count: TOTAL,
		sli: 1 - badShare,
		budget_remaining: budget,
		burn_windows: Arr.map(WINDOWS, (minutes, index) => {
			const burn = burns[index] ?? null
			const rate = burn ?? 0
			const total = burn === null ? 0 : (TOTAL / (30 * 24 * 60)) * minutes
			return {
				window_minutes: minutes,
				burn_rate: rate,
				total_events: total,
				good_events: total * (1 - rate * budgetRatio),
				sample_count: total,
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
	// No events: every hour has no SLI and the budget never moves.
	if (scenario === "no-data")
		return decodeHistory({
			object: "slo.history",
			slo_id: options.sloId ?? sloUuid(1),
			as_of: iso(0),
			bucket_seconds: 3600,
			points: Arr.makeBy(hours, (index) => ({
				at: iso((hours - 1 - index) * HOUR),
				sli: null,
				budget_remaining: 1,
				burn_rate: 0,
			})),
		})
	const end =
		scenario === "sparse" ? 1 - SPARSE.bad / SPARSE.total / budgetRatio : SCENARIOS[scenario].budget
	// A steady spend, then the last day burning hard when the scenario is burning or holding.
	const budgetAt = (index: number): number => {
		const share = index / (hours - 1)
		if (scenario !== "burning" && scenario !== "holding" && scenario !== "spent-burning")
			return 1 - (1 - end) * share
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
