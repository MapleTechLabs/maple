import { afterEach, assert, describe, it } from "@effect/vitest"
import {
	AlertRuleUpsertRequest,
	type CostBudgetCreateRequest,
	MAX_COST_BUDGETS_PER_ORG,
	type TenantContext,
} from "@maple/domain/http"
import { AlertDestinationId } from "@maple/primitives"
import { Array as Arr, Duration, Effect } from "effect"
import { TestClock } from "effect/testing"
import {
	adminRoles,
	alertServices,
	asOrgId,
	asUserId,
	createErrorRateRule,
	createWebhookDestination,
} from "@maple/backend/services/alerts/alerts-service-test-support"
import { cleanupTestDbs, queryFirstRow, type TestDb } from "@maple/backend/testing/test-pglite"
import { CostBudgetsService } from "./CostBudgetsService"
import { budgetHarness, connectCostSource } from "./cost-budget-test-support"

const trackedDbs: TestDb[] = []
afterEach(() => cleanupTestDbs(trackedDbs))

const orgId = asOrgId("org_cost_budgets")
const otherOrgId = asOrgId("org_cost_budgets_other")
const userId = asUserId("user_cost_budgets")
const editorId = asUserId("user_cost_budgets_editor")

const tenantOf = (org: typeof orgId): TenantContext => ({
	orgId: org,
	userId,
	roles: [],
	authMode: "self_hosted",
})

const NOW = Date.parse("2026-11-16T10:00:00Z")

const budgetInput = (overrides: Partial<CostBudgetCreateRequest> = {}): CostBudgetCreateRequest => ({
	name: "AWS production",
	amount: 1000,
	currency: "USD",
	period: "month",
	filters: { provider: ["aws"] },
	alerts: [{ severity: "critical", percent: 100, basis: "actual", destinationIds: [] }],
	...overrides,
})

/** The tag an attempt was refused with. */
const refusal = <A, E extends { readonly _tag: string }>(attempt: Effect.Effect<A, E>) =>
	Effect.map(Effect.flip(attempt), (error) => error._tag)

const ruleRow = (testDb: TestDb, id: string) =>
	Effect.promise(() =>
		queryFirstRow<{ signal_type: string; created_by: string; updated_by: string; updated_at: Date }>(
			testDb,
			"select signal_type, created_by, updated_by, updated_at from alert_rules where id = $1",
			[id],
		),
	)

describe("CostBudgetsService", () => {
	it.effect("creates a budget as a cost_budget rule owned by its author", () => {
		const { layer, testDb } = budgetHarness(trackedDbs, { days: [] })
		return Effect.gen(function* () {
			yield* TestClock.setTime(NOW)
			const alerts = yield* alertServices
			const budgets = yield* CostBudgetsService
			const destination = yield* createWebhookDestination(alerts, orgId, userId)

			const created = yield* budgets.create(
				orgId,
				budgetInput({
					alerts: [
						{
							severity: "critical",
							percent: 100,
							basis: "actual",
							destinationIds: [destination.id, destination.id],
						},
						{ severity: "warning", percent: 80, basis: "forecast", destinationIds: [] },
					],
				}),
				userId,
			)

			assert.deepStrictEqual(
				{ ...created, id: null },
				{
					id: null,
					name: "AWS production",
					enabled: true,
					amount: 1000,
					currency: "USD",
					period: "month",
					metric: "billed",
					filters: { provider: ["aws"] },
					alerts: [
						{ severity: "warning", percent: 80, basis: "forecast", destinationIds: [] },
						{
							severity: "critical",
							percent: 100,
							basis: "actual",
							destinationIds: [destination.id],
						},
					],
					createdAt: NOW,
					updatedAt: NOW,
				},
			)
			assert.deepStrictEqual(yield* budgets.get(orgId, created.id), created)
			assert.deepInclude(yield* ruleRow(testDb, created.id), {
				signal_type: "cost_budget",
				created_by: userId,
			})
		}).pipe(Effect.provide(layer))
	})

	it.effect(
		"lists newest first with where each stands, only the org's own, never another kind of rule",
		() => {
			const { layer, testDb } = budgetHarness(trackedDbs, { days: [{ day: "2026-11-15", cost: 600 }] })
			return Effect.gen(function* () {
				yield* TestClock.setTime(NOW)
				yield* connectCostSource(testDb, orgId)
				const alerts = yield* alertServices
				const budgets = yield* CostBudgetsService
				const destination = yield* createWebhookDestination(alerts, orgId, userId)
				yield* createErrorRateRule(alerts, orgId, userId, destination.id)
				yield* budgets.create(otherOrgId, budgetInput(), userId)
				const first = yield* budgets.create(orgId, budgetInput({ name: "First" }), userId)
				yield* TestClock.adjust(Duration.seconds(1))
				const second = yield* budgets.create(
					orgId,
					budgetInput({ name: "Second", amount: 2000, period: "quarter" }),
					userId,
				)

				const listed = yield* budgets.list(tenantOf(orgId))

				assert.deepStrictEqual(
					Arr.map(listed, (budget) => budget.id),
					[second.id, first.id],
				)
				assert.deepInclude(listed[1]?.progress, {
					periodStart: "2026-11-01",
					periodEnd: "2026-11-30",
					spent: 600,
					percent: 60,
					forecast: 1200,
					forecastPercent: 120,
				})
				assert.deepInclude(listed[0]?.progress, {
					periodStart: "2026-10-01",
					periodEnd: "2026-12-31",
					spent: 600,
					percent: 30,
				})
			}).pipe(Effect.provide(layer))
		},
	)

	it.effect(
		"updates only the fields sent, replacing filters and alerts whole, under the editor's name",
		() => {
			const { layer, testDb } = budgetHarness(trackedDbs, { days: [] })
			return Effect.gen(function* () {
				yield* TestClock.setTime(NOW)
				const budgets = yield* CostBudgetsService
				const created = yield* budgets.create(orgId, budgetInput(), userId)
				yield* TestClock.adjust(Duration.minutes(1))

				const updated = yield* budgets.update(
					orgId,
					created.id,
					{
						amount: 2500,
						filters: { cloud_service: ["Amazon EC2"] },
						alerts: [{ severity: "warning", percent: 90, basis: "forecast", destinationIds: [] }],
					},
					editorId,
				)

				assert.deepStrictEqual(updated, {
					...created,
					amount: 2500,
					filters: { cloud_service: ["Amazon EC2"] },
					alerts: [{ severity: "warning", percent: 90, basis: "forecast", destinationIds: [] }],
					updatedAt: NOW + 60_000,
				})
				assert.deepInclude(yield* ruleRow(testDb, created.id), {
					created_by: userId,
					updated_by: editorId,
				})
			}).pipe(Effect.provide(layer))
		},
	)

	// alert_rules is synced to browsers: a save that changes nothing must not write the row.
	it.effect("leaves the row untouched when an update changes nothing", () => {
		const { layer, testDb } = budgetHarness(trackedDbs, { days: [] })
		return Effect.gen(function* () {
			yield* TestClock.setTime(NOW)
			const budgets = yield* CostBudgetsService
			const created = yield* budgets.create(orgId, budgetInput(), userId)
			yield* TestClock.adjust(Duration.minutes(1))

			const same = yield* budgets.update(
				orgId,
				created.id,
				{ name: created.name, amount: 1000, alerts: budgetInput().alerts },
				editorId,
			)

			assert.deepStrictEqual(same, created)
			assert.deepInclude(yield* ruleRow(testDb, created.id), { updated_by: userId })
		}).pipe(Effect.provide(layer))
	})

	it.effect("refuses an unknown destination, or one of another org, and saves nothing", () => {
		const { layer } = budgetHarness(trackedDbs, { days: [] })
		return Effect.gen(function* () {
			const alerts = yield* alertServices
			const budgets = yield* CostBudgetsService
			const theirs = yield* createWebhookDestination(alerts, otherOrgId, userId)
			const unknown = AlertDestinationId.make("0b7f4f0e-51a5-4c6e-8f0e-6a7d2c9b1e3f")
			const notifying = (destinationId: AlertDestinationId) =>
				budgetInput({
					alerts: [
						{
							severity: "critical",
							percent: 100,
							basis: "actual",
							destinationIds: [destinationId],
						},
					],
				})

			const outcomes = yield* Effect.all([
				refusal(budgets.create(orgId, notifying(unknown), userId)),
				refusal(budgets.create(orgId, notifying(theirs.id), userId)),
			])

			assert.deepStrictEqual(Arr.dedupe(outcomes), ["@maple/http/errors/CostBudgetInvalidError"])
			assert.lengthOf(yield* budgets.list(tenantOf(orgId)), 0)
		}).pipe(Effect.provide(layer))
	})

	it.effect("refuses a name another budget or another alert rule already has", () => {
		const { layer } = budgetHarness(trackedDbs, { days: [] })
		return Effect.gen(function* () {
			const alerts = yield* alertServices
			const budgets = yield* CostBudgetsService
			const destination = yield* createWebhookDestination(alerts, orgId, userId)
			const rule = yield* createErrorRateRule(alerts, orgId, userId, destination.id)
			const first = yield* budgets.create(orgId, budgetInput({ name: "First" }), userId)
			const second = yield* budgets.create(orgId, budgetInput({ name: "Second" }), userId)

			const outcomes = yield* Effect.all([
				refusal(budgets.create(orgId, budgetInput({ name: "First" }), userId)),
				refusal(budgets.create(orgId, budgetInput({ name: rule.name }), userId)),
				refusal(budgets.update(orgId, second.id, { name: first.name }, userId)),
			])

			assert.deepStrictEqual(Arr.dedupe(outcomes), ["@maple/http/errors/CostBudgetInvalidError"])
			// Another org's names are its own.
			assert.strictEqual(
				(yield* budgets.create(otherOrgId, budgetInput({ name: "First" }), userId)).name,
				"First",
			)
		}).pipe(Effect.provide(layer))
	})

	it.effect("caps an org's budgets and leaves another org's room alone", () => {
		const { layer } = budgetHarness(trackedDbs, { days: [] })
		return Effect.gen(function* () {
			const budgets = yield* CostBudgetsService
			yield* Effect.forEach(Arr.range(1, MAX_COST_BUDGETS_PER_ORG), (index) =>
				budgets.create(orgId, budgetInput({ name: `Budget ${index}` }), userId),
			)

			assert.strictEqual(
				yield* refusal(budgets.create(orgId, budgetInput({ name: "One too many" }), userId)),
				"@maple/http/errors/CostBudgetInvalidError",
			)
			assert.strictEqual(
				(yield* budgets.create(otherOrgId, budgetInput(), userId)).name,
				"AWS production",
			)
		}).pipe(Effect.provide(layer))
	})

	it.effect("removes the rule with its state and incidents, open ones included", () => {
		const { layer, testDb } = budgetHarness(trackedDbs, { days: [{ day: "2026-11-15", cost: 1500 }] })
		return Effect.gen(function* () {
			yield* TestClock.setTime(NOW)
			yield* connectCostSource(testDb, orgId)
			const alerts = yield* alertServices
			const budgets = yield* CostBudgetsService
			const created = yield* budgets.create(orgId, budgetInput(), userId)
			yield* alerts.runSchedulerTick()
			assert.deepStrictEqual(
				Arr.map((yield* alerts.listIncidents(orgId)).incidents, (incident) => [
					incident.ruleId,
					incident.status,
				]),
				[[created.id, "open"]],
			)

			assert.strictEqual(yield* budgets.remove(orgId, created.id), created.id)

			const left = yield* Effect.promise(() =>
				queryFirstRow<{ rules: number; incidents: number; states: number }>(
					testDb,
					`select (select count(*)::int from alert_rules where id = $1) as rules,
					        (select count(*)::int from alert_incidents where rule_id = $1) as incidents,
					        (select count(*)::int from alert_rule_states where rule_id = $1) as states`,
					[created.id],
				),
			)
			assert.deepStrictEqual(left, { rules: 0, incidents: 0, states: 0 })
		}).pipe(Effect.provide(layer))
	})

	it.effect("answers not found for an id that is not one of the org's budgets", () => {
		const { layer } = budgetHarness(trackedDbs, { days: [] })
		return Effect.gen(function* () {
			const alerts = yield* alertServices
			const budgets = yield* CostBudgetsService
			const destination = yield* createWebhookDestination(alerts, orgId, userId)
			// Another kind of rule is edited and deleted through its own owner, never from here.
			const rule = yield* createErrorRateRule(alerts, orgId, userId, destination.id)
			const theirs = yield* budgets.create(otherOrgId, budgetInput(), userId)

			const outcomes = yield* Effect.all([
				refusal(budgets.get(orgId, theirs.id)),
				refusal(budgets.update(orgId, theirs.id, { amount: 9 }, userId)),
				refusal(budgets.remove(orgId, theirs.id)),
				refusal(budgets.update(orgId, rule.id, { amount: 9 }, userId)),
				refusal(budgets.remove(orgId, rule.id)),
			])

			assert.deepStrictEqual(Arr.dedupe(outcomes), ["@maple/http/errors/CostBudgetNotFoundError"])
			assert.lengthOf((yield* alerts.listRules(orgId)).rules, 1)
			assert.strictEqual((yield* budgets.get(otherOrgId, theirs.id)).amount, 1000)
		}).pipe(Effect.provide(layer))
	})

	it.effect(
		"the generic rule APIs refuse to create, edit or delete a budget's rule and do not list it",
		() => {
			const { layer } = budgetHarness(trackedDbs, { days: [] })
			return Effect.gen(function* () {
				const alerts = yield* alertServices
				const budgets = yield* CostBudgetsService
				const created = yield* budgets.create(orgId, budgetInput(), userId)
				const request = new AlertRuleUpsertRequest({
					name: "Sneaky budget",
					severity: "critical",
					signalType: "cost_budget",
					comparator: "gte",
					threshold: 1,
					windowMinutes: 5,
				})

				assert.lengthOf((yield* alerts.listRules(orgId)).rules, 0)
				const refusedCreate = yield* alerts
					.createRule(orgId, userId, adminRoles, request)
					.pipe(Effect.flip)
				const refusedEdit = yield* alerts
					.updateRule(orgId, userId, adminRoles, created.id, request)
					.pipe(Effect.flip)
				const refusedDelete = yield* alerts
					.deleteRule(orgId, adminRoles, created.id)
					.pipe(Effect.flip)

				assert.deepStrictEqual(
					[refusedCreate._tag, refusedEdit._tag, refusedDelete._tag],
					[
						"@maple/http/errors/AlertValidationError",
						"@maple/http/errors/AlertValidationError",
						"@maple/http/errors/AlertRuleNotFoundError",
					],
				)
				// The refusal says where a budget is managed instead.
				assert.include(refusedEdit.message, "Cost page")
				assert.strictEqual((yield* budgets.get(orgId, created.id)).name, "AWS production")
			}).pipe(Effect.provide(layer))
		},
	)
})
