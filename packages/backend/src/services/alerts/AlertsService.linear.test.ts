import { afterEach, assert, describe, it } from "@effect/vitest"
import { ConfigProvider, Duration, Effect, Layer, Schema, Array as Arr, Option } from "effect"
import { TestClock } from "effect/testing"
import { FetchHttpClient } from "effect/http"
import { EnvTestLive } from "@maple/backend/testing/env-test-support"
import { cleanupTestDbs, createTestDb, queryFirstRow, type TestDb } from "@maple/backend/testing/test-pglite"
import { LinearOAuthService } from "@maple/backend/services/auth/LinearOAuthService"
import * as VendorFake from "@maple/backend/testing/vendor-fake"
import { LinearIssueTracker } from "./LinearIssueTracker"
import {
	DEFAULT_CLOCK_EPOCH_MS,
	adminRoles,
	asOrgId,
	asUserId,
	createErrorRateRule,
	makeLayer,
	makeWarehouseStub,
	tracesRow,
	alertServices,
} from "./alerts-service-test-support"
import { LinearAlertDestinationConfig } from "@maple/domain/http"

const GraphqlRequest = Schema.fromJsonString(
	Schema.Struct({
		operationName: Schema.String,
		variables: Schema.Record(Schema.String, Schema.Unknown),
	}),
)
const decodeGraphqlRequest = Schema.decodeUnknownSync(GraphqlRequest)

/** Linear's token endpoint, answering every exchange with one token. */
const tokenRoute = (refreshToken: string): VendorFake.VendorFakeRoute => ({
	path: "/oauth/token",
	respond: () =>
		VendorFake.json({
			access_token: "lin-access",
			refresh_token: refreshToken,
			expires_in: 86399,
			scope: "read,write",
		}),
})

const trackedDbs: TestDb[] = []

afterEach(() => cleanupTestDbs(trackedDbs))

interface Operation {
	readonly name: string
	readonly variables: { readonly input?: Record<string, unknown> } & Record<string, unknown>
}

/** Linear over HTTP: OAuth token exchange plus the GraphQL operations Maple sends, kept in memory. */
const linearServer = () => {
	const operations: Operation[] = []
	const issues = new Map<string, { id: string; identifier: string; url: string }>()
	const graphql = (request: VendorFake.VendorFakeRequest) => {
		const body = decodeGraphqlRequest(request.body)
		const operation: Operation = { name: body.operationName, variables: body.variables }
		operations.push(operation)
		switch (operation.name) {
			case "MapleConnectedWorkspace":
				return VendorFake.json({ data: { organization: { id: "lin_org", name: "Acme" } } })
			case "MapleTeamLookup": {
				const known = operation.variables.id === "team_1"
				return known
					? VendorFake.json({ data: { team: { id: "team_1", key: "ENG", name: "Engineering" } } })
					: VendorFake.json({
							data: null,
							errors: [
								{
									message: "Could not find referenced Team.",
									extensions: { code: "INPUT_ERROR" },
								},
							],
						})
			}
			case "MapleTeam":
				return VendorFake.json({
					data: {
						team: {
							id: "team_1",
							key: "ENG",
							name: "Engineering",
							triageEnabled: true,
							triageIssueState: { id: "state_triage" },
							states: { nodes: [{ id: "state_todo", position: 1 }] },
						},
					},
				})
			case "MapleTeams":
				return VendorFake.json({
					data: { teams: { nodes: [{ id: "team_1", key: "ENG", name: "Engineering" }] } },
				})
			case "MapleIssue": {
				const issue = issues.get(String(operation.variables.id))
				return issue === undefined
					? VendorFake.json({
							data: null,
							errors: [
								{
									message: "Could not find referenced Issue.",
									extensions: { code: "INPUT_ERROR" },
								},
							],
						})
					: VendorFake.json({
							data: { issue: { ...issue, state: { type: "triage" }, team: { id: "team_1" } } },
						})
			}
			case "MapleIssueCreate": {
				const id = String(operation.variables.input?.id)
				const issue = { id, identifier: "ENG-1", url: "https://linear.app/acme/issue/ENG-1" }
				issues.set(id, issue)
				return VendorFake.json({ data: { issueCreate: { success: true, issue } } })
			}
			default:
				return VendorFake.json({ data: { ok: { success: true } } })
		}
	}
	const fake = VendorFake.make({
		routes: [
			tokenRoute("lin-refresh"),
			{ path: "/graphql", respond: graphql },
			{ respond: () => VendorFake.text("ok") },
		],
	})
	return { fetch: fake.fetch, operations }
}

const oauthConfig = ConfigProvider.layer(
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
)

/** The real OAuth service and issue tracker, against the same database and key as the alerts layer. */
const linearLayers = (testDb: TestDb, fetch: typeof globalThis.fetch) =>
	Layer.mergeAll(
		LinearOAuthService.layer,
		Layer.effect(LinearIssueTracker, LinearIssueTracker.make).pipe(
			Layer.provide(FetchHttpClient.layer),
			Layer.provide(LinearOAuthService.layer),
		),
	).pipe(
		Layer.provide(testDb.layer),
		Layer.provide(EnvTestLive),
		Layer.provide(oauthConfig),
		Layer.provideMerge(Layer.succeed(FetchHttpClient.Fetch, fetch)),
	)

const connectLinear = (testDb: TestDb, fetch: typeof globalThis.fetch, orgId: ReturnType<typeof asOrgId>) =>
	Effect.gen(function* () {
		const service = yield* LinearOAuthService
		const userId = asUserId("user_linear")
		const { state } = yield* service.startConnect(orgId, userId, { callbackUrl: "https://api.test/cb" })
		yield* service.completeConnect("code", state, { orgId, userId })
	}).pipe(Effect.provide(linearLayers(testDb, fetch)))

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
			const alerts = yield* alertServices
			const destination = yield* alerts.createDestination(
				orgId,
				asUserId("user_linear"),
				adminRoles,
				new LinearAlertDestinationConfig({
					type: "linear",
					name: "Engineering triage",
					teamId: "team_1",
				}),
			)
			assert.strictEqual(destination.summary, "Linear · Engineering")
			assert.strictEqual(destination.channelLabel, "ENG")
			assert.strictEqual(destination.linearTeamId, "team_1")

			const tested = yield* alerts.testDestination(
				orgId,
				asUserId("user_linear"),
				adminRoles,
				destination.id,
			)
			assert.strictEqual(tested.message, "Linear team Engineering (ENG) is reachable")
			assert.notInclude(
				Arr.map(linear.operations, (operation) => operation.name),
				"MapleIssueCreate",
			)

			const error = yield* alerts
				.createDestination(
					orgId,
					asUserId("user_linear"),
					adminRoles,
					new LinearAlertDestinationConfig({
						type: "linear",
						name: "Elsewhere",
						teamId: "team_unknown",
					}),
				)
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
			const alerts = yield* alertServices
			const destination = yield* alerts.createDestination(
				orgId,
				userId,
				adminRoles,
				new LinearAlertDestinationConfig({
					type: "linear",
					name: "Engineering triage",
					teamId: "team_1",
				}),
			)
			yield* createErrorRateRule(alerts, orgId, userId, destination.id)

			yield* alerts.runSchedulerTick()
			yield* TestClock.adjust(Duration.minutes(1))
			yield* alerts.runSchedulerTick()

			const incidents = yield* alerts.listIncidents(orgId)
			assert.lengthOf(incidents.incidents, 1)
			const create = Option.getOrUndefined(
				Arr.findFirst(linear.operations, (operation) => operation.name === "MapleIssueCreate"),
			)
			assert.strictEqual(create?.variables.input?.teamId, "team_1")
			const thread = yield* Effect.promise(() =>
				queryFirstRow<{ linear_identifier: string; incident_id: string }>(
					testDb,
					"SELECT linear_identifier, incident_id FROM alert_linear_issues WHERE org_id = $1",
					[orgId],
				),
			)
			assert.strictEqual(thread?.linear_identifier, "ENG-1")
			assert.strictEqual(thread?.incident_id, incidents.incidents[0].id)

			state.tracesAggregateRows = [healthy]
			yield* TestClock.adjust(Duration.minutes(1))
			yield* alerts.runSchedulerTick()
			yield* TestClock.adjust(Duration.minutes(1))
			yield* alerts.runSchedulerTick()

			const comments = Arr.filter(linear.operations, (operation) => operation.name === "MapleComment")
			assert.lengthOf(comments, 1)
			assert.include(String(comments[0].variables.input?.body), "Resolved")
			assert.lengthOf(
				Arr.filter(linear.operations, (operation) => operation.name === "MapleIssueCreate"),
				1,
			)
		}).pipe(Effect.provide(makeLayer(testDb, makeWarehouseStub(state), { fetch: linear.fetch })))
	})

	it.effect("fails terminally when Linear no longer has the team or refuses access", () => {
		const testDb = createTestDb(trackedDbs)
		const orgId = asOrgId("org_linear_gone")
		const answers = {
			MapleIssueCreate: {
				data: null,
				errors: [{ message: "Could not find referenced Team.", extensions: { code: "INPUT_ERROR" } }],
			},
			MapleComment: {
				data: null,
				errors: [{ message: "Forbidden", extensions: { code: "FORBIDDEN" } }],
			},
		}
		const { fetch } = VendorFake.make({
			routes: [
				tokenRoute("r"),
				{
					respond: (request) => {
						const name = decodeGraphqlRequest(request.body).operationName
						return VendorFake.json(
							name === "MapleIssueCreate" || name === "MapleComment"
								? answers[name]
								: { data: { organization: { id: "lin_org", name: "Acme" } } },
						)
					},
				},
			],
		})
		const operation = (name: string) => ({ name, document: "", variables: {} })
		return Effect.gen(function* () {
			yield* connectLinear(testDb, fetch, orgId)
			const tracker = yield* LinearIssueTracker
			const missing = yield* tracker
				.request(orgId, operation("MapleIssueCreate"), Schema.Unknown)
				.pipe(Effect.flip)
			assert.strictEqual(missing._tag, "@maple/http/errors/AlertDeliveryTargetMissingError")
			const forbidden = yield* tracker
				.request(orgId, operation("MapleComment"), Schema.Unknown)
				.pipe(Effect.flip)
			assert.strictEqual(forbidden._tag, "@maple/http/errors/AlertDeliveryTargetMissingError")
			// A comment tolerates a missing issue, but a refusal is never recorded as delivered.
			const refused = yield* tracker
				.request(orgId, operation("MapleComment"), Schema.Unknown, {
					missingIsNull: true,
					duplicateIsSuccess: true,
				})
				.pipe(Effect.flip)
			assert.strictEqual(refused._tag, "@maple/http/errors/AlertDeliveryTargetMissingError")
			const read = yield* tracker.request(orgId, operation("MapleIssueCreate"), Schema.Unknown, {
				missingIsNull: true,
			})
			assert.isNull(read)
		}).pipe(Effect.provide(linearLayers(testDb, fetch)))
	})
})
