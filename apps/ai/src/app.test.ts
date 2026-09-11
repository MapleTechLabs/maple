import { Effect } from "effect"
import { expect, it } from "vitest"
import { fetch } from "./app"

it("answers /health before any service graph exists", async () => {
	// The point of the check: it must not depend on the layer graph, the database,
	// or a binding. A health endpoint that builds the graph reports the graph's
	// health, which is the thing most likely to be broken when you ask.
	const response = await Effect.runPromise(fetch)
	expect(response.status).toBe(200)
})
