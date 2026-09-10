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
 */
import {
	SANDBOX_EXEC_PATH,
	SandboxExecRequest,
	SandboxExecResponse,
	SandboxRunUnavailable,
	boundMessage,
	redactSecret,
} from "@maple/domain/sandbox"
import { getSandbox, type Sandbox as SandboxClass } from "@cloudflare/sandbox"
import { Effect, Schema } from "effect"
import { authorize } from "./auth"
import { runExec } from "./checkout"

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

const decodeRequest = Schema.decodeUnknownEffect(SandboxExecRequest)
const encodeResponse = Schema.encodeUnknownSync(SandboxExecResponse)

const json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

const handle = (request: Request, env: SandboxWorkerEnv) =>
	Effect.gen(function* () {
		const url = new URL(request.url)
		if (url.pathname !== SANDBOX_EXEC_PATH || request.method !== "POST")
			return new Response("Not found", { status: 404 })
		const outcome = authorize(request.headers.get("authorization"), env.SANDBOX_INTERNAL_SERVICE_TOKEN)
		if (outcome !== "authorized") {
			yield* Effect.logWarning("sandbox request rejected").pipe(
				Effect.annotateLogs({ "maple.sandbox.reason": outcome }),
			)
			return new Response("Unauthorized", { status: 401 })
		}

		const body = yield* Effect.tryPromise({
			try: () => request.json() as Promise<unknown>,
			// The only outcome that matters is "not a request this Worker can run",
			// which the decode below reports; the parse failure itself carries nothing.
			catch: () => "unparseable" as const,
		}).pipe(Effect.option)
		const decoded = yield* decodeRequest(body._tag === "Some" ? body.value : undefined).pipe(
			// The two schemas are the same module, so a mismatch here means they drifted
			// across a deploy. Worth a line: the caller only sees "invalid".
			Effect.tapError((error) =>
				Effect.logWarning("sandbox request failed to decode").pipe(
					Effect.annotateLogs({ "error.message": String(error).slice(0, 500) }),
				),
			),
			Effect.option,
		)
		if (decoded._tag === "None") return new Response("Invalid sandbox request", { status: 400 })

		// Sessionless: every command is a fresh process. The default is one shared,
		// long-lived shell, which carries `set -e` and any `exec` from one command
		// into the next — a `git grep` that matched nothing would kill the session
		// the following call expected to use.
		const sandbox = getSandbox(env.Sandbox, decoded.value.sandboxKey, {
			sleepAfter: SLEEP_AFTER,
			enableDefaultSession: false,
		})
		const response = yield* runExec(sandbox, decoded.value).pipe(
			// A container that never came up is the caller's to report, not a 500 here.
			// The container puts the failing command line into its own error messages,
			// so this is one of the paths the clone URL can reach — redact before it
			// leaves the Worker.
			Effect.catchTag("@maple/sandbox/SandboxCallError", (error) =>
				Effect.logWarning("sandbox container call failed").pipe(
					Effect.annotateLogs({ "maple.sandbox.key": decoded.value.sandboxKey }),
					Effect.as(
						new SandboxRunUnavailable({
							message: boundMessage(redactSecret(error.message, decoded.value.checkout.token)),
						}),
					),
				),
			),
		)
		return json(encodeResponse(response))
	})

export default {
	fetch: (request: Request, env: SandboxWorkerEnv): Promise<Response> =>
		Effect.runPromise(
			handle(request, env).pipe(
				// A defect here is a bug in this Worker; without a log it is a bare 500
				// with nothing behind it.
				Effect.catchCause((cause) =>
					Effect.logError("sandbox worker failed", cause).pipe(
						Effect.as(new Response("Sandbox error", { status: 500 })),
					),
				),
			),
		),
}
