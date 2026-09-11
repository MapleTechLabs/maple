import { testTools } from "../../test/tools"
/**
 * The doom-loop guard.
 *
 * The old turn loop stopped a model that reissued an identical tool batch until its turns ran out.
 * The engine has no equivalent — its `repeatedFailureLimit` counts consecutive tool *failures*,
 * which is a different thing — so the guard lives with the handlers, where refusing is a declared
 * tool failure the model can read rather than an authorization denial that ends the turn.
 */
import { Effect, Result } from "effect"
import { assert, describe, it } from "vitest"
import type { ToolExecutorApi } from "./tool-executor"
import { buildMapleToolkit } from "./llm-tools"

const countingExecutor = () => {
	let dispatched = 0
	const executor: ToolExecutorApi = {
		tools: testTools,
		execute: (name) => {
			dispatched += 1
			return Effect.succeed({ content: [{ type: "text" as const, text: `${name} ran` }] })
		},
	}
	return { executor, dispatched: () => dispatched }
}

const handlerFor = (executor: ToolExecutorApi, name: string) => {
	const built = buildMapleToolkit(executor, {})
	const handler = built.handlers[name]
	assert.isDefined(handler, `no handler for ${name}`)
	return handler!
}

describe("buildMapleToolkit", () => {
	it("refuses the identical call once it has run three times", async () => {
		const { executor, dispatched } = countingExecutor()
		const handler = handlerFor(executor, "list_services")
		const call = () => Effect.runPromise(Effect.result(handler({ limit: 10 })))

		for (let attempt = 0; attempt < 3; attempt += 1) {
			const result = await call()
			assert.isTrue(Result.isSuccess(result), `attempt ${attempt + 1} should have run`)
		}

		assert.isTrue(Result.isFailure(await call()))
		assert.equal(dispatched(), 3, "the fourth call must not reach the executor")
	})

	it("counts arguments, not names, so a changed question still runs", async () => {
		const { executor, dispatched } = countingExecutor()
		const handler = handlerFor(executor, "list_services")

		for (let limit = 0; limit < 6; limit += 1) {
			await Effect.runPromise(handler({ limit }))
		}

		assert.equal(dispatched(), 6)
	})

	it("counts per build, so the next turn may ask the same question again", async () => {
		const { executor, dispatched } = countingExecutor()

		for (let turn = 0; turn < 4; turn += 1) {
			const handler = handlerFor(executor, "list_services")
			await Effect.runPromise(handler({ limit: 10 }))
		}

		assert.equal(dispatched(), 4)
	})
})
