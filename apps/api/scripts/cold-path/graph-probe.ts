// oxlint-disable effecttsgo/strict-effect-provide -- Offline benchmark entry points.
/** Offline probe of the real HTTP graph. No external I/O or production secrets. */
import { Context, Effect, Layer, Scope } from "effect"
import * as Cloudflare from "alchemy/Cloudflare"
import { buildApp, makeFetch } from "../../src/worker/http"
import { offlinePorts } from "../../test/offline-http-ports"
export const build = (graph: "full" | "query" = "full") =>
	Effect.runPromise(buildApp(Context.empty(), offlinePorts, graph, Layer.makeMemoMapUnsafe()))
export const prepareWarm = async (graph: "full" | "query" = "full") => {
	const handler = await build(graph)
	const serve = Cloudflare.Workers.makeRequestHandler(makeFetch(Effect.succeed(handler), offlinePorts))
	return async () => {
		const response = await Effect.runPromise(
			Effect.scoped(
				serve({
					kind: "Cloudflare.Workers.WorkerEvent",
					type: "fetch",
					input: new Request("https://api.test/internal/query-engine/execute-batch", {
						method: "POST",
						headers: {
							authorization: "Bearer maple_ak_rejected",
							"content-type": "application/json",
						},
						body: "{}",
					}),
				}) as Effect.Effect<Response, never, Scope.Scope | Cloudflare.WorkerEnvironment>,
			).pipe(Effect.provide(offlinePorts)),
		)
		if (response.status !== 403) throw new Error(`Expected 403, got ${response.status}`)
		await response.text()
	}
}
export default {}
