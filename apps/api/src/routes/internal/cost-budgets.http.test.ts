import * as Policy from "@maple/domain/policy"
import { afterEach, describe, expect, it } from "vitest"
import {
	ApiSchemaErrors,
	ApiUnexpectedErrors,
	CostBudget,
	CostBudgetListResponse,
	CostBudgetsApiGroup,
	CurrentTenant,
	OrgId,
	RoleName,
	UserId,
} from "@maple/domain/http"
import { Context, Effect, Layer, Order, Schema, Array as Arr, String as Str } from "effect"
import { encodePublicId, PublicIdPrefixes } from "@maple/domain/http/v2"
import { HttpRouter } from "effect/http"
import { HttpApi, HttpApiBuilder } from "effect/http-api"
import { ApiErrorBoundaryLive } from "@maple/backend/http/error-boundary"
import { AuditLogService, makeMemoryAuditLog } from "@maple/backend/services/audit/AuditLogService"
import { CostBudgetSource } from "@maple/backend/services/cost/CostBudgetSource"
import { CostBudgetsService } from "@maple/backend/services/cost/CostBudgetsService"
import { cleanupTestDbs, createTestDb, type TestDb } from "@maple/backend/testing/test-pglite"
import { costBudgetPeriodWindow, costBudgetProgress } from "@maple/domain/cost-budget"
import { HttpCostBudgetsLive } from "./cost-budgets.http"

class CostBudgetsOnlyApi extends HttpApi.make("MapleInternalApi")
	.add(CostBudgetsApiGroup)
	.middleware(ApiSchemaErrors)
	.middleware(ApiUnexpectedErrors) {}

const ORG_ID = Schema.decodeSync(OrgId)("org_budget_route")
const USER_ID = Schema.decodeSync(UserId)("user_budget_route")

const asRole = Schema.decodeSync(RoleName)
const asBudget = Schema.decodeUnknownSync(CostBudget)
const asBudgets = Schema.decodeUnknownSync(CostBudgetListResponse)
const asFailure = Schema.decodeUnknownSync(Schema.Struct({ _tag: Schema.String }))

const trackedDbs: TestDb[] = []
afterEach(() => cleanupTestDbs(trackedDbs))

/** What every budget has spent, on the first day of its period, wherever the clock stands. */
const SPENT = 600

/**
 * The route over the real budgets service and an embedded database (`testDb`, shared to read
 * back as another caller), with spend answered from `SPENT` instead of the warehouse.
 */
const makeHarness = (roles: ReadonlyArray<string>, testDb: TestDb = createTestDb(trackedDbs)) => {
	const auditLog = makeMemoryAuditLog()
	const source = Layer.succeed(CostBudgetSource, {
		progress: (_tenant, budgets, nowMs) =>
			Effect.succeed(
				Arr.map(
					budgets,
					(budget) =>
						[
							budget,
							costBudgetProgress(budget, nowMs, [
								{ day: costBudgetPeriodWindow(budget.period, nowMs).startDay, cost: SPENT },
							]),
						] as const,
				),
			),
	})
	const services = Layer.mergeAll(
		Layer.effect(CostBudgetsService, CostBudgetsService.make).pipe(
			Layer.provide(Layer.mergeAll(source, testDb.layer)),
		),
		Layer.succeed(AuditLogService, auditLog),
		Layer.succeed(
			CurrentTenant.SessionAuthorization,
			CurrentTenant.SessionAuthorization.of({
				bearer: (httpEffect) =>
					CurrentTenant.provide(
						new CurrentTenant.TenantSchema({
							orgId: ORG_ID,
							userId: USER_ID,
							roles: Arr.map(roles, (role) => asRole(role)),
							permissions: Policy.grantsOf(Arr.map(roles, (role) => asRole(role))),
							authMode: "clerk",
						}),
					)(httpEffect),
			}),
		),
	)
	const routes = HttpApiBuilder.layer(CostBudgetsOnlyApi).pipe(
		Layer.provide(HttpCostBudgetsLive),
		Layer.provide(ApiErrorBoundaryLive),
		Layer.provide(services),
	)
	const { handler, dispose } = HttpRouter.toWebHandler(routes, { disableLogger: true })

	/** A call to a budgets endpoint: `path` is what follows `/budgets`. */
	const budgets = async (method: string, path = "", body?: unknown) => {
		const response = await handler(
			new Request(`http://maple.test/internal/cost/budgets${path}`, {
				method,
				headers: {
					authorization: "Bearer test-token",
					...(body === undefined ? undefined : { "content-type": "application/json" }),
				},
				...(body === undefined ? undefined : { body: JSON.stringify(body) }),
			}),
			Context.empty() as never,
		)
		return { status: response.status, body: await response.json() }
	}

	/** What Maple's own audit log recorded: each entry's action, resource and changed fields. */
	const audited = async () =>
		Arr.map(await Effect.runPromise(auditLog.list(ORG_ID, { limit: 50, offset: 0 })), (entry) => ({
			action: entry.action,
			resourceId: entry.resourceId,
			changedFields: entry.changedFields,
		}))

	return { budgets, audited, dispose }
}

const ENGINEER = ["org:engineer"]
const UNKNOWN_ID = "00000000-0000-4000-8000-000000000000"

const budgetBody = (overrides: Record<string, unknown> = {}) => ({
	name: "AWS production",
	amount: 1000,
	currency: "USD",
	period: "month",
	filters: { provider: ["aws"] },
	alerts: [{ severity: "critical", percent: 100, basis: "actual", destinationIds: [] }],
	...overrides,
})

describe("/internal/cost/budgets", () => {
	it("lets an engineer create, list, edit and delete a budget, and audits each change", async () => {
		const harness = makeHarness(ENGINEER)
		try {
			const created = await harness.budgets("POST", "", budgetBody({ name: "  AWS production  " }))
			expect(created.status).toBe(200)
			const budget = asBudget(created.body)
			expect(budget).toMatchObject({
				name: "AWS production",
				enabled: true,
				amount: 1000,
				currency: "USD",
				period: "month",
				metric: "billed",
				filters: { provider: ["aws"] },
				alerts: [{ severity: "critical", percent: 100, basis: "actual", destinationIds: [] }],
			})

			const listed = asBudgets((await harness.budgets("GET")).body).budgets
			expect(listed).toMatchObject([{ id: budget.id, progress: { spent: SPENT, percent: 60 } }])
			expect(asBudget((await harness.budgets("GET", `/${budget.id}`)).body)).toEqual(budget)

			const edited = await harness.budgets("PATCH", `/${budget.id}`, { amount: 500, enabled: false })
			expect(edited.status).toBe(200)
			expect(asBudget(edited.body)).toMatchObject({ id: budget.id, amount: 500, enabled: false })

			expect(await harness.budgets("DELETE", `/${budget.id}`)).toEqual({
				status: 200,
				body: { id: budget.id },
			})
			expect(asBudgets((await harness.budgets("GET")).body).budgets).toEqual([])

			// The audit log names a resource by its public id.
			const resourceId = encodePublicId(PublicIdPrefixes.alertRule, budget.id)
			expect(Arr.sortWith(await harness.audited(), (entry) => entry.action, Order.String)).toEqual([
				{ action: "alert_rule.created", resourceId, changedFields: null },
				{ action: "alert_rule.deleted", resourceId, changedFields: null },
				{ action: "alert_rule.updated", resourceId, changedFields: ["enabled", "amount"] },
			])
		} finally {
			await harness.dispose()
		}
	})

	// A budget is an alert rule: who cannot manage alerts reads budgets and writes none.
	it("lets members and analysts read, and refuses their writes without storing anything", async () => {
		const testDb = createTestDb(trackedDbs)
		const engineer = makeHarness(ENGINEER, testDb)
		const member = makeHarness(["org:member"], testDb)
		const analyst = makeHarness(["org:analyst"], testDb)
		try {
			const existing = asBudget((await engineer.budgets("POST", "", budgetBody())).body)

			const reads = [await member.budgets("GET"), await analyst.budgets("GET", `/${existing.id}`)]
			const writes = [
				await member.budgets("POST", "", budgetBody({ name: "Theirs" })),
				await member.budgets("PATCH", `/${existing.id}`, { amount: 9 }),
				await member.budgets("DELETE", `/${existing.id}`),
				await analyst.budgets("POST", "", budgetBody({ name: "Theirs" })),
			]

			expect(Arr.map(reads, (response) => response.status)).toEqual([200, 200])
			expect(Arr.map(writes, (response) => response.status)).toEqual([403, 403, 403, 403])
			expect(await member.audited()).toEqual([])
			expect(asBudget((await engineer.budgets("GET", `/${existing.id}`)).body)).toEqual(existing)
		} finally {
			await engineer.dispose()
			await member.dispose()
			await analyst.dispose()
		}
	})

	it("answers 400 for a budget outside its bounds, before anything is stored", async () => {
		const harness = makeHarness(ENGINEER)
		const alert = { severity: "critical", percent: 100, basis: "actual", destinationIds: [] }
		try {
			const responses = [
				await harness.budgets("POST", "", budgetBody({ name: "   " })),
				await harness.budgets("POST", "", budgetBody({ name: Str.repeat(121)("x") })),
				await harness.budgets("POST", "", budgetBody({ amount: 0 })),
				await harness.budgets("POST", "", budgetBody({ amount: -5 })),
				await harness.budgets("POST", "", budgetBody({ currency: "usd" })),
				await harness.budgets("POST", "", budgetBody({ period: "week" })),
				await harness.budgets("POST", "", budgetBody({ alerts: [] })),
				await harness.budgets("POST", "", budgetBody({ alerts: [{ ...alert, percent: 0 }] })),
				// Two alerts of one severity: the rule has one tier per severity.
				await harness.budgets("POST", "", budgetBody({ alerts: [alert, { ...alert, percent: 80 }] })),
			]

			expect(Arr.dedupe(Arr.map(responses, (response) => response.status))).toEqual([400])
			expect(asBudgets((await harness.budgets("GET")).body).budgets).toEqual([])
		} finally {
			await harness.dispose()
		}
	})

	it("answers 400 for an unknown destination and for a name already taken", async () => {
		const harness = makeHarness(ENGINEER)
		try {
			await harness.budgets("POST", "", budgetBody())
			const responses = [
				await harness.budgets(
					"POST",
					"",
					budgetBody({
						name: "Unknown destination",
						alerts: [
							{
								severity: "critical",
								percent: 100,
								basis: "actual",
								destinationIds: [UNKNOWN_ID],
							},
						],
					}),
				),
				await harness.budgets("POST", "", budgetBody()),
			]

			expect(
				Arr.map(responses, (response) => [response.status, asFailure(response.body)._tag]),
			).toEqual([
				[400, "@maple/http/errors/CostBudgetInvalidError"],
				[400, "@maple/http/errors/CostBudgetInvalidError"],
			])
		} finally {
			await harness.dispose()
		}
	})

	it("answers 404 for a budget that does not exist", async () => {
		const harness = makeHarness(ENGINEER)
		try {
			const responses = [
				await harness.budgets("GET", `/${UNKNOWN_ID}`),
				await harness.budgets("PATCH", `/${UNKNOWN_ID}`, { amount: 9 }),
				await harness.budgets("DELETE", `/${UNKNOWN_ID}`),
			]
			expect(Arr.map(responses, (response) => response.status)).toEqual([404, 404, 404])
			expect(await harness.audited()).toEqual([])
		} finally {
			await harness.dispose()
		}
	})
})
