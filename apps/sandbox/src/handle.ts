/**
 * What the sandbox Worker does with a request, minus the Sandbox SDK.
 *
 * Kept apart from `worker.ts` for the same reason `auth.ts` and `checkout.ts`
 * are: that module imports Cloudflare's Sandbox SDK, which cannot be loaded
 * outside a Workers runtime, and everything below has to be testable. The
 * container arrives as `open`, a function that hands back the port `checkout.ts`
 * already works against.
 */
import {
	SANDBOX_EXEC_PATH,
	SandboxExecRequest,
	SandboxExecResponse,
	SandboxRunUnavailable,
	boundMessage,
	redactSecret,
} from "@maple/domain/sandbox"
import { Cause, Effect, Schema } from "effect"
import { authorize } from "./auth"
import { SandboxCallError, type SandboxLike, runExec } from "./checkout"

export interface SandboxHandleEnv {
	readonly token: string | undefined
	/** Throws when no container is bound or the SDK refuses the key. */
	readonly open: (sandboxKey: string) => SandboxLike
}

const decodeRequest = Schema.decodeUnknownEffect(SandboxExecRequest)
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

		const exec = decoded.value
		const redact = (text: string) => boundMessage(redactSecret(text, exec.checkout.token))

		const response = yield* Effect.gen(function* () {
			// Reaching the container is the one step that throws rather than rejects:
			// an absent binding fails inside the SDK's own `idFromName`. Left unguarded
			// it was a defect, and a defect here was a bare 500 the caller could not act
			// on — the same answer a working container that refused the key would give.
			const sandbox = yield* Effect.try({
				try: () => env.open(exec.sandboxKey),
				catch: (cause) =>
					new SandboxCallError({
						message:
							cause instanceof Error ? cause.message : "no container is bound to this Worker",
						cause,
					}),
			})
			return yield* runExec(sandbox, exec)
		}).pipe(
			// A container that never came up is the caller's to report, not a 500 here.
			// The container puts the failing command line into its own error messages,
			// so this is one of the paths the clone URL can reach — redact before it
			// leaves the Worker.
			Effect.catchTag("@maple/sandbox/SandboxCallError", (error) =>
				Effect.logWarning("sandbox container call failed").pipe(
					Effect.annotateLogs({ "maple.sandbox.key": exec.sandboxKey }),
					Effect.as(new SandboxRunUnavailable({ message: redact(error.message) })),
				),
			),
			// Anything left is a bug in this Worker, and this Worker's logs are the
			// only place it was ever written down. Say what broke in the answer too:
			// a cause can carry the clone credential, so it goes out redacted.
			Effect.catchCause((cause) =>
				Effect.logError("sandbox worker failed", cause).pipe(
					Effect.annotateLogs({ "maple.sandbox.key": exec.sandboxKey }),
					Effect.as(
						new SandboxRunUnavailable({
							message: redact(`the sandbox worker failed: ${Cause.pretty(cause)}`),
						}),
					),
				),
			),
		)
		return json(encodeResponse(response))
	})
