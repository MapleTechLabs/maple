/**
 * The deployed Worker's entry, as a plain module.
 *
 * `Cloudflare.Website.Vite` builds this through the Cloudflare Vite plugin and
 * deploys it as the Worker, which is why it is a module rather than the Effect
 * implementation the Worker class used to carry as its third argument: a vite
 * source owns the entry, and that argument has nowhere to go.
 *
 * Nothing was lost in the move. The handler was already a plain async function
 * in `./handler`, and the Effect wrapper around it only unwrapped the request,
 * read three bindings off the environment and converted the response back.
 */
import * as MapleCloudflareSDK from "@maple-dev/effect-sdk/cloudflare"
import { Effect } from "effect"
import { handleRequest } from "./handler"
import type { WebWorkerEnv } from "./worker-env"

const telemetry = MapleCloudflareSDK.make({
	serviceName: "maple-web-worker",
	serviceNamespace: "core",
	repositoryUrl: "https://github.com/MapleTechLabs/maple",
})

interface ExecutionContext {
	readonly waitUntil: (promise: Promise<unknown>) => void
}

export default {
	fetch: (request: Request, env: WebWorkerEnv, ctx: ExecutionContext): Promise<Response> =>
		handleRequest(request, env, (effect) =>
			Effect.runPromise(effect.pipe(Effect.provide(telemetry.layer))).finally(() =>
				ctx.waitUntil(telemetry.flush(env)),
			),
		),
}
