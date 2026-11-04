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
import * as Cloudflare from "@alchemy.run/cloudflare"
import {
	EXECUTOR_DESTROY_PATH,
	EXECUTOR_PREPARE_PATH,
	EXECUTOR_RELEASE_PATH,
	EXECUTOR_RUN_PATH,
	ExecutorDestroyRequest,
	ExecutorDestroyResponse,
	ExecutorPrepareRequest,
	ExecutorPrepareResponse,
	ExecutorReleaseRequest,
	ExecutorReleaseResponse,
	ExecutorRunRequest,
	ExecutorRunResponse,
} from "@maple/domain/executor"
import { Context, Effect, Layer, Option, Redacted, Schema } from "effect"
import { HttpClientRequest } from "effect/http"
import { SandboxFetcher } from "@maple/backend/platform/bindings"
import { Env } from "@maple/backend/platform/Env"

export class SandboxClientError extends Schema.TaggedError<SandboxClientError>()(
	"@maple/backend/sandbox/SandboxClientError",
	{ message: Schema.String, cause: Schema.optionalKey(Schema.Defect()) },
) {}

/** Each answers `Option.none` when this deployment has no sandbox Worker bound. */
export interface SandboxClientApi {
	readonly exec: (
		request: SandboxExecRequest,
	) => Effect.Effect<Option.Option<SandboxExecResponseType>, SandboxClientError>
	/** The security audit's execution sandbox, one per run (`@maple/domain/executor`). */
	readonly executor: ExecutorTransport
}

/** The executor's calls; the local runner answers the same wire over HTTP. */
export interface ExecutorTransport {
	/** False on a deployment without a sandbox Worker: every call then answers `Option.none`. */
	readonly available: boolean
	readonly prepare: (
		request: ExecutorPrepareRequest,
	) => Effect.Effect<Option.Option<ExecutorPrepareResponse>, SandboxClientError>
	readonly run: (
		request: ExecutorRunRequest,
	) => Effect.Effect<Option.Option<ExecutorRunResponse>, SandboxClientError>
	readonly release: (
		request: ExecutorReleaseRequest,
	) => Effect.Effect<Option.Option<ExecutorReleaseResponse>, SandboxClientError>
	readonly destroy: (
		request: ExecutorDestroyRequest,
	) => Effect.Effect<Option.Option<ExecutorDestroyResponse>, SandboxClientError>
}

const encodeRequest = Schema.encodeUnknownSync(SandboxExecRequest)

const encodePrepare = Schema.encodeUnknownSync(ExecutorPrepareRequest)
const encodeRun = Schema.encodeUnknownSync(ExecutorRunRequest)
const encodeRelease = Schema.encodeUnknownSync(ExecutorReleaseRequest)
const encodeDestroy = Schema.encodeUnknownSync(ExecutorDestroyRequest)

const unbound: ExecutorTransport = {
	available: false,
	prepare: () => Effect.succeedNone,
	run: () => Effect.succeedNone,
	release: () => Effect.succeedNone,
	destroy: () => Effect.succeedNone,
}

export class SandboxClient extends Context.Service<SandboxClient, SandboxClientApi>()(
	"@maple/backend/sandbox/SandboxClient",
	{
		make: Effect.gen(function* () {
			const bindingOption = yield* Effect.serviceOption(SandboxFetcher)
			const binding = Option.flatten(bindingOption)
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
				return { exec: () => Effect.succeedNone, executor: unbound } satisfies SandboxClientApi
			}

			const httpClient = Cloudflare.toHttpClient(Cloudflare.fromCloudflareFetcher(binding.value))
			const toClientError = (message: string) => (cause: unknown) =>
				new SandboxClientError({ message, cause })

			const post = <Body, A>(path: string, body: Body, answer: Schema.Decoder<A>) =>
				Effect.gen(function* () {
					// The origin is a formality on a service binding, which routes by binding rather than by host.
					const response = yield* httpClient
						.execute(
							HttpClientRequest.post(`https://sandbox.internal${path}`).pipe(
								HttpClientRequest.bearerToken(token.value),
								HttpClientRequest.bodyJsonUnsafe(body),
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
					const json = yield* response.json.pipe(
						Effect.mapError(toClientError("the sandbox worker returned invalid JSON")),
					)
					const decoded = yield* Schema.decodeEffect(answer)(json).pipe(
						Effect.mapError(toClientError("the sandbox worker returned an unexpected payload")),
					)
					return Option.some(decoded)
				})

			const exec: SandboxClientApi["exec"] = Effect.fn("SandboxClient.exec")(function* (request) {
				return yield* post(SANDBOX_EXEC_PATH, encodeRequest(request), SandboxExecResponse)
			})

			const executor: ExecutorTransport = {
				available: true,
				prepare: Effect.fn("SandboxClient.executor.prepare")(function* (request) {
					return yield* post(EXECUTOR_PREPARE_PATH, encodePrepare(request), ExecutorPrepareResponse)
				}),
				run: Effect.fn("SandboxClient.executor.run")(function* (request) {
					return yield* post(EXECUTOR_RUN_PATH, encodeRun(request), ExecutorRunResponse)
				}),
				release: Effect.fn("SandboxClient.executor.release")(function* (request) {
					return yield* post(EXECUTOR_RELEASE_PATH, encodeRelease(request), ExecutorReleaseResponse)
				}),
				destroy: Effect.fn("SandboxClient.executor.destroy")(function* (request) {
					return yield* post(EXECUTOR_DESTROY_PATH, encodeDestroy(request), ExecutorDestroyResponse)
				}),
			}

			return { exec, executor } satisfies SandboxClientApi
		}),
	},
) {
	static readonly layer = Layer.effect(this, this.make)
}
