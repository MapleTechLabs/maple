/**
 * The sandbox Worker: the one place Cloudflare's Sandbox Durable Object is
 * hosted, and the only Worker in the fleet whose module is its own bundle entry.
 *
 * That last point is why this app exists at all rather than the container living
 * in `apps/api`. A container-backed Durable Object is a class the script must
 * export, and alchemy's Effect-native Workers generate their entry — it exports
 * the bridge classes it created and nothing else, so a third-party class
 * declared in `worker.ts` would never reach the deployed script. A plain module
 * is used verbatim as the entry, so `export { Sandbox }` below is what binds.
 *
 * The api reaches this over a service binding and is the only caller: there is
 * no route and no public hostname. It carries the tenant, mints the credential
 * and decides whether to run anything; this Worker owns the container.
 */
import {
	SANDBOX_EXEC_PATH,
	SandboxExecRequest,
	SandboxExecResponse,
	SandboxUnavailable,
} from "@maple/domain/sandbox"
import { getSandbox, type Sandbox as SandboxClass } from "@cloudflare/sandbox"
import { Effect, Schema } from "effect"
import { runExec, type SandboxLike } from "./checkout"

export { Sandbox } from "@cloudflare/sandbox"

interface SandboxWorkerEnv {
	readonly Sandbox: DurableObjectNamespace<SandboxClass>
	readonly INTERNAL_SERVICE_TOKEN?: string
}

/**
 * Idle containers sleep and take their checkouts with them, so a cold call pays
 * the clone again. Ten minutes is Cloudflare's own default and covers the gap
 * between an agent's tool calls without holding compute across investigations.
 */
const SLEEP_AFTER = "10m"

const decodeRequest = Schema.decodeUnknownEffect(SandboxExecRequest)
const encodeResponse = Schema.encodeUnknownSync(SandboxExecResponse)

/** Constant-time compare, so the token cannot be recovered a byte at a time. */
const tokenMatches = (presented: string, expected: string): boolean => {
	if (presented.length !== expected.length) return false
	let diff = 0
	for (let index = 0; index < presented.length; index++)
		diff |= presented.charCodeAt(index) ^ expected.charCodeAt(index)
	return diff === 0
}

const json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

const handle = (request: Request, env: SandboxWorkerEnv) =>
	Effect.gen(function* () {
		const url = new URL(request.url)
		if (url.pathname !== SANDBOX_EXEC_PATH || request.method !== "POST")
			return new Response("Not found", { status: 404 })
		const expected = env.INTERNAL_SERVICE_TOKEN
		const presented = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "")
		if (!expected || !presented || !tokenMatches(presented, expected))
			return new Response("Unauthorized", { status: 401 })

		const body = yield* Effect.tryPromise({
			try: () => request.json() as Promise<unknown>,
			// The only outcome that matters is "not a request this Worker can run",
			// which the decode below reports; the parse failure itself carries nothing.
			catch: () => "unparseable" as const,
		}).pipe(Effect.option)
		const decoded = yield* decodeRequest(body._tag === "Some" ? body.value : undefined).pipe(
			Effect.option,
		)
		if (decoded._tag === "None") return new Response("Invalid sandbox request", { status: 400 })

		const sandbox = getSandbox(env.Sandbox, decoded.value.sandboxKey, { sleepAfter: SLEEP_AFTER })
		const response = yield* runExec(sandbox, decoded.value).pipe(
			// A container that never came up is the caller's to report, not a 500 here.
			Effect.catchTag("@maple/sandbox/SandboxCallError", (error) =>
				Effect.succeed(new SandboxUnavailable({ message: error.message })),
			),
		)
		return json(encodeResponse(response))
	})

export default {
	fetch: (request: Request, env: SandboxWorkerEnv): Promise<Response> =>
		Effect.runPromise(
			handle(request, env).pipe(
				Effect.catchCause(() => Effect.succeed(new Response("Sandbox error", { status: 500 }))),
			),
		),
}
