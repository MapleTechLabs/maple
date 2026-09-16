/**
 * The doom-loop guard.
 *
 * The old turn loop stopped a model that reissued an identical tool batch until its turns ran out.
 * The engine has no equivalent — its `repeatedFailureLimit` counts consecutive tool *failures*,
 * which is a different thing — so the guard lives with the handlers, where refusing is a declared
 * tool failure the model can read rather than an authorization denial that ends the turn.
 */
import { OrgId, UserId } from "@maple/domain"
import { Effect, Result, Schema } from "effect"
import { assert, describe, it } from "vitest"
import type { McpToolExecutorApi } from "../dispatcher"
import type { TenantContext } from "@maple/backend/services/auth/tenant-context"
import { makeRecordingTracer } from "@maple/backend/testing/recording-tracer"
import { APPROVAL_NOTE, buildMapleToolkit } from "./llm-tools"

const TENANT: TenantContext = {
	orgId: Schema.decodeSync(OrgId)("org_test"),
	userId: Schema.decodeSync(UserId)("user_test"),
	roles: [],
	authMode: "self_hosted",
}

const countingExecutor = () => {
	let dispatched = 0
	const executor: McpToolExecutorApi = {
		execute: (_tenant, name) => {
			dispatched += 1
			return Effect.succeed({ content: [{ type: "text" as const, text: `${name} ran` }] })
		},
	}
	return { executor, dispatched: () => dispatched }
}

const handlerFor = (executor: McpToolExecutorApi, name: string) => {
	const built = buildMapleToolkit(executor, TENANT, {})
	const handler = built.handlers[name]
	assert.isDefined(handler, `no handler for ${name}`)
	return handler!
}

describe("buildMapleToolkit", () => {
	/**
	 * A tool error is the call's answer, not the run's end. The engine ends a run on a declared
	 * failure — right for a proposal, wrong for a rejected query the model can rewrite.
	 */
	it("answers a failed tool with its message instead of failing the run", async () => {
		const executor: McpToolExecutorApi = {
			execute: () =>
				Effect.succeed({
					isError: true,
					content: [
						{ type: "text" as const, text: "Tool failed: SQL rejected (MissingOrgFilter)" },
					],
				}),
		}
		const result = await Effect.runPromise(
			Effect.result(handlerFor(executor, "run_sql")({ sql: "select 1" }, {} as never)),
		)
		assert.isTrue(Result.isSuccess(result))
		assert.include(Result.isSuccess(result) ? result.success : "", "MissingOrgFilter")
	})

	it("answers a tool that died with a summary instead of failing the run", async () => {
		const executor: McpToolExecutorApi = {
			execute: () => Effect.die(new Error("connection reset")),
		}
		const result = await Effect.runPromise(
			Effect.result(handlerFor(executor, "list_services")({ limit: 10 }, {} as never)),
		)
		assert.isTrue(Result.isSuccess(result))
		assert.include(Result.isSuccess(result) ? result.success : "", "Tool failed")
	})

	it("records a gated tool's description on its span as the model saw it", async () => {
		const { executor } = countingExecutor()
		const handler = buildMapleToolkit(executor, TENANT, { gate: () => true }).handlers.list_services
		assert.isDefined(handler, "no handler for list_services")
		const { spans, tracer } = makeRecordingTracer()

		await Effect.runPromise(
			Effect.result(handler!({ limit: 10 }, {} as never)).pipe(
				Effect.withSpan("execute_tool list_services"),
				Effect.withTracer(tracer),
			),
		)

		assert.isTrue(String(spans[0]?.attributes.get("gen_ai.tool.description")).endsWith(APPROVAL_NOTE))
	})

	it("refuses the identical call once it has run three times", async () => {
		const { executor, dispatched } = countingExecutor()
		const handler = handlerFor(executor, "list_services")
		const call = () => Effect.runPromise(Effect.result(handler({ limit: 10 }, {} as never)))

		for (let attempt = 0; attempt < 3; attempt += 1) {
			const result = await call()
			assert.isTrue(Result.isSuccess(result), `attempt ${attempt + 1} should have run`)
		}

		// Answered, not failed: a declared failure would end the run, and a model repeating itself
		// needs to be told, not stopped.
		const fourth = await call()
		assert.isTrue(Result.isSuccess(fourth))
		assert.include(Result.isSuccess(fourth) ? fourth.success : "", "already been called")
		assert.equal(dispatched(), 3, "the fourth call must not reach the executor")
	})

	it("counts arguments, not names, so a changed question still runs", async () => {
		const { executor, dispatched } = countingExecutor()
		const handler = handlerFor(executor, "list_services")

		for (let limit = 0; limit < 6; limit += 1) {
			await Effect.runPromise(handler({ limit }, {} as never))
		}

		assert.equal(dispatched(), 6)
	})

	it("counts per build, so the next turn may ask the same question again", async () => {
		const { executor, dispatched } = countingExecutor()

		for (let turn = 0; turn < 4; turn += 1) {
			const handler = handlerFor(executor, "list_services")
			await Effect.runPromise(handler({ limit: 10 }, {} as never))
		}

		assert.equal(dispatched(), 4)
	})
})
