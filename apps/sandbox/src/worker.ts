/**
 * The sandbox Worker: the one place Cloudflare's Sandbox Durable Object is
 * hosted, and the only Worker in the fleet whose module is its own bundle entry.
 *
 * That is why this app exists rather than the container living in `apps/api`. A
 * container-backed Durable Object is a class the script must export, and
 * alchemy's Effect-native Workers generate their entry — it exports the bridge
 * classes it created and nothing else, so a third-party class declared in
 * `worker.ts` would never reach the deployed script. A plain module is used
 * verbatim, so `export { Sandbox }` below is what binds.
 *
 * The api reaches this over a service binding and is the only caller: there is
 * no route and no public hostname. It carries the tenant, mints the credential
 * and decides whether to run anything; this Worker owns the container.
 *
 * Everything this Worker decides lives in `handle.ts`, which the SDK's import
 * would otherwise keep out of a test: this module is the SDK, the binding and
 * the runtime, and nothing else.
 */
import { getSandbox, type Sandbox as SandboxClass } from "@cloudflare/sandbox"
import { Effect } from "effect"
import { handle } from "./handle"

export { Sandbox } from "@cloudflare/sandbox"

interface SandboxWorkerEnv {
	readonly Sandbox: DurableObjectNamespace<SandboxClass>
	readonly SANDBOX_INTERNAL_SERVICE_TOKEN?: string
}

/**
 * Idle containers sleep and take their checkouts with them, so a cold call pays
 * the clone again. Ten minutes is Cloudflare's own default and covers the gap
 * between an agent's tool calls without holding compute across investigations.
 */
const SLEEP_AFTER = "10m"

export default {
	fetch: (request: Request, env: SandboxWorkerEnv): Promise<Response> =>
		Effect.runPromise(
			handle(request, {
				token: env.SANDBOX_INTERNAL_SERVICE_TOKEN,
				// Sessionless: every command is a fresh process. The default is one
				// shared, long-lived shell, which carries `set -e` and any `exec` from
				// one command into the next — a `git grep` that matched nothing would
				// kill the session the following call expected to use.
				open: (sandboxKey) =>
					getSandbox(env.Sandbox, sandboxKey, {
						sleepAfter: SLEEP_AFTER,
						enableDefaultSession: false,
					}),
			}).pipe(
				// `handle` answers every request it can read, so a cause reaching here
				// is a bug in the request-shaped part above it — before a token has been
				// decoded, which is why this one says nothing beyond that it happened.
				Effect.catchCause((cause) =>
					Effect.logError("sandbox worker failed", cause).pipe(
						Effect.as(new Response("Sandbox error", { status: 500 })),
					),
				),
			),
		),
}
