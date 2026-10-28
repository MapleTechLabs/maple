import { afterEach, assert, describe, it } from "@effect/vitest"
import { ConfigProvider, Duration, Effect, Layer } from "effect"
import { TestClock } from "effect/testing"
import { FetchHttpClient } from "effect/http"
import { Env } from "@maple/backend/platform/Env"
import { cleanupTestDbs, createTestDb, queryFirstRow, type TestDb } from "@maple/backend/platform/test-pglite"
import { LinearOAuthService } from "@maple/backend/services/auth/LinearOAuthService"
import { AlertsService } from "./AlertsService"
import {
	DEFAULT_CLOCK_EPOCH_MS,
	adminRoles,
	asOrgId,
	asUserId,
	createErrorRateRule,
	makeLayer,
	makeWarehouseStub,
	tracesRow,
} from "./alerts-service-test-support"

const trackedDbs: TestDb[] = []

afterEach(() => cleanupTestDbs(trackedDbs))

const json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

interface Operation {
	readonly name: string
	readonly variables: { readonly input?: Record<string, unknown> } & Record<string, unknown>
}

/** Linear over HTTP: OAuth token exchange plus the GraphQL operations Maple sends, kept in memory. */
const linearServer = () => {
	const operations: Operation[] = []
	const issues = new Map<string, { id: string; identifier: string; url: string }>()
	const fetch: typeof globalThis.fetch = async (input, init) => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
		if (url === "https://api.linear.app/oauth/token") {
			return json({
				access_token: "lin-access",
				refresh_token: "lin-refresh",
				expires_in: 86399,
				scope: "read,write",
			})
		}
		if (url !== "https://api.linear.app/graphql") return new Response("ok", { status: 200 })
		const body = JSON.parse(String(init?.body))
		const operation: Operation = { name: body.operationName, variables: body.variables }
		operations.push(operation)
		switch (operation.name) {
			case "MapleConnectedWorkspace":
				return json({ data: { organization: { id: "lin_org", name: "Acme" } } })
			case "MapleTeams":
				return json({
					data: { teams: { nodes: [{ id: "team_1", key: "ENG", name: "Engineering" }] } },
				})
			case "MapleIssue": {
				const issue = issues.get(String(operation.variables.id))
				return issue === undefined
					? json({
							data: null,
							errors: [
								{ message: "Entity not found: Issue", extensions: { code: "INPUT_ERROR" } },
							],
						})
					: json({ data: { issue: { ...issue, state: { type: "triage" } } } })
			}
			case "MapleIssueCreate": {
				const id = String(operation.variables.input?.id)
				const issue = { id, identifier: "ENG-1", url: "https://linear.app/acme/issue/ENG-1" }
				issues.set(id, issue)
				return json({ data: { issueCreate: { success: true, issue } } })
			}
			default:
				return json({ data: { ok: { success: true } } })
		}
	}
	return { fetch, operations }
}

/** Connects the org through the real OAuth service, against the same database and key as the alerts layer. */
const connectLinear = (testDb: TestDb, fetch: typeof globalThis.fetch, orgId: ReturnType<typeof asOrgId>) =>
	Effect.gen(function* () {
		const service = yield* LinearOAuthService
		const userId = asUserId("user_linear")
		const { state } = yield* service.startConnect(orgId, userId, { callbackUrl: "https://api.test/cb" })
		yield* service.completeConnect("code", state, { orgId, userId })
	}).pipe(
		Effect.provide(
			LinearOAuthService.layer.pipe(
				Layer.provide(testDb.layer),
				Layer.provide(Env.layer),
				Layer.provide(
					ConfigProvider.layer(
						ConfigProvider.fromUnknown({
							PORT: "3472",
							TINYBIRD_HOST: "https://maple-managed.tinybird.co",
							TINYBIRD_TOKEN: "managed-token",
							MAPLE_AUTH_MODE: "self_hosted",
							MAPLE_ROOT_PASSWORD: "test-root-password",
							MAPLE_DEFAULT_ORG_ID: "default",
							MAPLE_INGEST_KEY_ENCRYPTION_KEY: Buffer.alloc(32, 5).toString("base64"),
							MAPLE_INGEST_KEY_LOOKUP_HMAC_KEY: "lookup-key",
							MAPLE_INGEST_PUBLIC_URL: "http://127.0.0.1:3474",
							LINEAR_OAUTH_CLIENT_ID: "lin-client-id",
							LINEAR_OAUTH_CLIENT_SECRET: "lin-client-secret",
						}),
					),
				),
				Layer.provideMerge(Layer.succeed(FetchHttpClient.Fetch, fetch)),
			),
		),
	)

const breaching = tracesRow({
	count: 200,
	avgDuration: 40,
	p50Duration: 20,
	p95Duration: 120,
	p99Duration: 240,
	errorRate: 10,
	satisfiedCount: 180,
	toleratingCount: 10,
	apdexScore: 0.925,
})
const healthy = tracesRow({
	count: 200,
	avgDuration: 40,
	p50Duration: 20,
	p95Duration: 120,
	p99Duration: 240,
	errorRate: 0,
	satisfiedCount: 190,
	toleratingCount: 10,
	apdexScore: 0.975,
})

describe("AlertsService with a Linear destination", () => {
	it.effect("reads the team from Linear when the destination is created", () => {
		const testDb = createTestDb(trackedDbs)
		const linear = linearServer()
		const orgId = asOrgId("org_linear_create")
		return Effect.gen(function* () {
			yield* connectLinear(testDb, linear.fetch, orgId)
			const alerts = yield* AlertsService
			const destination = yield* alerts.createDestination(orgId, asUserId("user_linear"), adminRoles, {
				type: "linear",
				name: "Engineering triage",
				teamId: "team_1",
			})
			assert.strictEqual(destination.summary, "Linear · Engineering")
			assert.strictEqual(destination.channelLabel, "ENG")
			assert.strictEqual(destination.linearTeamId, "team_1")

			const error = yield* alerts
				.createDestination(orgId, asUserId("user_linear"), adminRoles, {
					type: "linear",
					name: "Elsewhere",
					teamId: "team_unknown",
				})
				.pipe(Effect.flip)
			assert.include(error.message, "not in the connected Linear workspace")
		}).pipe(
			Effect.provide(
				makeLayer(testDb, makeWarehouseStub({ tracesAggregateRows: [] }), { fetch: linear.fetch }),
			),
		)
	})

	it.effect("opens one issue when an incident fires and comments when it resolves", () => {
		const testDb = createTestDb(trackedDbs)
		const linear = linearServer()
		const state = { tracesAggregateRows: [breaching] }
		const orgId = asOrgId("org_linear_incident")
		const userId = asUserId("user_linear")
		return Effect.gen(function* () {
			yield* TestClock.setTime(DEFAULT_CLOCK_EPOCH_MS)
			yield* connectLinear(testDb, linear.fetch, orgId)
			const alerts = yield* AlertsService
			const destination = yield* alerts.createDestination(orgId, userId, adminRoles, {
				type: "linear",
				name: "Engineering triage",
				teamId: "team_1",
			})
			yield* createErrorRateRule(alerts, orgId, userId, destination.id)

			yield* alerts.runSchedulerTick()
			yield* TestClock.adjust(Duration.minutes(1))
			yield* alerts.runSchedulerTick()

			const incidents = yield* alerts.listIncidents(orgId)
			assert.lengthOf(incidents.incidents, 1)
			const create = linear.operations.find((operation) => operation.name === "MapleIssueCreate")
			assert.strictEqual(create?.variables.input?.teamId, "team_1")
			const thread = yield* Effect.promise(() =>
				queryFirstRow<{ linear_identifier: string; incident_id: string }>(
					testDb,
					"SELECT linear_identifier, incident_id FROM alert_linear_issues WHERE org_id = $1",
					[orgId],
				),
			)
			assert.strictEqual(thread?.linear_identifier, "ENG-1")
			assert.strictEqual(thread?.incident_id, incidents.incidents[0]!.id)

			state.tracesAggregateRows = [healthy]
			yield* TestClock.adjust(Duration.minutes(1))
			yield* alerts.runSchedulerTick()
			yield* TestClock.adjust(Duration.minutes(1))
			yield* alerts.runSchedulerTick()

			const comments = linear.operations.filter((operation) => operation.name === "MapleComment")
			assert.lengthOf(comments, 1)
			assert.include(String(comments[0]!.variables.input?.body), "Resolved")
			assert.lengthOf(
				linear.operations.filter((operation) => operation.name === "MapleIssueCreate"),
				1,
			)
		}).pipe(Effect.provide(makeLayer(testDb, makeWarehouseStub(state), { fetch: linear.fetch })))
	})
})
