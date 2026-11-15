import { afterEach, assert, describe, it } from "@effect/vitest"
import type { CostBudgetCreateRequest } from "@maple/domain/http"
import { Array as Arr, Effect, Schema } from "effect"
import { TestClock } from "effect/testing"
import { cleanupTestDbs, queryFirstRow, type TestDb } from "@maple/backend/testing/test-pglite"
import { CostBudgetsService } from "@maple/backend/services/cost/CostBudgetsService"
import {
	type Spend,
	budgetHarness,
	connectCostSource,
	syncCostSource,
} from "@maple/backend/services/cost/cost-budget-test-support"
import { alertServices, asOrgId, asUserId, createWebhookDestination } from "./alerts-service-test-support"

const trackedDbs: TestDb[] = []
afterEach(() => cleanupTestDbs(trackedDbs))

const orgId = asOrgId("org_cost_budget_alerts")
const userId = asUserId("user_cost_budget_alerts")

const at = (iso: string) => Date.parse(iso)

/** Mid November: fifteen complete days of a thirty day month have passed. */
const MID_NOVEMBER = at("2026-11-16T10:00:00Z")

/**
 * A 1,000 USD monthly budget on AWS: a warning when the forecast passes it, a critical when the
 * spend does. Both tiers notify the one webhook.
 */
const createBudget = Effect.fn(function* (overrides: Partial<CostBudgetCreateRequest> = {}) {
	const alerts = yield* alertServices
	const budgets = yield* CostBudgetsService
	const destination = yield* createWebhookDestination(alerts, orgId, userId)
	return yield* budgets.create(
		orgId,
		{
			name: "AWS production",
			amount: 1000,
			currency: "USD",
			period: "month",
			filters: { provider: ["aws"] },
			alerts: [
				{ severity: "warning", percent: 100, basis: "forecast", destinationIds: [destination.id] },
				{ severity: "critical", percent: 100, basis: "actual", destinationIds: [destination.id] },
			],
			...overrides,
		},
		userId,
	)
})

const ruleState = (testDb: TestDb, ruleId: string) =>
	Effect.promise(() =>
		queryFirstRow<{ last_status: string | null; last_value: number | null; last_error: string | null }>(
			testDb,
			"select last_status, last_value, last_error from alert_rule_states where rule_id = $1",
			[ruleId],
		),
	)

const Notification = Schema.fromJsonString(
	Schema.Struct({
		eventType: Schema.String,
		observed: Schema.Struct({ detail: Schema.String, value: Schema.Number }),
	}),
)
const decodeNotification = Schema.decodeSync(Notification)

describe("AlertsService cost budgets", () => {
	it.effect("stays healthy while spend and forecast are under the budget", () => {
		const { layer, testDb } = budgetHarness(trackedDbs, { days: [{ day: "2026-11-15", cost: 400 }] })
		return Effect.gen(function* () {
			yield* TestClock.setTime(MID_NOVEMBER)
			yield* connectCostSource(testDb, orgId)
			const alerts = yield* alertServices
			const budget = yield* createBudget()

			yield* alerts.runSchedulerTick()

			assert.lengthOf((yield* alerts.listIncidents(orgId)).incidents, 0)
			assert.deepInclude(yield* ruleState(testDb, budget.id), {
				last_status: "healthy",
				last_value: 40,
				last_error: null,
			})
		}).pipe(Effect.provide(layer))
	})

	it.effect("warns on the forecast, turns critical on the spend, and resolves when the month turns", () => {
		const spend: Spend = { days: [{ day: "2026-11-15", cost: 600 }] }
		const { layer, testDb } = budgetHarness(trackedDbs, spend)
		return Effect.gen(function* () {
			yield* TestClock.setTime(MID_NOVEMBER)
			yield* connectCostSource(testDb, orgId)
			const alerts = yield* alertServices
			const budget = yield* createBudget()

			// 600 in fifteen days projects to 1,200: over on the forecast, not yet on the spend.
			yield* alerts.runSchedulerTick()
			const warned = (yield* alerts.listIncidents(orgId)).incidents
			assert.lengthOf(warned, 1)
			assert.deepInclude(warned[0], {
				ruleId: budget.id,
				ruleName: "AWS production",
				signalType: "cost_budget",
				severity: "warning",
				status: "open",
				lastObservedValue: 120,
			})

			// The next sync brings the spend itself over the amount.
			spend.days = [{ day: "2026-11-19", cost: 1100 }]
			yield* TestClock.setTime(at("2026-11-20T10:00:00Z"))
			yield* syncCostSource(testDb, at("2026-11-20T09:00:00Z"))
			yield* alerts.runSchedulerTick()
			const escalated = (yield* alerts.listIncidents(orgId)).incidents
			assert.lengthOf(escalated, 1)
			assert.deepInclude(escalated[0], { severity: "critical", status: "open", lastObservedValue: 110 })

			// A budget that is spent is no fault in a service: nothing goes to the errors triage queue.
			const issues = yield* Effect.promise(() =>
				queryFirstRow<{ issues: number }>(
					testDb,
					"select count(*)::int as issues from error_issues where org_id = $1",
					[orgId],
				),
			)
			assert.deepInclude(issues, { issues: 0 })

			// December starts at zero: November's spend is no longer the budget's.
			yield* TestClock.setTime(at("2026-12-01T02:00:00Z"))
			yield* syncCostSource(testDb, at("2026-12-01T01:00:00Z"))
			yield* alerts.runSchedulerTick()
			assert.strictEqual((yield* alerts.listIncidents(orgId)).incidents[0]?.status, "resolved")
			assert.deepInclude(yield* ruleState(testDb, budget.id), {
				last_status: "healthy",
				last_value: 0,
				last_error: null,
			})
		}).pipe(Effect.provide(layer))
	})

	// Notifications say what was spent or forecast, of how much and for which period.
	it.effect("notifies with the money as its detail", () => {
		const { layer, testDb, bodies } = budgetHarness(trackedDbs, {
			days: [{ day: "2026-11-15", cost: 600 }],
		})
		return Effect.gen(function* () {
			yield* TestClock.setTime(MID_NOVEMBER)
			yield* connectCostSource(testDb, orgId)
			const alerts = yield* alertServices
			yield* createBudget()
			yield* alerts.runSchedulerTick()

			assert.deepStrictEqual(
				Arr.map((yield* alerts.listDeliveryEvents(orgId)).events, (event) => event.eventType),
				["trigger"],
			)
			assert.deepStrictEqual(decodeNotification(bodies[0] ?? ""), {
				eventType: "trigger",
				observed: {
					detail: "Forecast to spend $1,200.00 of the $1,000.00 monthly budget (120%) by 2026-11-30; $600.00 spent so far",
					value: 120,
				},
			})
		}).pipe(Effect.provide(layer))
	})

	it.effect("reads the budget's own slice of spend, from the first day of its period", () => {
		const { layer, testDb, statements } = budgetHarness(trackedDbs, { days: [] })
		return Effect.gen(function* () {
			yield* TestClock.setTime(MID_NOVEMBER)
			yield* connectCostSource(testDb, orgId)
			const alerts = yield* alertServices
			yield* createBudget({ period: "quarter", currency: "EUR", metric: "effective" })

			yield* alerts.runSchedulerTick()

			assert.lengthOf(statements, 1)
			assert.include(statements[0], `OrgId = '${orgId}'`)
			assert.include(statements[0], "'2026-10-01 00:00:00'")
			assert.include(statements[0], "'2026-11-16 00:00:00'")
			assert.include(statements[0], "Currency = 'EUR'")
			assert.include(statements[0], "'aws'")
			assert.include(statements[0], "EffectiveCost")
		}).pipe(Effect.provide(layer))
	})

	// An org with no connected source has no cost to read: the budget stands at zero.
	it.effect("is healthy at zero, without a warehouse read, when the org has no cost source", () => {
		const { layer, testDb, statements } = budgetHarness(trackedDbs, {
			days: [{ day: "2026-11-15", cost: 5000 }],
		})
		return Effect.gen(function* () {
			yield* TestClock.setTime(MID_NOVEMBER)
			const alerts = yield* alertServices
			const budget = yield* createBudget()

			yield* alerts.runSchedulerTick()

			assert.lengthOf(statements, 0)
			assert.lengthOf((yield* alerts.listIncidents(orgId)).incidents, 0)
			assert.deepInclude(yield* ruleState(testDb, budget.id), { last_status: "healthy", last_value: 0 })
		}).pipe(Effect.provide(layer))
	})

	it.effect("a disabled budget is not checked", () => {
		const { layer, testDb, statements } = budgetHarness(trackedDbs, {
			days: [{ day: "2026-11-15", cost: 5000 }],
		})
		return Effect.gen(function* () {
			yield* TestClock.setTime(MID_NOVEMBER)
			yield* connectCostSource(testDb, orgId)
			const alerts = yield* alertServices
			yield* createBudget({ enabled: false })

			yield* alerts.runSchedulerTick()

			assert.lengthOf(statements, 0)
			assert.lengthOf((yield* alerts.listIncidents(orgId)).incidents, 0)
		}).pipe(Effect.provide(layer))
	})
})
