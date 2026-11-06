import { afterEach, assert, describe, it } from "@effect/vitest"
import { ConfigProvider, Effect, Layer, Schema } from "effect"
import { OrgId, UserId } from "@maple/domain/http"
import { encodePublicId, PublicIdPrefixes } from "@maple/domain/http/v2"
import { Env } from "@maple/backend/platform/Env"
import { EdgeCacheServiceLive } from "@maple/backend/platform/CacheBackendLive"
import { cleanupTestDbs, createTestDb, executeSql, type TestDb } from "@maple/backend/platform/test-pglite"
import { AlertIncidentAckService } from "@maple/backend/services/alerts/AlertIncidentAckService"
import { CurrentMcpTenant } from "../lib/query-warehouse"
import { registerAcknowledgeAlertIncidentTool } from "./acknowledge-alert-incident"
import { renderToolDoc } from "../lib/tool-doc"
import { CurrentAuditActor } from "@maple/backend/services/auth/audit-actor"
import type { McpToolError, McpToolRegistrar } from "./types"
import type { McpToolRequirements } from "./runtime-requirements"
import { unimplementedMcpToolServices } from "../../../test/mcp/unimplemented-tool-services"

const trackedDbs: TestDb[] = []
afterEach(() => cleanupTestDbs(trackedDbs))

const ORG = "org_mcp_ack"
const OPEN = "00000000-0000-4000-8000-0000000000b1"
const RESOLVED = "00000000-0000-4000-8000-0000000000b2"

type Invoke = (
	params: Readonly<Record<string, unknown>>,
) => Effect.Effect<unknown, McpToolError, McpToolRequirements>

/** Calls the tool's handler; with `rendered`, returns the text the model reads instead. */
const acknowledgeTool = (rendered = false): Invoke => {
	let invoke: Invoke = () => Effect.die("unregistered")
	const registrar: McpToolRegistrar = {
		define: (spec) => {
			invoke = (params) =>
				Schema.decodeEffect(spec.parameters)(params).pipe(
					Effect.orDie,
					Effect.flatMap(spec.handler),
					Effect.map((output) => (rendered ? renderToolDoc(spec.render(output)) : output)),
				)
		},
	}
	registerAcknowledgeAlertIncidentTool(registrar)
	return (params) => invoke(params)
}

const layerFor = (testDb: TestDb) =>
	Layer.mergeAll(
		unimplementedMcpToolServices,
		AlertIncidentAckService.layer,
		Layer.succeed(CurrentMcpTenant, {
			orgId: Schema.decodeSync(OrgId)(ORG),
			userId: Schema.decodeSync(UserId)("user_mcp_ack"),
			roles: [],
			authMode: "self_hosted",
		}),
	).pipe(
		Layer.provide(Layer.mergeAll(testDb.layer, EdgeCacheServiceLive)),
		Layer.provideMerge(Env.layer),
		Layer.provide(
			ConfigProvider.layer(
				ConfigProvider.fromUnknown({
					TINYBIRD_HOST: "https://api.tinybird.co",
					TINYBIRD_TOKEN: "test-token",
					MAPLE_AUTH_MODE: "self_hosted",
					MAPLE_ROOT_PASSWORD: "test-root-password",
					MAPLE_DEFAULT_ORG_ID: "default",
					MAPLE_INGEST_KEY_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64"),
					MAPLE_INGEST_KEY_LOOKUP_HMAC_KEY: "maple-test-lookup-secret",
					INTERNAL_SERVICE_TOKEN: "test-internal-token",
				}),
			),
		),
	)

const seed = (testDb: TestDb) =>
	Effect.promise(() =>
		executeSql(
			testDb,
			`INSERT INTO alert_incidents
			   (id, org_id, rule_id, incident_key, rule_name, group_key, signal_type, severity, status,
			    comparator, threshold, first_triggered_at, last_triggered_at, resolved_at,
			    dedupe_key, created_at, updated_at)
			 VALUES
			   ($1, $3, '00000000-0000-4000-8000-0000000000b0', 'mcp-open', 'Checkout errors', '__total__',
			    'error_rate', 'critical', 'open', 'gt', 5, now(), now(), null, 'm-open', now(), now()),
			   ($2, $3, '00000000-0000-4000-8000-0000000000b0', 'mcp-res', 'Checkout errors', '__total__',
			    'error_rate', 'critical', 'resolved', 'gt', 5, now(), now(), now(), 'm-res', now(), now())`,
			[OPEN, RESOLVED, ORG],
		),
	)

describe("acknowledge_alert_incident", () => {
	it.effect("acknowledges by REST id, unacknowledges, and reports a no-op", () => {
		const testDb = createTestDb(trackedDbs)
		const call = acknowledgeTool()
		return Effect.gen(function* () {
			yield* seed(testDb)
			// The `inc_…` id the v2 API and the other tools print, not the internal UUID.
			const acked = yield* call({ incident_id: encodePublicId(PublicIdPrefixes.alertIncident, OPEN) })
			assert.deepInclude(acked, {
				id: OPEN,
				status: "open",
				acknowledged: true,
				changed: true,
				// MCP has no member directory: the source stands in for the name.
				acknowledgedBy: "someone via mcp",
			})
			assert.deepInclude(yield* call({ incident_id: OPEN, acknowledged: "true" }), { changed: false })
			assert.deepInclude(yield* call({ incident_id: OPEN, acknowledged: false }), {
				acknowledged: false,
				acknowledgedBy: null,
				changed: true,
			})
		}).pipe(Effect.provide(layerFor(testDb)))
	})

	it.effect("renders the change, a no-op notice, and the timeline as the next call", () => {
		const testDb = createTestDb(trackedDbs)
		const render = acknowledgeTool(true)
		return Effect.gen(function* () {
			yield* seed(testDb)
			const acked = yield* render({ incident_id: OPEN })
			assert.include(acked, "## Incident Acknowledged")
			assert.include(acked, "Checkout errors")
			assert.include(acked, "someone via mcp")
			assert.include(acked, "get_incident_timeline")
			assert.include(acked, "00000000-0000-4000-8000-0000000000b0")
			assert.notInclude(acked, "nothing changed")
			assert.include(yield* render({ incident_id: OPEN }), "Already acknowledged; nothing changed.")
			const unacked = yield* render({ incident_id: OPEN, acknowledged: false })
			assert.include(unacked, "## Incident Unacknowledged")
			assert.notInclude(unacked, "someone via mcp")
		}).pipe(Effect.provide(layerFor(testDb)))
	})

	it.effect("names a resolved or unknown incident as invalid input on incident_id", () => {
		const testDb = createTestDb(trackedDbs)
		const call = acknowledgeTool()
		return Effect.gen(function* () {
			yield* seed(testDb)
			const resolved = yield* Effect.flip(call({ incident_id: RESOLVED }))
			assert.deepInclude(resolved, {
				_tag: "@maple/mcp/errors/McpInvalidInputError",
				parameter: "incident_id",
			})
			const unknown = yield* Effect.flip(call({ incident_id: "00000000-0000-4000-8000-0000000000ff" }))
			assert.deepInclude(unknown, {
				_tag: "@maple/mcp/errors/McpInvalidInputError",
				parameter: "incident_id",
			})
			const malformed = yield* Effect.flip(call({ incident_id: "dest_notAnIncident" }))
			assert.deepInclude(malformed, {
				_tag: "@maple/mcp/errors/McpInvalidInputError",
				parameter: "incident_id",
			})
		}).pipe(Effect.provide(layerFor(testDb)))
	})

	it.effect("records Maple, not the token's placeholder user, when Maple itself acknowledges", () => {
		const testDb = createTestDb(trackedDbs)
		const call = acknowledgeTool()
		return Effect.gen(function* () {
			yield* seed(testDb)
			const acked = yield* call({ incident_id: OPEN }).pipe(
				Effect.provideService(CurrentAuditActor, { type: "system", source: "system" }),
			)
			assert.deepInclude(acked, { acknowledged: true, acknowledgedBy: "Maple" })
			const rows = yield* Effect.promise(() =>
				testDb.pglite.query<{ acknowledged_by_user_id: string | null }>(
					"select acknowledged_by_user_id from alert_incidents where id = $1",
					[OPEN],
				),
			)
			assert.isNull(rows.rows[0]?.acknowledged_by_user_id)
		}).pipe(Effect.provide(layerFor(testDb)))
	})
})
