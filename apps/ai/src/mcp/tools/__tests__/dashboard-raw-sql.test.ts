import { afterEach, describe, expect, it } from "@effect/vitest"
import * as Policy from "@maple/domain/policy"
import { ConfigProvider, Context, Effect, Layer, Result, Schema } from "effect"
import { OrgId, PortableDashboardDocument, RoleName, UserId } from "@maple/domain/http"
import { DashboardPersistenceService } from "@maple/backend/services/dashboards/DashboardPersistenceService"
import { Env } from "@maple/backend/platform/Env"
import { cleanupTestDbs, createTestDb, type TestDb } from "@maple/backend/testing/test-pglite"
import { CurrentMcpTenant } from "../../tenant"
import { executeRegisteredMcpToolUnscoped } from "../registry"

const createdDbs: TestDb[] = []
afterEach(() => cleanupTestDbs(createdDbs))

const config = ConfigProvider.layer(
	ConfigProvider.fromUnknown({
		TINYBIRD_HOST: "https://api.tinybird.co",
		TINYBIRD_TOKEN: "test-token",
		MAPLE_AUTH_MODE: "self_hosted",
		MAPLE_ROOT_PASSWORD: "test-root-password",
		MAPLE_DEFAULT_ORG_ID: "default",
		MAPLE_INGEST_KEY_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64"),
		MAPLE_INGEST_KEY_LOOKUP_HMAC_KEY: "maple-test-lookup-secret",
	}),
)

const SQL = "SELECT count() AS value FROM traces WHERE $__orgFilter AND $__timeFilter(Timestamp)"

/** A custom role that builds dashboards, with or without raw SQL. */
const layerFor = (permissions: Policy.Grants) =>
	Layer.mergeAll(
		DashboardPersistenceService.layer.pipe(
			Layer.provide(createTestDb(createdDbs).layer),
			Layer.provide(Env.layer),
			Layer.provide(config),
		),
		Layer.succeed(CurrentMcpTenant, {
			orgId: Schema.decodeSync(OrgId)("org_raw_sql"),
			userId: Schema.decodeSync(UserId)("user_raw_sql"),
			roles: [Schema.decodeSync(RoleName)("org:custom")],
			permissions,
			authMode: "clerk",
		}),
	)

// The registry's requirements name every tool's services; these tools reach only the ones above.
const withoutUnreachedServices = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E> =>
	Effect.provide(effect, Context.makeUnsafe<R>(new Map()))

const call = (name: string, params: unknown) =>
	executeRegisteredMcpToolUnscoped(name, params, "mcp").pipe(Effect.result, withoutUnreachedServices)

const sqlBoard = (name: string) =>
	new PortableDashboardDocument({
		name,
		timeRange: { type: "relative", value: "12h" },
		widgets: [
			{
				id: "w-sql",
				visualization: "stat",
				dataSource: { kind: "raw_sql", sql: SQL },
				display: {},
				layout: { x: 0, y: 0, w: 3, h: 4 },
			},
		],
	})

const DASHBOARDS_ONLY: Policy.Grants = ["telemetry:read", "dashboards:edit"]
const WITH_SQL: Policy.Grants = [...DASHBOARDS_ONLY, "query:sql"]

const refusal = (result: Result.Result<unknown, { readonly _tag: string; readonly message: string }>) =>
	Result.isFailure(result) ? { _tag: result.failure._tag, message: result.failure.message } : "saved"

const denied = {
	_tag: "@maple/mcp/errors/McpAuthInvalidError",
	message: Policy.denialFor("query:sql").message,
}

describe("raw SQL on dashboards over MCP", () => {
	it.effect("refuses a new dashboard with a raw SQL widget without query:sql", () =>
		Effect.gen(function* () {
			const result = yield* call("create_dashboard", {
				name: "SQL",
				dashboard_json: JSON.stringify(sqlBoard("SQL")),
				validate: false,
			})
			expect(refusal(result)).toEqual(denied)
		}).pipe(Effect.provide(layerFor(DASHBOARDS_ONLY))),
	)

	it.effect("saves it with query:sql", () =>
		Effect.gen(function* () {
			const result = yield* call("create_dashboard", {
				name: "SQL",
				dashboard_json: JSON.stringify(sqlBoard("SQL")),
				validate: false,
			})
			expect(refusal(result)).toBe("saved")
		}).pipe(Effect.provide(layerFor(WITH_SQL))),
	)

	it.effect(
		"refuses adding a raw SQL widget without query:sql, and keeps the board's own SQL on other edits",
		() =>
			Effect.gen(function* () {
				const persistence = yield* DashboardPersistenceService
				const tenant = yield* CurrentMcpTenant
				const { document } = yield* persistence.create(
					tenant.orgId,
					tenant.userId,
					sqlBoard("Existing"),
				)

				const added = yield* call("add_dashboard_widget", {
					dashboard_id: document.id,
					panel_type: "stat",
					title: "Count",
					sql: SQL.replace("count()", "uniq(TraceId)"),
				})
				expect(refusal(added)).toEqual(denied)

				const renamed = yield* call("update_dashboard", {
					dashboard_id: document.id,
					name: "Renamed",
				})
				expect(refusal(renamed)).toBe("saved")
			}).pipe(Effect.provide(layerFor(DASHBOARDS_ONLY))),
	)

	it.effect("refuses to inspect a raw SQL widget's data without query:sql, the stored SQL unrun", () =>
		Effect.gen(function* () {
			const persistence = yield* DashboardPersistenceService
			const tenant = yield* CurrentMcpTenant
			const { document } = yield* persistence.create(tenant.orgId, tenant.userId, sqlBoard("Existing"))

			const inspected = yield* call("inspect_chart_data", {
				dashboard_id: document.id,
				widget_id: "w-sql",
			})
			expect(refusal(inspected)).toEqual(denied)
		}).pipe(Effect.provide(layerFor(["telemetry:read"]))),
	)
})
