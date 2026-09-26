/** The GitHub-backed source tools: typed output, and VCS failures mapped to what a model can act on. */
import { assert, describe, it } from "@effect/vitest"
import { IntegrationsUpstreamError, OrgId, UserId } from "@maple/domain/http"
import { ReadSourceFileOutput } from "@maple/domain/mcp-outputs"
import {
	VcsSourceRepositoryNotFoundError,
	VcsSourceService,
} from "@maple/backend/services/integrations/vcs/VcsSourceService"
import { Effect, Layer, Schema } from "effect"
import { CurrentMcpTenant } from "../lib/query-warehouse"
import { renderToolDoc } from "../lib/tool-doc"
import { registerSourceCodeTools } from "./source-code"
import type { McpToolError, McpToolRegistrar } from "./types"

interface Answer {
	readonly text: string
	readonly structured: unknown
}

type Run = (
	params: Readonly<Record<string, unknown>>,
) => Effect.Effect<Answer, McpToolError | Schema.SchemaError, CurrentMcpTenant | VcsSourceService>

const tools = new Map<string, Run>()
registerSourceCodeTools({
	tool: () => undefined,
	define: (spec) => {
		const run = (params: Readonly<Record<string, unknown>>) =>
			Schema.decodeUnknownEffect(spec.parameters)(params).pipe(
				Effect.flatMap(spec.handler),
				Effect.map((output) => ({
					text: renderToolDoc(spec.render(output)),
					structured: Schema.encodeUnknownSync(spec.output)(output),
				})),
			)
		tools.set(spec.name, run as Run)
	},
} satisfies McpToolRegistrar)

const tenant = Layer.succeed(CurrentMcpTenant, {
	orgId: Schema.decodeUnknownSync(OrgId)("org_tools"),
	userId: Schema.decodeUnknownSync(UserId)("user_tools"),
	roles: [],
	authMode: "self_hosted",
} as CurrentMcpTenant["Service"])

const call = (
	name: string,
	params: Readonly<Record<string, unknown>>,
	service: Partial<VcsSourceService["Service"]>,
) =>
	tools.get(name)!(params).pipe(
		Effect.provide(
			Layer.mergeAll(tenant, Layer.succeed(VcsSourceService, service as VcsSourceService["Service"])),
		),
	)

const file = {
	path: "src/a.ts",
	sha: "blob1",
	htmlUrl: "https://github.com/octo/shop/blob/main/src/a.ts",
	size: 30,
	content: "one\ntwo\nthree\nfour",
	ref: "main",
}

describe("the source-code tools", () => {
	it.effect("reads a numbered range and offers the rest", () =>
		Effect.gen(function* () {
			const result = yield* call(
				"read_source_file",
				{ repository: "octo/shop", path: "src/a.ts", start_line: 2, end_line: 3 },
				{ readFile: () => Effect.succeed(file) },
			)
			assert.include(result.text, "2: two\n3: three")
			assert.include(result.text, "Lines: 2-3/4 · truncated")
			assert.include(
				result.text,
				'read_source_file repository="octo/shop" path="src/a.ts" ref="main" start_line=4',
			)
			const output = Schema.decodeUnknownSync(ReadSourceFileOutput)(result.structured)
			assert.deepStrictEqual(output.lines, ["two", "three"])
		}),
	)

	it.effect("reports an inverted range against end_line", () =>
		Effect.gen(function* () {
			const error = yield* Effect.flip(
				call(
					"read_source_file",
					{ repository: "octo/shop", path: "src/a.ts", start_line: 5, end_line: 2 },
					{},
				),
			)
			assert.strictEqual(error._tag, "@maple/mcp/errors/McpInvalidInputError")
			if (error._tag === "@maple/mcp/errors/McpInvalidInputError")
				assert.strictEqual(error.parameter, "end_line")
		}),
	)

	it.effect("points an unconnected repository back at list_source_repositories", () =>
		Effect.gen(function* () {
			const error = yield* Effect.flip(
				call(
					"search_source_code",
					{ repository: "octo/nope", query: "declined" },
					{
						searchCode: () =>
							Effect.fail(
								new VcsSourceRepositoryNotFoundError({
									repository: "octo/nope",
									message:
										"Repository 'octo/nope' is not connected to this Maple organization. Call list_source_repositories to see the available repositories.",
								}),
							),
					},
				),
			)
			assert.strictEqual(error._tag, "@maple/mcp/errors/McpInvalidInputError")
			if (error._tag === "@maple/mcp/errors/McpInvalidInputError") {
				assert.strictEqual(error.parameter, "repository")
				assert.include(error.message, "list_source_repositories")
			}
		}),
	)

	it.effect("reads a missing GitHub App as unavailable, without the env var names", () =>
		Effect.gen(function* () {
			const error = yield* Effect.flip(
				call(
					"list_source_repositories",
					{},
					{
						listRepositories: () =>
							Effect.fail(
								new IntegrationsUpstreamError({
									message:
										"GitHub App is not configured (set GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY)",
								}),
							),
					},
				),
			)
			assert.strictEqual(error._tag, "@maple/mcp/errors/McpUnavailableError")
			if (error._tag === "@maple/mcp/errors/McpUnavailableError") {
				assert.strictEqual(error.capability, "github_app")
				assert.notInclude(error.message, "GITHUB_APP")
			}
		}),
	)
})
