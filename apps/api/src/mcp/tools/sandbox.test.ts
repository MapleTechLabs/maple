import { assert, describe, it } from "@effect/vitest"
import { OrgId, UserId } from "@maple/domain/http"
import { SandboxOutputLimitError, SandboxImplementation } from "@effect-agent/sandbox/Sandbox"
import { Effect, Layer, Schema } from "effect"
import { CurrentMcpTenant } from "@/mcp/lib/query-warehouse"
import {
	RepoSandboxService,
	type RepoSandboxServiceApi,
	type SandboxCommandResult,
} from "@/services/sandbox/RepoSandboxService"
import { registerSandboxTools } from "./sandbox"
import type { McpToolError, McpToolRegistrar, McpToolResult } from "./types"

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

type Handler = (
	params: SandboxToolParams,
) => Effect.Effect<McpToolResult, McpToolError, CurrentMcpTenant | RepoSandboxService>

const tools = new Map<string, Handler>()
registerSandboxTools({
	tool: (name, _description, _schema, handler) => {
		tools.set(name, handler as Handler)
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
})

const call = (name: string, params: SandboxToolParams, service: Partial<RepoSandboxServiceApi>) =>
	tools.get(name)!(params).pipe(
		Effect.provide(
			Layer.mergeAll(tenant, Layer.succeed(RepoSandboxService, service as RepoSandboxServiceApi)),
		),
	)

const textOf = (result: McpToolResult) => result.content.map((block) => block.text).join("\n")

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
			assert.include(textOf(result), "src/checkout.ts:2:")
			assert.deepStrictEqual(seen[0], { repository: "octo/shop", ref: undefined })
			assert.deepStrictEqual(seen[1], {
				pattern: "card declined",
				path: undefined,
				glob: "*.ts",
				caseSensitive: false,
				// Clamped to the documented maximum rather than passed through.
				contextLines: 5,
			})
		}),
	)

	it.effect("says so when nothing matched, and surfaces git's own errors", () =>
		Effect.gen(function* () {
			const none = yield* call(
				"sandbox_grep",
				{ repository: "octo/shop", pattern: "nothing" },
				{ grep: () => Effect.succeed(ok("", 1)) },
			)
			assert.include(textOf(none), "No matches.")
			const broken = yield* call(
				"sandbox_grep",
				{ repository: "octo/shop", pattern: "(" },
				{ grep: () => Effect.succeed(ok("", 129, "unknown option")) },
			)
			assert.isTrue(broken.isError)
			assert.include(textOf(broken), "unknown option")
		}),
	)

	it.effect("numbers the read range and reports the file's length", () =>
		Effect.gen(function* () {
			const result = yield* call(
				"sandbox_read_file",
				{ repository: "octo/shop", path: "src/checkout.ts", start_line: 2, end_line: 3 },
				{ readFile: () => Effect.succeed(ok("2: two\n3: three\n__MAPLE_TOTAL_LINES__ 10\n")) },
			)
			const text = textOf(result)
			assert.include(text, "Lines: 2-3/10 · truncated")
			assert.include(text, "2: two\n3: three")
			assert.notInclude(text, "__MAPLE_TOTAL_LINES__")
		}),
	)

	it.effect("refuses paths that leave the repository before touching the sandbox", () =>
		Effect.gen(function* () {
			const result = yield* call(
				"sandbox_read_file",
				{ repository: "octo/shop", path: "../secrets" },
				{},
			)
			assert.isTrue(result.isError)
			const exec = yield* call(
				"sandbox_exec",
				{ repository: "octo/shop", command: "/bin/sh", args: [] },
				{},
			)
			assert.isTrue(exec.isError)
		}),
	)

	it.effect("renders exec output and turns a contract failure into a tool error the model can act on", () =>
		Effect.gen(function* () {
			const result = yield* call(
				"sandbox_exec",
				{ repository: "octo/shop", command: "wc", args: ["-l", "README.md"] },
				{ exec: () => Effect.succeed(ok("3 README.md\n")) },
			)
			assert.include(textOf(result), "3 README.md")
			const exit = yield* Effect.exit(
				call(
					"sandbox_exec",
					{ repository: "octo/shop", command: "cat", args: ["big"] },
					{
						exec: () =>
							Effect.fail(
								new SandboxOutputLimitError({
									implementation: new SandboxImplementation({
										isolation: "isolated",
										identity: "test",
									}),
									stream: "stdout",
									limit: 49152,
									observed: 100000,
								}),
							),
					},
				),
			)
			assert.isTrue(exit._tag === "Failure")
			if (exit._tag === "Failure" && exit.cause.reasons[0]?._tag === "Fail") {
				assert.include(exit.cause.reasons[0].error.message, "exceeded 48 KiB")
			}
		}),
	)
})
