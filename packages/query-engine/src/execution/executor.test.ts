import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import type { OrgId } from "@maple/domain"
import { compile, listRuleChecksQuery } from "../ch"
import { makeWarehouseExecutor } from "./executor"
import type {
	ExecutionTenant,
	ResolvedWarehouseConfig,
	WarehouseExecutorDeps,
	WarehouseSqlClient,
} from "./ports"

const tenant: ExecutionTenant = {
	orgId: "org_test" as OrgId,
	userId: "user_test",
	authMode: "system",
}

// A per-org BYO read override (the read path) vs the managed Tinybird ingest
// pipeline (the write path). alert_checks rows only ever land in the latter.
const clickhouseConfig: ResolvedWarehouseConfig = {
	_tag: "clickhouse",
	url: "https://byo.example.com",
	username: "default",
	password: "secret",
	database: "maple",
}
const tinybirdConfig: ResolvedWarehouseConfig = {
	_tag: "tinybird",
	host: "https://api.tinybird.co",
	token: "tb_token",
}

const compiled = compile(listRuleChecksQuery({ limit: 1 }), {
	orgId: "org_test",
	ruleId: "rule_test",
})

// Records the backend each constructed client was wired to, so a test can assert
// which config the executor resolved through.
const makeDeps = (createdTags: Array<ResolvedWarehouseConfig["_tag"]>): WarehouseExecutorDeps => ({
	createClient: (config) => {
		createdTags.push(config._tag)
		const client: WarehouseSqlClient = {
			sql: async () => ({ data: [] }),
			insert: async () => {},
		}
		return client
	},
	resolveConfig: () => Effect.succeed({ config: clickhouseConfig, source: "org_override" as const }),
	resolveIngestConfig: () => Effect.succeed({ config: tinybirdConfig, source: "managed" as const }),
})

describe("makeWarehouseExecutor pinToIngestConfig", () => {
	it.effect("reads from the per-org (ClickHouse) config by default", () =>
		Effect.gen(function* () {
			const created: Array<ResolvedWarehouseConfig["_tag"]> = []
			const executor = makeWarehouseExecutor(makeDeps(created))
			yield* executor.compiledQuery(tenant, compiled, { context: "test" })
			expect(created).toEqual(["clickhouse"])
		}),
	)

	it.effect("reads from the ingest (Tinybird) config when pinToIngestConfig is set", () =>
		Effect.gen(function* () {
			const created: Array<ResolvedWarehouseConfig["_tag"]> = []
			const executor = makeWarehouseExecutor(makeDeps(created))
			yield* executor.compiledQuery(tenant, compiled, {
				context: "test",
				pinToIngestConfig: true,
			})
			expect(created).toEqual(["tinybird"])
		}),
	)
})

// Capture the final SQL the executor hands to the client so a test can assert
// whether a Tinybird-restricted setting (max_block_size) survived the strip for
// the resolved backend. The strip keys on the config `source`, not its `_tag`:
// the managed warehouse is Tinybird (SDK or its ClickHouse-compatible gateway,
// which surfaces as _tag "clickhouse" when CLICKHOUSE_URL is set) and enforces
// the restriction, so only a genuine per-org BYO ClickHouse keeps the setting.
const makeRecordingDeps = (
	resolved: { config: ResolvedWarehouseConfig; source: "managed" | "org_override" },
	sqls: Array<string>,
): WarehouseExecutorDeps => ({
	createClient: () => ({
		sql: async (sql: string) => {
			sqls.push(sql)
			return { data: [] }
		},
		insert: async () => {},
	}),
	resolveConfig: () => Effect.succeed(resolved),
	resolveIngestConfig: () => Effect.succeed(resolved),
})

describe("makeWarehouseExecutor restricted-settings strip", () => {
	it.effect("strips max_block_size for the managed Tinybird CH-gateway (_tag clickhouse, source managed)", () =>
		Effect.gen(function* () {
			const sqls: Array<string> = []
			const executor = makeWarehouseExecutor(
				makeRecordingDeps({ config: clickhouseConfig, source: "managed" }, sqls),
			)
			yield* executor.compiledQuery(tenant, compiled, {
				context: "test",
				settings: { maxBlockSize: 512 },
			})
			expect(sqls).toHaveLength(1)
			expect(sqls[0]).not.toContain("max_block_size")
		}),
	)

	it.effect("strips max_block_size for the managed Tinybird SDK backend (_tag tinybird, source managed)", () =>
		Effect.gen(function* () {
			const sqls: Array<string> = []
			const executor = makeWarehouseExecutor(
				makeRecordingDeps({ config: tinybirdConfig, source: "managed" }, sqls),
			)
			yield* executor.compiledQuery(tenant, compiled, {
				context: "test",
				settings: { maxBlockSize: 512 },
			})
			expect(sqls[0]).not.toContain("max_block_size")
		}),
	)

	it.effect("keeps max_block_size for a genuine BYO ClickHouse (_tag clickhouse, source org_override)", () =>
		Effect.gen(function* () {
			const sqls: Array<string> = []
			const executor = makeWarehouseExecutor(
				makeRecordingDeps({ config: clickhouseConfig, source: "org_override" }, sqls),
			)
			yield* executor.compiledQuery(tenant, compiled, {
				context: "test",
				settings: { maxBlockSize: 512 },
			})
			expect(sqls[0]).toContain("max_block_size=512")
		}),
	)
})
