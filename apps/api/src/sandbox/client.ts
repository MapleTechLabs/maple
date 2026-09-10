/**
 * The api's half of the sandbox service binding.
 *
 * The sandbox Worker owns Cloudflare's Sandbox Durable Object and the container
 * behind it; this is the only way the api reaches it. The binding is absent on a
 * deployment that did not provision one, which is a first-class answer rather
 * than a crash: the tools then report that no sandbox is available.
 */
import {
	SANDBOX_EXEC_PATH,
	SandboxExecRequest,
	SandboxExecResponse,
	type SandboxExecResponse as SandboxExecResponseType,
} from "@maple/domain/sandbox"
import { WorkerEnvironment } from "@maple/infra/worker-runtime"
import { Context, Effect, Layer, Option, Redacted, Schema } from "effect"
import { Env } from "@/platform/Env"

export const SANDBOX_BINDING = "SANDBOX"

export class SandboxClientError extends Schema.TaggedError<SandboxClientError>()(
	"@maple/api/sandbox/SandboxClientError",
	{ message: Schema.String, cause: Schema.optionalKey(Schema.Defect()) },
) {}

/** The service binding as the client uses it: a Worker-to-Worker `fetch`. */
interface ServiceBinding {
	readonly fetch: (request: Request) => Promise<Response>
}

const isServiceBinding = (value: unknown): value is ServiceBinding =>
	typeof value === "object" && value !== null && typeof (value as ServiceBinding).fetch === "function"

export interface SandboxClientApi {
	/** `Option.none` when this deployment has no sandbox Worker bound. */
	readonly exec: (
		request: SandboxExecRequest,
	) => Effect.Effect<Option.Option<SandboxExecResponseType>, SandboxClientError>
}

const encodeRequest = Schema.encodeUnknownSync(SandboxExecRequest)
const decodeResponse = Schema.decodeUnknownEffect(SandboxExecResponse)

export class SandboxClient extends Context.Service<SandboxClient, SandboxClientApi>()(
	"@maple/api/sandbox/SandboxClient",
	{
		make: Effect.gen(function* () {
			const env = yield* WorkerEnvironment
			const config = yield* Env
			const binding = env[SANDBOX_BINDING]
			const token = Option.map(config.INTERNAL_SERVICE_TOKEN, Redacted.value)

			const exec: SandboxClientApi["exec"] = Effect.fn("SandboxClient.exec")(function* (request) {
				if (!isServiceBinding(binding) || Option.isNone(token)) return Option.none()
				// The absolute URL is a formality on a service binding, which routes by
				// binding rather than by host, but `Request` requires one.
				const response = yield* Effect.tryPromise({
					try: () =>
						binding.fetch(
							new Request(`https://sandbox.internal${SANDBOX_EXEC_PATH}`, {
								method: "POST",
								headers: {
									authorization: `Bearer ${token.value}`,
									"content-type": "application/json",
								},
								body: JSON.stringify(encodeRequest(request)),
							}),
						),
					catch: (cause) =>
						new SandboxClientError({
							message:
								cause instanceof Error ? cause.message : "the sandbox worker did not answer",
							cause,
						}),
				})
				if (!response.ok) {
					const detail = yield* Effect.promise(() => response.text()).pipe(
						Effect.orElseSucceed(() => ""),
					)
					return yield* new SandboxClientError({
						message: `the sandbox worker answered ${response.status}${detail ? `: ${detail.slice(0, 300)}` : ""}`,
					})
				}
				const body = yield* Effect.tryPromise({
					try: () => response.json() as Promise<unknown>,
					catch: (cause) =>
						new SandboxClientError({
							message: "the sandbox worker returned invalid JSON",
							cause,
						}),
				})
				return Option.some(
					yield* decodeResponse(body).pipe(
						Effect.mapError(
							(cause) =>
								new SandboxClientError({
									message: "the sandbox worker returned an unexpected payload",
									cause,
								}),
						),
					),
				)
			})

			return { exec } satisfies SandboxClientApi
		}),
	},
) {
	static readonly layer = Layer.effect(this, this.make)
}
