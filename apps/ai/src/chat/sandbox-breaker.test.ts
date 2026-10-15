import type { TenantContext } from "@maple/backend/services/auth/tenant-context"
import { REPO_SANDBOX_IMPLEMENTATION } from "@maple/backend/services/sandbox/repo-mount"
import { SandboxRunCheckoutPending, SandboxRunUnavailable } from "@maple/domain/sandbox"
import { OrgId, UserId } from "@maple/domain/primitives"
import { SandboxSpawnError } from "@yielded/agent/sandbox"
import { Effect, Schema } from "effect"
import { assert, describe, it } from "vitest"
import type { McpToolExecutorApi } from "../mcp/dispatcher"
import type { McpToolResult } from "../mcp/tools/types"
import { MAX_CHECKOUT_WAITS, withSandboxBreaker } from "./sandbox-breaker"

const tenant: TenantContext = {
	orgId: Schema.decodeSync(OrgId)("org_test"),
	userId: Schema.decodeSync(UserId)("user_test"),
	roles: [],
	authMode: "self_hosted",
}

const failed = (failureCategory: string): McpToolResult => ({
	isError: true,
	content: [{ type: "text", text: failureCategory }],
	failureCategory,
})

const ok: McpToolResult = { content: [{ type: "text", text: "ok" }] }

/** An executor answering each call from a script, and counting the calls that reached it. */
const scripted = (answers: ReadonlyArray<McpToolResult>, calls: string[], prepareError?: unknown) => {
	const queue = [...answers]
	const executor: McpToolExecutorApi = {
		// Yields first, so concurrent calls all pass the breaker before any answers.
		execute: (_tenant, name) =>
			Effect.yieldNow.pipe(
				Effect.andThen(
					Effect.sync(() => {
						calls.push(name)
						return queue.shift() ?? ok
					}),
				),
			),
		prepareRepository: () =>
			prepareError === undefined
				? Effect.void
				: Effect.fail(
						new SandboxSpawnError({
							implementation: REPO_SANDBOX_IMPLEMENTATION,
							command: "true",
							message: "the sandbox failed",
							cause: prepareError,
						}),
					),
		prepareConnectedRepositories: () => Effect.void,
	}
	return executor
}

const grep = (executor: McpToolExecutorApi, repository = "octo/shop") =>
	executor.execute(tenant, "sandbox_grep", { repository, pattern: "x" }, "chat")

describe("withSandboxBreaker", () => {
	it("refuses further sandbox calls for a repository once its sandbox is unavailable", async () => {
		const calls: string[] = []
		const results = await Effect.runPromise(
			Effect.gen(function* () {
				const executor = yield* withSandboxBreaker(scripted([failed("unavailable")], calls))
				return [
					yield* grep(executor),
					yield* grep(executor, "Octo/Shop"),
					yield* grep(executor, "octo/api"),
				]
			}),
		)
		assert.deepStrictEqual(calls, ["sandbox_grep", "sandbox_grep"])
		assert.include(results[1]!.content[0]!.text, "read_source_file")
		// Another repository has its own sandbox.
		assert.strictEqual(results[2], ok)
	})

	it("gives up on a checkout after missing its clone wait twice in a row", async () => {
		const calls: string[] = []
		await Effect.runPromise(
			Effect.gen(function* () {
				const executor = yield* withSandboxBreaker(
					scripted([failed("not_ready"), ok, failed("not_ready"), failed("not_ready")], calls),
				)
				// A success between waits resets the count.
				yield* Effect.forEach([1, 2, 3, 4, 5], () => grep(executor), { discard: true })
			}),
		)
		assert.strictEqual(calls.length, 2 + MAX_CHECKOUT_WAITS)
	})

	it("stays down when a call that started before the trip succeeds after it", async () => {
		const calls: string[] = []
		await Effect.runPromise(
			Effect.gen(function* () {
				const executor = yield* withSandboxBreaker(scripted([failed("unavailable"), ok], calls))
				yield* Effect.all([grep(executor), grep(executor)], { concurrency: "unbounded" })
				yield* grep(executor)
			}),
		)
		assert.strictEqual(calls.length, 2)
	})

	it("leaves other tools alone", async () => {
		const calls: string[] = []
		await Effect.runPromise(
			Effect.gen(function* () {
				const executor = yield* withSandboxBreaker(scripted([failed("unavailable")], calls))
				yield* grep(executor)
				yield* executor.execute(tenant, "read_source_file", { repository: "octo/shop" }, "chat")
			}),
		)
		assert.deepStrictEqual(calls, ["sandbox_grep", "read_source_file"])
	})

	it("trips on a kickoff clone the sandbox could not start, but not on one still running", async () => {
		const run = (cause: unknown) => {
			const calls: string[] = []
			return Effect.runPromise(
				Effect.gen(function* () {
					const executor = yield* withSandboxBreaker(scripted([], calls, cause))
					yield* Effect.ignore(executor.prepareRepository(tenant, { repository: "octo/shop" }))
					yield* grep(executor)
				}),
			).then(() => calls.length)
		}
		assert.strictEqual(await run(new SandboxRunUnavailable({ message: "HTTP error! status: 500" })), 0)
		assert.strictEqual(await run(new SandboxRunCheckoutPending({ message: "still cloning" })), 1)
	})
})
