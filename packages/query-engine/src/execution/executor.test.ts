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
