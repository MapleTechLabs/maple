/**
 * The consuming Worker's half of the sandbox service binding — maple-ai's, whose
 * agents run the sandbox tools.
 *
 * The sandbox Worker owns Cloudflare's Sandbox Durable Object and the container
 * behind it; this is the only way to reach it. The binding is absent on a
 * deployment that did not provision one, which is a first-class answer rather
 * than a crash: the tools then report that no sandbox is available.
 */
import {
	SANDBOX_EXEC_PATH,
	SandboxExecRequest,
	SandboxExecResponse,
	type SandboxExecResponse as SandboxExecResponseType,
} from "@maple/domain/sandbox"
import * as Cloudflare from "alchemy/Cloudflare"
import { Context, Effect, Layer, Option, Redacted, Schema } from "effect"
import { HttpClientRequest } from "effect/http"
import { SandboxFetcher } from "@maple/backend/platform/bindings"
import { Env } from "@maple/backend/platform/Env"

export class SandboxClientError extends Schema.TaggedError<SandboxClientError>()(
	"@maple/api/sandbox/SandboxClientError",
	{ message: Schema.String, cause: Schema.optionalKey(Schema.Defect()) },
) {}

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
			const binding = Option.flatten(yield* Effect.serviceOption(SandboxFetcher))
			const config = yield* Env
			const token = Option.map(config.SANDBOX_INTERNAL_SERVICE_TOKEN, Redacted.value)

			// Decided once, at build: both values are fixed for the isolate's life, and
			// a deployment missing either turns four agent tools off for good. Without
			// a line here the only trace of that is a sentence in a model's tool result.
			if (Option.isNone(binding) || Option.isNone(token)) {
				yield* Effect.logWarning("repository sandbox is not available").pipe(
					Effect.annotateLogs({
						"maple.sandbox.reason": Option.isSome(binding)
							? "SANDBOX_INTERNAL_SERVICE_TOKEN is not configured"
							: "no SANDBOX service binding on this deployment",
					}),
				)
				return { exec: () => Effect.succeedNone } satisfies SandboxClientApi
			}

			const httpClient = Cloudflare.toHttpClient(Cloudflare.fromCloudflareFetcher(binding.value))
			const toClientError = (message: string) => (cause: unknown) =>
				new SandboxClientError({ message, cause })

			const exec: SandboxClientApi["exec"] = Effect.fn("SandboxClient.exec")(function* (request) {
				// The origin is a formality on a service binding, which routes by binding rather than by host.
				const response = yield* httpClient
					.execute(
						HttpClientRequest.post(`https://sandbox.internal${SANDBOX_EXEC_PATH}`).pipe(
							HttpClientRequest.bearerToken(token.value),
							HttpClientRequest.bodyJsonUnsafe(encodeRequest(request)),
						),
					)
					.pipe(Effect.mapError(toClientError("the sandbox worker did not answer")))
				if (response.status < 200 || response.status >= 300) {
					// A body that fails to read should only cost the detail, not the whole call.
					const detail = yield* response.text.pipe(Effect.orElseSucceed(() => ""))
					return yield* new SandboxClientError({
						message: `the sandbox worker answered ${response.status}${detail ? `: ${detail.slice(0, 300)}` : ""}`,
					})
				}
				const body = yield* response.json.pipe(
					Effect.mapError(toClientError("the sandbox worker returned invalid JSON")),
				)
				return Option.some(
					yield* decodeResponse(body).pipe(
						Effect.mapError(toClientError("the sandbox worker returned an unexpected payload")),
					),
				)
			})

			return { exec } satisfies SandboxClientApi
		}),
	},
) {
	static readonly layer = Layer.effect(this, this.make)
}
