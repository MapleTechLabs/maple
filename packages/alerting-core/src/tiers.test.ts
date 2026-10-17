import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import { foldObservation, type HysteresisRow } from "./hysteresis"
import {
	evaluateAlertObservation,
	planAlertLifecycle,
	type AlertEvaluation,
	type AlertLifecycleIncident,
	type AlertLifecycleInput,
	type AlertLifecyclePlan,
	type AlertThresholdTier,
} from "./index"

const plan = (input: AlertLifecycleInput) => Effect.runSync(planAlertLifecycle(input))

const warnAt = (value: number, recoveryValue: number | null = null): AlertThresholdTier => ({
	severity: "warning",
	value,
	upper: null,
	recoveryValue,
})
const critAt = (value: number, recoveryValue: number | null = null): AlertThresholdTier => ({
	severity: "critical",
	value,
	upper: null,
	recoveryValue,
})

const evaluate = (tiers: ReadonlyArray<AlertThresholdTier>, value: number | null): AlertEvaluation =>
	evaluateAlertObservation(
		{
			comparator: "gt",
			threshold: tiers[0]!.value,
			thresholdUpper: null,
			tiers,
			minimumSampleCount: 0,
			noDataBehavior: "skip",
		},
		{ value, sampleCount: value === null ? 0 : 10, hasData: value !== null },
		"test",
	)

interface Replay {
	readonly plans: ReadonlyArray<AlertLifecyclePlan>
	readonly severities: ReadonlyArray<string | null>
}

/** Feed values through evaluation + lifecycle the way the scheduler does, one tick per value. */
const replay = (
	tiers: ReadonlyArray<AlertThresholdTier>,
	values: ReadonlyArray<number | null>,
	policy: { readonly n: number; readonly m?: number; readonly r: number },
): Replay => {
	const initial = {
		state: null as AlertLifecycleInput["state"],
		incident: null as AlertLifecycleIncident | null,
		plans: [] as ReadonlyArray<AlertLifecyclePlan>,
	}
	const final = values.reduce((acc, value, tick) => {
		const next = plan({
			policy: {
				consecutiveBreachesRequired: policy.n,
				breachWindow: policy.m ?? policy.n,
				consecutiveHealthyRequired: policy.r,
				renotifyIntervalMinutes: 60,
				severities: tiers.map((tier) => tier.severity),
			},
			evaluation: evaluate(tiers, value),
			state: acc.state,
			openIncident: acc.incident,
			nowMs: tick * 60_000,
		})
		const incident: AlertLifecycleIncident | null =
			next.transition === "resolved" || next.severity === null
				? null
				: {
						severity: next.severity,
						firstTriggeredAtMs: acc.incident?.firstTriggeredAtMs ?? tick * 60_000,
						lastNotifiedAtMs: tick * 60_000,
						lastDeliveredEventType: "trigger",
					}
		return { state: next.state, incident, plans: [...acc.plans, next] }
	}, initial)
	return { plans: final.plans, severities: final.plans.map((p) => p.severity) }
}

describe("severity tiers", () => {
	it("opens at warning, escalates to critical, de-escalates, then resolves", () => {
		const { plans, severities } = replay([warnAt(10), critAt(20)], [15, 15, 25, 25, 15, 15, 5, 5], {
			n: 2,
			r: 2,
		})
		expect(plans.map((p) => p.transition)).toEqual([
			"none",
			"opened",
			// One critical breach is not N = 2 of them yet: still a warning incident.
			"continued",
			"escalated",
			// Back under critical, but critical has not had R = 2 clear checks.
			"continued",
			"deescalated",
			"none",
			"resolved",
		])
		expect(severities).toEqual([
			null,
			"warning",
			"warning",
			"critical",
			"critical",
			"warning",
			"warning",
			null,
		])
		// Escalation pages like a trigger; de-escalation reads as a reminder.
		expect(plans[3]).toMatchObject({ eventType: "trigger", advanceNotificationAnchor: true })
		expect(plans[5]).toMatchObject({ eventType: "renotify", advanceNotificationAnchor: true })
	})

	it("opens straight at critical when the value jumps past both tiers", () => {
		const { plans } = replay([warnAt(10), critAt(20)], [30, 30], { n: 2, r: 2 })
		expect(plans[1]).toMatchObject({ transition: "opened", severity: "critical", eventType: "trigger" })
	})

	it("holds an incident open inside the recovery band", () => {
		// Trigger above 10, clear only at or below 8: 9 is the dead band.
		const { plans } = replay([warnAt(10, 8)], [12, 12, 9, 9, 9, 7, 7], { n: 2, r: 2 })
		expect(plans.map((p) => p.transition)).toEqual([
			"none",
			"opened",
			"none",
			"none",
			"none",
			"none",
			"resolved",
		])
	})

	it("does not count a recovery-band check as healthy in the audit counters", () => {
		const { plans } = replay([warnAt(10, 8)], [12, 12, 9, 7], { n: 2, r: 2 })
		expect(plans.map((p) => p.state.consecutiveHealthy)).toEqual([0, 0, 0, 1])
	})

	it("does not re-open from inside the recovery band", () => {
		const { plans } = replay([warnAt(10, 8)], [9, 9, 9], { n: 1, r: 1 })
		expect(plans.every((p) => p.transition === "none")).toBe(true)
	})

	it("opens on N breaches within the last M checks, not when they are spread wider", () => {
		const within = replay([warnAt(10)], [15, 5, 15, 5, 15], { n: 3, m: 5, r: 2 })
		expect(within.plans.map((p) => p.transition)).toEqual(["none", "none", "none", "none", "opened"])

		const spread = replay([warnAt(10)], [15, 5, 5, 5, 15, 5, 5, 15], { n: 3, m: 5, r: 2 })
		expect(spread.plans.some((p) => p.transition === "opened")).toBe(false)
	})

	it("never opens on a tick that is not itself breaching", () => {
		// 2 of the last 3 are breaches once the third tick lands, but that tick is clear.
		const { plans } = replay([warnAt(10)], [15, 15, 5], { n: 3, m: 3, r: 1 })
		expect(plans.map((p) => p.transition)).toEqual(["none", "none", "none"])
	})

	it("ignores skipped checks: they neither count toward nor reset a run", () => {
		const { plans } = replay([warnAt(10)], [15, null, 15], { n: 2, r: 2 })
		expect(plans.map((p) => p.transition)).toEqual(["none", "none", "opened"])
	})

	it("escalates, not resolves, when its rule's only tier changes severity", () => {
		// A warning incident whose rule is now critical-only; the state row predates the edit.
		const kept = plan({
			policy: {
				consecutiveBreachesRequired: 2,
				breachWindow: 2,
				consecutiveHealthyRequired: 2,
				renotifyIntervalMinutes: 60,
				severities: ["critical"],
			},
			evaluation: evaluate([critAt(10)], 15),
			state: { consecutiveBreaches: 2, consecutiveHealthy: 0, history: null },
			openIncident: {
				severity: "warning",
				firstTriggeredAtMs: 0,
				lastNotifiedAtMs: 60_000,
				lastDeliveredEventType: "trigger",
			},
			nowMs: 120_000,
		})
		expect(kept).toMatchObject({ transition: "escalated", severity: "critical", eventType: "trigger" })
	})

	it("leaves a steady group's history byte-identical, so the state upsert can be skipped", () => {
		const healthy = replay([warnAt(10), critAt(20)], [1, 1, 1, 1, 1, 1], { n: 2, m: 4, r: 3 })
		const histories = healthy.plans.map((p) => JSON.stringify(p.state.history))
		expect(histories.at(-1)).toEqual(histories.at(-2))

		const firing = replay([warnAt(10)], [15, 15, 15, 15, 15, 15], { n: 2, m: 4, r: 3 })
		const firingHistories = firing.plans.map((p) => JSON.stringify(p.state.history))
		expect(firingHistories.at(-1)).toEqual(firingHistories.at(-2))
	})
})

describe("single-tier rules behave exactly as the consecutive-count machine did", () => {
	// Deterministic pseudo-random so a failure reproduces.
	const lcg = (seed: number) => {
		const next = (state: number) => (state * 1_103_515_245 + 12_345) % 2_147_483_648
		return (count: number) =>
			Array.from({ length: count }).reduce<{ seed: number; out: number[] }>(
				(acc) => {
					const seedNext = next(acc.seed)
					return { seed: seedNext, out: [...acc.out, seedNext / 2_147_483_648] }
				},
				{ seed, out: [] },
			).out
	}

	it.each([1, 2, 3, 7, 42, 1234])("seed %i", (seed) => {
		const rolls = lcg(seed)(300)
		const n = 1 + Math.floor(rolls[0]! * 3)
		const r = 1 + Math.floor(rolls[1]! * 3)
		const values = rolls.slice(2).map((roll) => (roll < 0.1 ? null : roll < 0.55 ? 15 : 5))

		const tiered = replay([warnAt(10)], values, { n, r })

		const config = { breachesToOpen: n, healthyToResolve: r, cooldownMs: 0 }
		const legacy = values.reduce(
			(acc, value, tick) => {
				const status = value === null ? "skipped" : value > 10 ? "breached" : "healthy"
				const outcome = Effect.runSync(foldObservation(acc.row, status, config, tick * 60_000))
				const row: HysteresisRow = {
					consecutiveBreaches: outcome.consecutiveBreaches,
					consecutiveHealthy: outcome.consecutiveHealthy,
					incidentOpen:
						outcome.transition === "open"
							? true
							: outcome.transition === "resolve"
								? false
								: acc.row.incidentOpen,
					lastResolvedAtMs: null,
				}
				return { row, outcomes: [...acc.outcomes, outcome] }
			},
			{
				row: {
					consecutiveBreaches: 0,
					consecutiveHealthy: 0,
					incidentOpen: false,
					lastResolvedAtMs: null,
				} as HysteresisRow,
				outcomes: [] as ReadonlyArray<{
					transition: string
					consecutiveBreaches: number
					consecutiveHealthy: number
				}>,
			},
		).outcomes

		const asLegacy = (transition: string) =>
			transition === "opened" ? "open" : transition === "resolved" ? "resolve" : "other"
		expect(tiered.plans.map((p) => asLegacy(p.transition))).toEqual(
			legacy.map((o) =>
				o.transition === "open" || o.transition === "resolve" ? o.transition : "other",
			),
		)
		expect(tiered.plans.map((p) => [p.state.consecutiveBreaches, p.state.consecutiveHealthy])).toEqual(
			legacy.map((o) => [o.consecutiveBreaches, o.consecutiveHealthy]),
		)
	})

	it("replays a pre-history state row from its counters", () => {
		// One breach recorded by the old machine; the next breach must open (N = 2).
		const next = plan({
			policy: {
				consecutiveBreachesRequired: 2,
				breachWindow: 2,
				consecutiveHealthyRequired: 2,
				renotifyIntervalMinutes: 60,
				severities: ["critical"],
			},
			evaluation: evaluate([critAt(10)], 15),
			state: { consecutiveBreaches: 1, consecutiveHealthy: 0, history: null },
			openIncident: null,
			nowMs: 0,
		})
		expect(next).toMatchObject({ transition: "opened", severity: "critical" })
	})
})
