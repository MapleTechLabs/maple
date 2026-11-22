/**
 * The Acme world, live: the engine started and seeded, and the app's MCP services pointed at it.
 * Shared by the golden test and the model eval, so both read the same rows through the same tools.
 */
import { Effect, Exit, Scope } from "effect"
import { FetchHttpClient } from "effect/http"
import { makeEvalRuntime, type EvalRuntime } from "../../mcp/__evals__/eval-runtime"
import { restoreWarehouse } from "../../mcp/__evals__/fake-warehouse"
import { FIXTURES } from "../../mcp/__evals__/utils"
import { startChdbWarehouse } from "./chdb-warehouse"
import { productScenarios, type Scenario } from "./scenarios"
import { makeWorld, type World, worldInserts } from "./world"

export interface ProductWorld {
	readonly rt: EvalRuntime
	readonly world: World
	readonly scenarios: ReadonlyArray<Scenario>
	readonly dispose: () => Promise<void>
}

export const startProductWorld = async (): Promise<ProductWorld> => {
	const scope = Scope.makeUnsafe()
	const world = makeWorld(Date.now())
	await Effect.runPromise(
		Effect.gen(function* () {
			const warehouse = yield* startChdbWarehouse
			yield* Effect.forEach(worldInserts(world, FIXTURES.orgId), (insert) => warehouse.exec(insert), {
				discard: true,
			})
		}).pipe(
			Scope.provide(scope),
			// Starting the suite's world is an entry point: the client is built for it.
			Effect.provide(FetchHttpClient.layer),
		),
	)
	const rt = makeEvalRuntime()
	return {
		rt,
		world,
		scenarios: productScenarios(world),
		dispose: async () => {
			restoreWarehouse()
			await rt.dispose()
			await Effect.runPromise(Scope.close(scope, Exit.void))
		},
	}
}
