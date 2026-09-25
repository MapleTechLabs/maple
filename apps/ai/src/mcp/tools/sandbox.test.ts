import { assert, describe, it } from "@effect/vitest"
import { IntegrationsUpstreamError, OrgId, UserId } from "@maple/domain/http"
import { SandboxRunCheckoutPending } from "@maple/domain/sandbox"
import {
	SandboxOutputLimitError,
	SandboxImplementation,
	SandboxSpawnError,
	type SandboxError,
} from "effect-agent/sandbox"
import {
	SandboxExecOutput,
	SandboxGrepOutput,
	SandboxListFilesOutput,
	SandboxReadFileOutput,
} from "@maple/domain/mcp-outputs"
import {
	VcsSourceRefNotFoundError,
	VcsSourceRepositoryNotFoundError,
} from "@maple/backend/services/integrations/vcs/VcsSourceService"
import { Effect, Layer, Schema } from "effect"
import { CurrentMcpTenant } from "../lib/query-warehouse"
import { renderToolDoc } from "../lib/tool-doc"
import {
	RepoSandboxService,
	type RepoSandboxServiceApi,
	type SandboxCommandResult,
} from "@maple/backend/services/sandbox/RepoSandboxService"
import { registerSandboxTools } from "./sandbox"
import type { McpToolError, McpToolRegistrar } from "./types"

/** Every parameter the four tools accept; each test passes the subset its tool reads. */
interface SandboxToolParams {
	readonly repository: string
	readonly pattern?: string
	readonly path?: string
	readonly glob?: string
	readonly ref?: string
	readonly case_sensitive?: boolean
	readonly context_lines?: number
	readonly start_line?: number
	readonly end_line?: number
	readonly command?: string
	readonly args?: ReadonlyArray<string>
	readonly cwd?: string
	readonly timeout_seconds?: number
}

interface Answer {
	readonly text: string
	/** The encoded output, as it goes out on `structuredContent`. */
	readonly structured: unknown
}

type Run = (
	params: SandboxToolParams,
) => Effect.Effect<Answer, McpToolError | Schema.SchemaError, CurrentMcpTenant | RepoSandboxService>

/** Decode, handle, encode and render, as the registry does; failures stay typed for the assertions. */
const tools = new Map<string, Run>()
registerSandboxTools({
	tool: () => undefined,
	define: (spec) => {
		const run = (params: SandboxToolParams) =>
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

const ok = (stdout: string, exitCode = 0, stderr = ""): SandboxCommandResult => ({
	exitCode,
	stdout,
	stderr,
	wallTimeMs: 12,
	truncated: false,
})

const call = (name: string, params: SandboxToolParams, service: Partial<RepoSandboxServiceApi>) =>
	tools.get(name)!(params).pipe(
		Effect.provide(
			Layer.mergeAll(tenant, Layer.succeed(RepoSandboxService, service as RepoSandboxServiceApi)),
		),
	)

/** The failure a call ended with. */
const failure = (name: string, params: SandboxToolParams, service: Partial<RepoSandboxServiceApi>) =>
	Effect.flip(call(name, params, service))

/** Asserts an invalid-input failure naming `parameter`, and returns its message. */
const invalidInput = (error: McpToolError | Schema.SchemaError, parameter: string | undefined): string => {
	if (error._tag !== "@maple/mcp/errors/McpInvalidInputError") {
		assert.fail(`expected McpInvalidInputError, got ${error._tag}`)
		return ""
	}
	assert.strictEqual(error.parameter, parameter)
	return error.message
}

const implementation = new SandboxImplementation({ isolation: "isolated", identity: "test" })
const spawnFailure = (message: string, cause: unknown): SandboxError =>
	new SandboxSpawnError({ implementation, command: "git", message, cause })

describe("the sandbox tools", () => {
	it.effect("renders grep matches and passes the search options through", () =>
		Effect.gen(function* () {
			const seen: unknown[] = []
			const result = yield* call(
				"sandbox_grep",
				{
					repository: "octo/shop",
					pattern: "card declined",
					glob: "*.ts",
					case_sensitive: false,
					context_lines: 9,
				},
				{
					grep: (_org, target, options) => {
						seen.push(target, options)
						return Effect.succeed(ok("src/checkout.ts:2:throw new Error('card declined')"))
					},
				},
			)
			assert.include(result.text, "src/checkout.ts:2:")
			assert.include(result.text, "## Sandbox grep: `card declined`")
			assert.deepStrictEqual(seen[0], { repository: "octo/shop", ref: undefined })
			assert.deepStrictEqual(seen[1], {
				pattern: "card declined",
				path: undefined,
				glob: "*.ts",
				caseSensitive: false,
				// Clamped to the documented maximum rather than passed through.
				contextLines: 5,
			})
			const output = Schema.decodeUnknownSync(SandboxGrepOutput)(result.structured)
			assert.deepStrictEqual(output.lines, ["src/checkout.ts:2:throw new Error('card declined')"])
		}),
	)

	it.effect("says so when nothing matched, and surfaces git's own errors", () =>
		Effect.gen(function* () {
			const none = yield* call(
				"sandbox_grep",
				{ repository: "octo/shop", pattern: "nothing" },
				{ grep: () => Effect.succeed(ok("", 1)) },
			)
			assert.include(none.text, "No matches.")
			const broken = yield* failure(
				"sandbox_grep",
				{ repository: "octo/shop", pattern: "x" },
				{ grep: () => Effect.succeed(ok("", 129, "unknown option")) },
			)
			assert.include(invalidInput(broken, undefined), "unknown option")
		}),
	)

	it.effect("explains a pattern git grep cannot compile against the pattern parameter", () =>
		Effect.gen(function* () {
			const error = yield* failure(
				"sandbox_grep",
				{ repository: "octo/shop", pattern: "handle(" },
				{
					grep: () =>
						Effect.succeed(ok("", 128, "fatal: command line, 'handle(': Unmatched ( or \\(")),
				},
			)
			const message = invalidInput(error, "pattern")
			assert.include(message, "POSIX extended regex")
			assert.include(message, "escape")
		}),
	)

	it.effect("caps grep output and says how much there was", () =>
		Effect.gen(function* () {
			const lines = Array.from({ length: 250 }, (_, index) => `src/a.ts:${index + 1}:x`)
			const result = yield* call(
				"sandbox_grep",
				{ repository: "octo/shop", pattern: "x" },
				{ grep: () => Effect.succeed(ok(lines.join("\n"))) },
			)
			assert.include(result.text, "Showing 200 of 250 lines.")
			assert.notInclude(result.text, "src/a.ts:201:x")
		}),
	)

	it.effect("numbers the read range and reports the file's length", () =>
		Effect.gen(function* () {
			const result = yield* call(
				"sandbox_read_file",
				{ repository: "octo/shop", path: "src/checkout.ts", start_line: 2, end_line: 3 },
				{ readFile: () => Effect.succeed(ok("2: two\n3: three\n__MAPLE_TOTAL_LINES__ 10\n")) },
			)
			assert.include(result.text, "Lines: 2-3/10 · truncated")
			assert.include(result.text, "2: two\n3: three")
			assert.notInclude(result.text, "__MAPLE_TOTAL_LINES__")
			// The rest of the file is one typed call away.
			assert.include(
				result.text,
				'sandbox_read_file repository="octo/shop" path="src/checkout.ts" start_line=4',
			)
			const output = Schema.decodeUnknownSync(SandboxReadFileOutput)(result.structured)
			assert.strictEqual(output.totalLines, 10)
		}),
	)

	it.effect("reports an inverted line range and an unreadable file against the parameter to fix", () =>
		Effect.gen(function* () {
			const never = () => Effect.die("the tool should have refused before calling the service")
			const inverted = yield* failure(
				"sandbox_read_file",
				{ repository: "octo/shop", path: "src/a.ts", start_line: 20, end_line: 10 },
				{ readFile: never },
			)
			assert.include(
				invalidInput(inverted, "end_line"),
				"end_line must be greater than or equal to start_line",
			)
			const missing = yield* failure(
				"sandbox_read_file",
				{ repository: "octo/shop", path: "src/gone.ts" },
				{ readFile: () => Effect.succeed(ok("", 2, "awk: cannot open src/gone.ts")) },
			)
			assert.include(invalidInput(missing, "path"), "No readable file 'src/gone.ts' at that ref")
		}),
	)

	it.effect("refuses paths that leave the repository before touching the sandbox", () =>
		Effect.gen(function* () {
			const read = yield* failure(
				"sandbox_read_file",
				{ repository: "octo/shop", path: "../secrets" },
				{},
			)
			invalidInput(read, "path")
			const exec = yield* failure(
				"sandbox_exec",
				{ repository: "octo/shop", command: "/bin/sh", args: [] },
				{},
			)
			invalidInput(exec, "command")
		}),
	)

	it.effect("renders exec output and turns a contract failure into a tool error the model can act on", () =>
		Effect.gen(function* () {
			const result = yield* call(
				"sandbox_exec",
				{ repository: "octo/shop", command: "wc", args: ["-l", "README.md"] },
				{ exec: () => Effect.succeed(ok("3 README.md\n")) },
			)
			assert.include(result.text, "3 README.md")
			const output = Schema.decodeUnknownSync(SandboxExecOutput)(result.structured)
			assert.deepStrictEqual(output.args, ["-l", "README.md"])
			const error = yield* failure(
				"sandbox_exec",
				{ repository: "octo/shop", command: "cat", args: ["big"] },
				{
					exec: () =>
						Effect.fail(
							new SandboxOutputLimitError({
								implementation,
								stream: "stdout",
								limit: 49152,
								observed: 100000,
							}),
						),
				},
			)
			assert.include(invalidInput(error, undefined), "exceeded 48 KiB")
		}),
	)

	it.effect("reads a clone still running as not ready, with a retry hint", () =>
		Effect.gen(function* () {
			const error = yield* failure(
				"sandbox_grep",
				{ repository: "octo/shop", pattern: "x" },
				{
					grep: () =>
						Effect.fail(
							spawnFailure(
								"The checkout of octo/shop at abc is still being cloned after 90s. The clone continues in the background: gather other evidence first and come back to this repository later rather than calling again immediately.",
								new SandboxRunCheckoutPending({ message: "still preparing" }),
							),
						),
				},
			)
			assert.strictEqual(error._tag, "@maple/mcp/errors/McpNotReadyError")
			if (error._tag === "@maple/mcp/errors/McpNotReadyError") {
				assert.isAbove(error.retryAfterSeconds, 0)
				assert.include(error.message, "gather other evidence first")
			}
		}),
	)

	it.effect("maps the checkout's VCS failures by tag", () =>
		Effect.gen(function* () {
			const failWith = (cause: unknown) => ({
				listFiles: () => Effect.fail(spawnFailure("resolve failed", cause)),
			})
			const repo = yield* failure(
				"sandbox_list_files",
				{ repository: "octo/nope" },
				failWith(
					new VcsSourceRepositoryNotFoundError({
						repository: "octo/nope",
						message:
							"Repository 'octo/nope' is not connected to this Maple organization. Call list_source_repositories to see the available repositories.",
					}),
				),
			)
			assert.include(invalidInput(repo, "repository"), "list_source_repositories")
			const ref = yield* failure(
				"sandbox_list_files",
				{ repository: "octo/shop", ref: "1.2.3" },
				failWith(
					new VcsSourceRefNotFoundError({
						repository: "octo/shop",
						ref: "1.2.3",
						message:
							"No ref '1.2.3' exists in 'octo/shop'. A service version string is not a git ref.",
					}),
				),
			)
			assert.include(invalidInput(ref, "ref"), "No ref '1.2.3'")
			const app = yield* failure(
				"sandbox_list_files",
				{ repository: "octo/shop" },
				failWith(
					new IntegrationsUpstreamError({
						message:
							"GitHub App is not configured (set GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY)",
					}),
				),
			)
			assert.strictEqual(app._tag, "@maple/mcp/errors/McpUnavailableError")
			if (app._tag === "@maple/mcp/errors/McpUnavailableError") {
				assert.strictEqual(app.capability, "github_app")
				assert.notInclude(app.message, "GITHUB_APP_ID")
			}
		}),
	)

	it.effect("validates the trimmed value, because that is the one the service receives", () =>
		Effect.gen(function* () {
			const never = () => Effect.die("the tool should have refused before calling the service")
			// Untrimmed, `" ../etc"` splits into `[" ..", "etc"]`, so a check that runs
			// before the trim sees no traversal segment while git sees one.
			for (const [tool, params] of [
				["sandbox_grep", { repository: "octo/shop", pattern: "x", path: " ../etc" }],
				["sandbox_grep", { repository: "octo/shop", pattern: "x", path: " /etc" }],
				["sandbox_list_files", { repository: "octo/shop", path: " ../etc" }],
				["sandbox_read_file", { repository: "octo/shop", path: " ../etc" }],
				["sandbox_exec", { repository: "octo/shop", command: "wc", cwd: " ../etc" }],
			] satisfies Array<[string, SandboxToolParams]>) {
				const error = yield* failure(tool, params, {
					grep: never,
					listFiles: never,
					readFile: never,
					exec: never,
				})
				assert.include(
					invalidInput(error, tool === "sandbox_exec" ? "cwd" : "path"),
					"repository-relative",
				)
			}
		}),
	)

	it.effect("refuses a ref outside git's grammar on every tool, grep included", () =>
		Effect.gen(function* () {
			const never = () => Effect.die("the tool should have refused before calling the service")
			// A `..` in a ref is normalised away in the provider URL and would walk an
			// installation-wide credential onto a repository the org never connected.
			for (const [tool, params] of [
				["sandbox_grep", { repository: "octo/shop", pattern: "x", ref: "main/../../other/x" }],
				["sandbox_list_files", { repository: "octo/shop", ref: "main/../../other/x" }],
				["sandbox_read_file", { repository: "octo/shop", path: "a.ts", ref: "main/../../other/x" }],
				["sandbox_exec", { repository: "octo/shop", command: "wc", ref: "main/../../other/x" }],
			] satisfies Array<[string, SandboxToolParams]>) {
				const error = yield* failure(tool, params, {
					grep: never,
					listFiles: never,
					readFile: never,
					exec: never,
				})
				assert.include(invalidInput(error, "ref"), "branch, tag, or commit SHA")
			}
		}),
	)

	it.effect("lists files sorted, with the structured output", () =>
		Effect.gen(function* () {
			const result = yield* call(
				"sandbox_list_files",
				{ repository: "octo/shop", path: "src" },
				{ listFiles: () => Effect.succeed(ok("src/b.ts\nsrc/a.ts\n")) },
			)
			assert.include(result.text, "- src/a.ts\n- src/b.ts")
			const output = Schema.decodeUnknownSync(SandboxListFilesOutput)(result.structured)
			assert.deepStrictEqual(output.files, ["src/a.ts", "src/b.ts"])
		}),
	)

	it.effect("keeps blank lines in a file read, so the numbering matches the reported range", () =>
		Effect.gen(function* () {
			const result = yield* call(
				"sandbox_read_file",
				{ repository: "octo/shop", path: "src/a.ts", start_line: 1, end_line: 4 },
				{
					readFile: () =>
						Effect.succeed(
							ok("1: const a = 1\n2: \n3: \n4: const b = 2\n__MAPLE_TOTAL_LINES__ 4\n"),
						),
				},
			)
			assert.include(result.text, "2: ")
			assert.include(result.text, "3: ")
			assert.include(result.text, "4: const b = 2")
		}),
	)
})
