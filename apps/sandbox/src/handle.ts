/**
 * What the sandbox Worker does with a request before it reaches the repository's Durable Object.
 *
 * Kept apart from `worker.ts`, which needs a Workers runtime, so it can be tested. The Durable
 * Object arrives as `run`; the work itself happens there (`checkout.ts`'s `execute`).
 */
import {
	SANDBOX_EXEC_PATH,
	SandboxExecRequest,
	SandboxExecResponse,
	SandboxRunUnavailable,
	boundMessage,
	redactSecret,
} from "@maple/domain/sandbox"
import { Effect, Schema } from "effect"
import { authorize } from "./auth"
import { SandboxCallError } from "./checkout"

export interface SandboxHandleEnv {
	readonly token: string | undefined
	/**
	 * Hands the encoded request to the repository's Durable Object and resolves its encoded
	 * answer. Throws when no Durable Object is bound, rejects when it cannot be reached.
	 */
	readonly run: (
		sandboxKey: string,
		request: typeof SandboxExecRequest.Encoded,
	) => Promise<typeof SandboxExecResponse.Encoded>
}

const decodeRequest = Schema.decodeUnknownEffect(SandboxExecRequest)
const encodeRequest = Schema.encodeSync(SandboxExecRequest)
const encodeResponse = Schema.encodeUnknownSync(SandboxExecResponse)

const json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

export const handle = (request: Request, env: SandboxHandleEnv): Effect.Effect<Response> =>
	Effect.gen(function* () {
		const url = new URL(request.url)
		if (url.pathname !== SANDBOX_EXEC_PATH || request.method !== "POST")
			return new Response("Not found", { status: 404 })
		const outcome = authorize(request.headers.get("authorization"), env.token)
		if (outcome !== "authorized") {
			yield* Effect.logWarning("sandbox request rejected").pipe(
				Effect.annotateLogs({ "maple.sandbox.reason": outcome }),
			)
			return new Response("Unauthorized", { status: 401 })
		}

		const body = yield* Effect.tryPromise({
			try: () => request.json(),
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

		const exec = decoded.value
		const redact = (text: string) => boundMessage(redactSecret(text, exec.checkout.token))

		// A Durable Object call crosses the network and is retried by nobody here. Its errors can
		// echo the failing command line, so the clone token is redacted before anything leaves.
		const response = yield* Effect.tryPromise({
			try: () => env.run(exec.sandboxKey, encodeRequest(exec)),
			catch: (cause) =>
				new SandboxCallError({
					message: cause instanceof Error ? cause.message : "the sandbox did not answer",
					cause,
				}),
		}).pipe(
			Effect.catch((error) =>
				Effect.logWarning("sandbox container call failed").pipe(
					Effect.annotateLogs({ "maple.sandbox.key": exec.sandboxKey }),
					Effect.as(encodeResponse(new SandboxRunUnavailable({ message: redact(error.message) }))),
				),
			),
		)
		return json(response)
	})
