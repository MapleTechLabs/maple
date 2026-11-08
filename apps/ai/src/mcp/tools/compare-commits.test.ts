import { afterEach, describe, expect, it } from "@effect/vitest"
import { ConfigProvider, Effect, Layer, Schema } from "effect"
import { GitCommitSha, OrgId, UserId } from "@maple/domain/http"
import { Env } from "@maple/backend/platform/Env"
import { EdgeCacheServiceLive } from "@maple/backend/platform/CacheBackendLive"
import { cleanupTestDbs, createTestDb, type TestDb } from "@maple/backend/platform/test-pglite"
import { VcsCommitService } from "@maple/backend/services/integrations/vcs/VcsCommitService"
import { CurrentMcpTenant } from "../lib/query-warehouse"
import { renderToolDoc } from "../lib/tool-doc"
import { registerCompareCommitsTool } from "./compare-commits"
import type { McpToolError, McpToolRegistrar } from "./types"
import type { McpToolRequirements } from "./runtime-requirements"
import { unimplementedMcpToolServices } from "../../../test/mcp/unimplemented-tool-services"

const trackedDbs: TestDb[] = []
afterEach(() => cleanupTestDbs(trackedDbs))

const BASE = "a".repeat(40)
const HEAD = "b".repeat(40)

type Invoke = (
	params: Readonly<Record<string, unknown>>,
) => Effect.Effect<{ readonly output: unknown; readonly text: string }, McpToolError, McpToolRequirements>

const compareTool = (): Invoke => {
	let invoke: Invoke = () => Effect.die("unregistered")
	const registrar: McpToolRegistrar = {
		define: (spec) => {
			invoke = (params) =>
				Schema.decodeEffect(spec.parameters)(params).pipe(
					Effect.orDie,
					Effect.flatMap(spec.handler),
					Effect.map((output) => ({ output, text: renderToolDoc(spec.render(output)) })),
				)
		},
	}
	registerCompareCommitsTool(registrar)
	return invoke
}

const commit = (sha: string, resolved: "stored" | "fetched", committedAt: number) => ({
	provider: "github" as const,
	sha: Schema.decodeSync(GitCommitSha)(sha),
	message: "feat: something\n\nbody",
	authorName: "Maya",
	authorEmail: null,
	authorLogin: "maya",
	authorAvatarUrl: null,
	authoredAt: null,
	committedAt,
	htmlUrl: `https://github.com/acme/shop/commit/${sha}`,
	repoFullName: "acme/shop",
	resolved,
})

/** Maple stores the base (tracked branch) but had to read the head from GitHub on demand. */
const offBranchHead = Layer.succeed(VcsCommitService, {
	resolveCommitDetail: () => Effect.die("not used"),
	resolveCommitRanges: (_org, ranges) =>
		Effect.succeed(
			ranges.map((range) => ({
				...range,
				status: "unavailable" as const,
				repoFullName: "",
				totalCount: 0,
				commits: [],
				truncated: false,
			})),
		),
	resolveCommitDetails: () =>
		Effect.succeed([commit(BASE, "stored", 1_000), commit(HEAD, "fetched", 2_000)]),
})

const run = (params: Readonly<Record<string, unknown>>) =>
	compareTool()(params).pipe(
		Effect.provide(
			Layer.mergeAll(
				offBranchHead,
				Layer.succeed(CurrentMcpTenant, {
					orgId: Schema.decodeSync(OrgId)("org_compare"),
					userId: Schema.decodeSync(UserId)("user_compare"),
					roles: [],
					authMode: "self_hosted",
				}),
			).pipe(
				// The stubs above win over the unimplemented mocks.
				Layer.provideMerge(unimplementedMcpToolServices),
				Layer.provide(Layer.mergeAll(createTestDb(trackedDbs).layer, EdgeCacheServiceLive)),
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
			),
		),
	)

describe("compare_commits", () => {
	it.effect("names the off-branch end and its repository, and links GitHub's compare view", () =>
		Effect.gen(function* () {
			const { output, text } = yield* run({ base: BASE, head: HEAD })
			expect(output).toMatchObject({
				status: "unavailable",
				repository: "acme/shop",
				compareUrl: `https://github.com/acme/shop/compare/${BASE}...${HEAD}`,
			})
			expect(text).toContain(`The head (${HEAD.slice(0, 12)}) is not on acme/shop's tracked branch`)
			expect(text).toContain("Repository: acme/shop")
			expect(text).toContain(`https://github.com/acme/shop/compare/${BASE}...${HEAD}`)
		}),
	)
})
