import { afterEach, assert, describe, it } from "@effect/vitest"
import { ConfigProvider, Effect, Layer, Schema } from "effect"
import { OrgId, RoleName, UserId } from "@maple/domain/http"
import { Env } from "@maple/backend/platform/Env"
import { EdgeCacheServiceLive } from "@maple/backend/platform/CacheBackendLive"
import { cleanupTestDbs, createTestDb, type TestDb } from "@maple/backend/platform/test-pglite"
import { IngestRuleService } from "@maple/backend/services/org/IngestRuleService"
import { CurrentMcpTenant } from "../lib/query-warehouse"
import { parameterOfProblem, previewOver, registerIngestRuleTools } from "./ingest-rules"
import type { McpToolError, McpToolRegistrar } from "./types"
import type { McpToolRequirements } from "./runtime-requirements"
import { unimplementedMcpToolServices } from "../../../test/mcp/unimplemented-tool-services"

const trackedDbs: TestDb[] = []
afterEach(() => cleanupTestDbs(trackedDbs))

const testConfig = () =>
	ConfigProvider.layer(
		ConfigProvider.fromUnknown({
			PORT: "3474",
			MCP_PORT: "3475",
			TINYBIRD_HOST: "https://api.tinybird.co",
			TINYBIRD_TOKEN: "test-token",
			MAPLE_AUTH_MODE: "self_hosted",
			MAPLE_ROOT_PASSWORD: "test-root-password",
			MAPLE_DEFAULT_ORG_ID: "default",
			MAPLE_INGEST_KEY_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64"),
			MAPLE_INGEST_KEY_LOOKUP_HMAC_KEY: "maple-test-lookup-secret",
			INTERNAL_SERVICE_TOKEN: "test-internal-token",
		}),
	)

/** A tool call's raw arguments, decoded by the tool's own parameter schema. */
type ToolParams = Readonly<Record<string, unknown>>
type Invoke = (params: ToolParams) => Effect.Effect<unknown, McpToolError, McpToolRequirements>

const tools = () => {
	const handlers = new Map<string, Invoke>()
	const registrar: McpToolRegistrar = {
		define: (spec) => {
			handlers.set(spec.name, (params) =>
				Schema.decodeUnknownEffect(spec.parameters)(params).pipe(
					Effect.orDie,
					Effect.flatMap(spec.handler),
				),
			)
		},
	}
	registerIngestRuleTools(registrar)
	return (name: string, params: ToolParams) => {
		const handler = handlers.get(name)
		assert.isDefined(handler)
		return handler === undefined ? Effect.die("unregistered") : handler(params)
	}
}

const layerFor = (testDb: TestDb, roles: ReadonlyArray<string>) =>
	Layer.mergeAll(
		unimplementedMcpToolServices,
		IngestRuleService.layer,
		Layer.succeed(CurrentMcpTenant, {
			orgId: Schema.decodeUnknownSync(OrgId)("org_mcp_rules"),
			userId: Schema.decodeUnknownSync(UserId)("user_mcp_rules"),
			roles: roles.map((role) => Schema.decodeUnknownSync(RoleName)(role)),
			authMode: "self_hosted",
		}),
	).pipe(
		Layer.provide(Layer.mergeAll(testDb.layer, EdgeCacheServiceLive)),
		Layer.provideMerge(Env.layer),
		Layer.provide(testConfig()),
	)

const dropDebug = {
	name: "Drop debug logs",
	signals: ["logs"],
	conditions: [{ field: "severity", op: "lt", value: "info" }],
	action: { type: "drop", keep_percent: 0 },
}

describe("ingest rule MCP tools", () => {
	it.effect("an admin creates, finds by name, updates and deletes a rule", () => {
		const call = tools()
		return Effect.gen(function* () {
			const created = yield* call("create_ingest_rule", dropDebug)
			assert.deepInclude(created, { action: "created" })
			const listed = yield* call("list_ingest_rules", {})
			assert.deepEqual(
				Schema.decodeUnknownSync(
					Schema.Struct({ rules: Schema.Array(Schema.Struct({ summary: Schema.String })) }),
				)(listed).rules.map((rule) => rule.summary),
				["Drop logs where severity is below info"],
			)
			const updated = yield* call("update_ingest_rule", { rule: "Drop debug logs", enabled: false })
			assert.deepNestedInclude(updated, { "rule.enabled": false })
			yield* call("delete_ingest_rule", { rule: "Drop debug logs", confirm: true })
			assert.deepEqual(yield* call("list_ingest_rules", {}), { rules: [] })
		}).pipe(Effect.provide(layerFor(createTestDb(trackedDbs), ["org:admin"])))
	})

	it.effect("refuses writes from a member and names invalid rules as input errors", () => {
		const call = tools()
		const testDb = createTestDb(trackedDbs)
		return Effect.gen(function* () {
			const refused = yield* call("create_ingest_rule", dropDebug).pipe(Effect.flip)
			assert.strictEqual(refused._tag, "@maple/mcp/errors/McpUnavailableError")
		})
			.pipe(Effect.provide(layerFor(testDb, ["org:member"])))
			.pipe(
				Effect.andThen(
					Effect.gen(function* () {
						const invalid = yield* call("create_ingest_rule", {
							...dropDebug,
							conditions: [],
						}).pipe(Effect.flip)
						assert.strictEqual(invalid._tag, "@maple/mcp/errors/McpInvalidInputError")
						assert.include(invalid.message, "a drop rule needs at least one condition")
					}).pipe(Effect.provide(layerFor(testDb, ["org:admin"]))),
				),
			)
	})

	it.effect("a draft for metrics reports why it cannot be previewed instead of querying", () => {
		const call = tools()
		return Effect.gen(function* () {
			const preview = yield* call("preview_ingest_rule", {
				signals: ["metrics"],
				conditions: [{ field: "name", op: "prefix", value: "process." }],
				action: { type: "drop", keep_percent: 0 },
			})
			assert.deepInclude(preview, { sampled: 0, problems: ["metrics rules cannot be previewed"] })
		}).pipe(Effect.provide(layerFor(createTestDb(trackedDbs), [])))
	})

	it.effect("refuses to preview span_kind conditions it cannot see", () => {
		const call = tools()
		return Effect.gen(function* () {
			const preview = yield* call("preview_ingest_rule", {
				signals: ["traces"],
				conditions: [{ field: "span_kind", op: "in", values: ["internal"] }],
				action: { type: "drop", keep_percent: 0 },
			})
			assert.deepInclude(preview, {
				sampled: 0,
				problems: [
					"span_kind conditions cannot be previewed here; use the preview in Settings > Ingestion",
				],
			})
		}).pipe(Effect.provide(layerFor(createTestDb(trackedDbs), [])))
	})

	it("counts what a draft would drop and redact, with examples", () => {
		const log = (body: string, severityNumber: number) => ({
			signal: "logs" as const,
			resource: { "service.name": "api" },
			attributes: { "user.email": "a@b.co" },
			body,
			severityNumber,
		})
		const drop = previewOver(
			{
				signals: ["logs"],
				conditions: [{ field: "severity", op: "lt", value: "info" }],
				action: { _tag: "drop", keepPercent: 0 },
			},
			[log("noise", 5), log("kept", 9), log("noise", 1)],
		)
		assert.deepInclude(drop, { sampled: 3, dropped: 2, redactedRecords: 0 })
		assert.deepEqual(
			drop.examples.map((example) => [example.outcome, example.label]),
			[
				["dropped", "noise"],
				["dropped", "noise"],
			],
		)
		const redact = previewOver(
			{
				signals: ["logs"],
				conditions: [],
				action: {
					_tag: "redact",
					keys: [],
					detectors: ["email"],
					patterns: [],
					scopes: ["attributes"],
					method: "mask",
				},
			},
			[log("a", 9), log("b", 9)],
		)
		assert.deepInclude(redact, { dropped: 0, redactedRecords: 2, redactedValues: 2 })
		assert.deepEqual(redact.examples[0]?.changes, ["user.email -> [REDACTED:email]"])
	})

	it("names the argument a validation problem is about", () => {
		assert.deepEqual(
			[
				"condition 1: attribute needs a key",
				"a drop rule needs at least one condition",
				"pick at least one signal",
				"the name must be 1 to 120 characters",
				"position is a whole number from 0 to 10000",
				"pattern 1: lookaround is not supported",
			].map(parameterOfProblem),
			["conditions", "conditions", "signals", "name", "position", "action"],
		)
	})
})
