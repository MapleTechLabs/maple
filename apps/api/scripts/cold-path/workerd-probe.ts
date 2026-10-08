// oxlint-disable effecttsgo/strict-effect-provide -- Offline Worker entry point.
/** Exercise actual Workers request ownership with only offline ports. */
import * as Cloudflare from "alchemy/Cloudflare"
import { IsolateAge } from "@maple/infra/isolate-age"
import { Context, Effect, Scope } from "effect"
import { makeAppGraphs, makeFetch } from "../../src/worker/http"
import { offlinePorts } from "../../test/offline-http-ports"

const initialize = () =>
	Effect.runPromise(
		Effect.gen(function* () {
			const { app, queryApp } = yield* makeAppGraphs(Context.empty(), offlinePorts)
			return Cloudflare.Workers.makeRequestHandler(yield* makeFetch(app, offlinePorts, queryApp))
		}).pipe(Effect.provide(IsolateAge.layer)),
	)
let initialized: ReturnType<typeof initialize> | undefined
export default {
	async fetch(request: Request) {
		const serve = await (initialized ??= initialize())
		const response: Effect.Effect<Response, never, Scope.Scope | Cloudflare.WorkerEnvironment> = serve({
			kind: "Cloudflare.Workers.WorkerEvent",
			type: "fetch",
			input: request,
		})!
		return Effect.runPromise(Effect.scoped(response).pipe(Effect.provide(offlinePorts)))
	},
}
