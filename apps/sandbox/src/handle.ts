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
import {
	EXECUTOR_DESTROY_PATH,
	EXECUTOR_PREPARE_PATH,
	EXECUTOR_RUN_PATH,
	ExecutorDestroyRequest,
	type ExecutorDestroyResponse,
	ExecutorPrepareRequest,
	type ExecutorPrepareResponse,
	ExecutorRunRequest,
	type ExecutorRunResponse,
	ExecutorUnavailable,
} from "@maple/domain/executor"
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
	/** The run's execution sandbox (`executor.ts`), keyed like `run` by its Durable Object name. */
	readonly executor: {
		readonly prepare: (
			executorKey: string,
			request: typeof ExecutorPrepareRequest.Encoded,
		) => Promise<typeof ExecutorPrepareResponse.Encoded>
		readonly run: (
			executorKey: string,
			request: typeof ExecutorRunRequest.Encoded,
		) => Promise<typeof ExecutorRunResponse.Encoded>
		readonly destroy: (executorKey: string) => Promise<typeof ExecutorDestroyResponse.Encoded>
	}
}

const EXECUTOR_PATHS = new Set([EXECUTOR_PREPARE_PATH, EXECUTOR_RUN_PATH, EXECUTOR_DESTROY_PATH])

const decodeRequest = Schema.decodeUnknownEffect(SandboxExecRequest)
const encodeRequest = Schema.encodeSync(SandboxExecRequest)
const encodeResponse = Schema.encodeUnknownSync(SandboxExecResponse)
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))

const json = (body: unknown, status = 200) =>
	new Response(encodeJson(body), { status, headers: { "content-type": "application/json" } })

export const handle = (request: Request, env: SandboxHandleEnv): Effect.Effect<Response> =>
	Effect.gen(function* () {
		const url = new URL(request.url)
		if (
			(url.pathname !== SANDBOX_EXEC_PATH && !EXECUTOR_PATHS.has(url.pathname)) ||
			request.method !== "POST"
		)
			return new Response("Not found", { status: 404 })
		const outcome = authorize(request.headers.get("authorization"), env.token)
		if (outcome !== "authorized") {
			yield* Effect.logWarning("sandbox request rejected").pipe(
				Effect.annotateLogs({ "maple.sandbox.reason": outcome }),
			)
			return new Response("Unauthorized", { status: 401 })
		}

		if (url.pathname !== SANDBOX_EXEC_PATH) return yield* handleExecutor(url.pathname, request, env)

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

const readJson = (request: Request) =>
	Effect.tryPromise({
		try: () => request.json(),
		// A body that does not parse is reported by the decode that follows.
		catch: () => "unparseable" as const,
	}).pipe(Effect.orElseSucceed(() => undefined))

const decodePrepare = Schema.decodeUnknownEffect(ExecutorPrepareRequest)
const decodeRun = Schema.decodeUnknownEffect(ExecutorRunRequest)
const decodeDestroy = Schema.decodeUnknownEffect(ExecutorDestroyRequest)
const encodePrepare = Schema.encodeSync(ExecutorPrepareRequest)
const encodeRun = Schema.encodeSync(ExecutorRunRequest)
const encodeUnavailable = Schema.encodeSync(ExecutorUnavailable)

/** One executor request, decoded here and answered by the run's Durable Object. */
const handleExecutor = (path: string, request: Request, env: SandboxHandleEnv): Effect.Effect<Response> =>
	Effect.gen(function* () {
		const body = yield* readJson(request)
		// Reaching the Durable Object can fail before it answers; the prepare token must not echo back.
		const call = <A>(executorKey: string, secret: string, invoke: () => Promise<A>) =>
			Effect.tryPromise({
				try: invoke,
				catch: (cause) => (cause instanceof Error ? cause.message : String(cause)),
			}).pipe(
				Effect.catch((message) =>
					Effect.logWarning("executor call failed").pipe(
						Effect.annotateLogs({ "maple.executor.key": executorKey }),
						Effect.as(
							encodeUnavailable(
								new ExecutorUnavailable({
									message: boundMessage(redactSecret(message, secret)),
								}),
							),
						),
					),
				),
				Effect.map(json),
			)
		const invalid = new Response("Invalid executor request", { status: 400 })
		switch (path) {
			case EXECUTOR_PREPARE_PATH: {
				const decoded = yield* decodePrepare(body).pipe(Effect.option)
				if (decoded._tag === "None") return invalid
				const prepare = decoded.value
				return yield* call(prepare.executorKey, prepare.checkout.token, () =>
					env.executor.prepare(prepare.executorKey, encodePrepare(prepare)),
				)
			}
			case EXECUTOR_RUN_PATH: {
				const decoded = yield* decodeRun(body).pipe(Effect.option)
				if (decoded._tag === "None") return invalid
				const run = decoded.value
				return yield* call(run.executorKey, "", () =>
					env.executor.run(run.executorKey, encodeRun(run)),
				)
			}
			default: {
				const decoded = yield* decodeDestroy(body).pipe(Effect.option)
				if (decoded._tag === "None") return invalid
				const key = decoded.value.executorKey
				return yield* call(key, "", () => env.executor.destroy(key))
			}
		}
	})
