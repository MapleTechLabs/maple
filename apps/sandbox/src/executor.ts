/**
 * The execution sandbox's Durable Object and its registry gateway. One executor per security audit
 * run: `prepare`, `run` and `destroy` (`executor-session.ts`), plus the platform probe
 * (`executor-run.ts`) on the cron. This module implements their ports over `ctx.container` and
 * `ctx.storage`.
 */
import {
	ExecutorPrepareRequest,
	ExecutorPrepareResponse,
	ExecutorRunRequest,
	ExecutorRunResponse,
	ExecutorDestroyResponse,
	ExecutorUnavailable,
} from "@maple/domain/executor"
import { DurableObject, WorkerEntrypoint } from "cloudflare:workers"
import { Effect, Schema, Semaphore, String as Str } from "effect"
import { type GatewayProps, gatewayFetch } from "./executor-gateway"
import { EXECUTOR_PROBE_VERSION, GATEWAY_HOST, GATEWAY_TLS_HOST } from "./executor-probe"
import { type ExecutorContainer, type ExecutorProbeReport, probeOnce } from "./executor-run"
import { type ExecutorHost, destroy, prepare, run } from "./executor-session"

/** What the container's intercepted host reaches (`executor-gateway.ts`). */
export class RegistryGateway extends WorkerEntrypoint<unknown, GatewayProps> {
	override fetch(request: Request): Promise<Response> {
		return Effect.runPromise(gatewayFetch(request, this.ctx.props, (upstream) => fetch(upstream)))
	}
}

const REPORT_KEY = `probe:v${EXECUTOR_PROBE_VERSION}`

/**
 * Outlasts reconnaissance and synthesis (no commands, up to 30 minutes after prepare) and agents'
 * pauses; the run destroys its executor when it ends.
 */
const INACTIVITY_TIMEOUT_MS = 90 * 60 * 1000

/** Commands from one run's agents at once. The instance has one vCPU; the rest queue. */
const CONCURRENT_COMMANDS = 3

const decoder = new TextDecoder()

/** `exec()` passes on only `PATH`; the scripts expect the rest of what a login shell had. */
const EXEC_ENV = { HOME: "/root", LANG: "C.UTF-8" }

const message = (cause: unknown) => Str.slice(0, 500)(cause instanceof Error ? cause.message : String(cause))

const attempt = <A>(run: () => Promise<A>) => Effect.tryPromise({ try: run, catch: message })

const decodePrepare = Schema.decodeEffect(ExecutorPrepareRequest)
const decodeRun = Schema.decodeEffect(ExecutorRunRequest)
const encodePrepare = Schema.encodeSync(ExecutorPrepareResponse)
const encodeRun = Schema.encodeSync(ExecutorRunResponse)
const encodeDestroy = Schema.encodeSync(ExecutorDestroyResponse)

const unreadable = new ExecutorUnavailable({ message: "the executor could not read the request" })

export interface ExecutorEnv {
	readonly Executor: DurableObjectNamespace<Executor>
}

/** The probe's container port over `ctx.container`. */
const probePort = (container: Container, gateway: Fetcher): ExecutorContainer => ({
	isRunning: () => container.running,
	start: attempt(async () => {
		container.start({ enableInternet: false })
		await container.setInactivityTimeout(5 * 60 * 1000)
	}),
	exec: (command, timeoutMs) =>
		attempt(async () => {
			const process = await container.exec(["bash", "-c", command], {
				env: EXEC_ENV,
				signal: AbortSignal.timeout(timeoutMs),
			})
			const output = await process.output()
			return { exitCode: output.exitCode, stdout: decoder.decode(output.stdout) }
		}),
	interceptHttp: attempt(() => container.interceptOutboundHttp(GATEWAY_HOST, gateway)),
	interceptHttps: attempt(() => container.interceptOutboundHttps(GATEWAY_TLS_HOST, gateway)),
	snapshot: attempt(() =>
		container.snapshotContainer({ name: `executor-probe-v${EXECUTOR_PROBE_VERSION}` }),
	),
	destroy: attempt(() => container.destroy()).pipe(Effect.ignore),
})

export class Executor extends DurableObject<ExecutorEnv> {
	/** The credential the gateway route was registered with, for this container's life. */
	private interceptedFor: string | undefined
	private readonly commands = Semaphore.makeUnsafe(CONCURRENT_COMMANDS)

	/** Runs the probe unless this version already has a complete report (`probeOnce`). */
	async probe(): Promise<void> {
		const storage = this.ctx.storage
		const container = this.ctx.container
		return Effect.runPromise(
			probeOnce(
				{
					has: attempt(() => storage.get<ExecutorProbeReport>(REPORT_KEY)).pipe(
						Effect.map((stored) => stored !== undefined),
					),
					put: (report) => attempt(() => storage.put(REPORT_KEY, report)),
				},
				container && probePort(container, this.ctx.exports.RegistryGateway({ props: {} })),
				Date.now(),
			),
		)
	}

	async prepare(
		request: typeof ExecutorPrepareRequest.Encoded,
	): Promise<typeof ExecutorPrepareResponse.Encoded> {
		return Effect.runPromise(
			decodePrepare(request).pipe(
				Effect.flatMap((decoded) => prepare(this.host, decoded)),
				Effect.orElseSucceed(() => unreadable),
				Effect.map(encodePrepare),
			),
		)
	}

	async run(request: typeof ExecutorRunRequest.Encoded): Promise<typeof ExecutorRunResponse.Encoded> {
		return Effect.runPromise(
			decodeRun(request).pipe(
				Effect.flatMap((decoded) =>
					this.commands.withPermits(1)(run(this.host, decoded, crypto.randomUUID())),
				),
				Effect.orElseSucceed(() => unreadable),
				Effect.map(encodeRun),
			),
		)
	}

	async destroy(): Promise<typeof ExecutorDestroyResponse.Encoded> {
		return Effect.runPromise(destroy(this.host).pipe(Effect.map(encodeDestroy)))
	}

	/** The bound container, or why there is none. */
	private withContainer<A>(use: (container: Container) => Promise<A>): Effect.Effect<A, string> {
		const container = this.ctx.container
		return container === undefined
			? Effect.fail("no container is bound to this Durable Object")
			: attempt(() => use(container))
	}

	private readonly host: ExecutorHost = {
		isRunning: () => this.ctx.container?.running === true,
		ensureStarted: (gateway) =>
			this.withContainer(async (container) => {
				if (!container.running) {
					container.start({ enableInternet: false })
					this.interceptedFor = undefined
				}
				await container.setInactivityTimeout(INACTIVITY_TIMEOUT_MS)
				// Registered again when the credential changes: the gateway's props carry it.
				const token = gateway.git?.token ?? ""
				if (this.interceptedFor !== token) {
					await container.interceptOutboundHttp(
						GATEWAY_HOST,
						this.ctx.exports.RegistryGateway({ props: gateway }),
					)
					this.interceptedFor = token
				}
			}),
		exec: (script, timeoutMs) =>
			this.withContainer(async (container) => {
				const started = Date.now()
				const process = await container.exec(["bash", "-c", script], {
					env: EXEC_ENV,
					signal: AbortSignal.timeout(timeoutMs),
				})
				const output = await process.output()
				return {
					exitCode: output.exitCode,
					stdout: decoder.decode(output.stdout),
					stderr: decoder.decode(output.stderr),
					durationMs: Date.now() - started,
				}
			}),
		// Ignored output is what lets the process outlive this request.
		spawn: (script) =>
			this.withContainer((container) =>
				container.exec(["bash", "-c", script], { env: EXEC_ENV, stdout: "ignore", stderr: "ignore" }),
			).pipe(Effect.asVoid),
		destroy: this.withContainer(async (container) => {
			this.interceptedFor = undefined
			if (container.running) await container.destroy()
		}),
	}
}

/** Runs the probe once per probe version; the Durable Object logs the report. */
export const runExecutorProbe = (env: ExecutorEnv): Effect.Effect<void> =>
	attempt(() => env.Executor.getByName(`probe-v${EXECUTOR_PROBE_VERSION}`).probe()).pipe(
		Effect.catch((error) =>
			Effect.logWarning("executor probe failed").pipe(Effect.annotateLogs({ "error.message": error })),
		),
	)
