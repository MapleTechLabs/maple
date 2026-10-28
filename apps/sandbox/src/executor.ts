/**
 * The execution sandbox's Durable Object and its registry gateway. Today it only runs the platform
 * probe: the checks are `executor-probe.ts`, the orchestration `executor-run.ts`, and this module
 * implements its ports over `ctx.container` and `ctx.storage`.
 */
import { DurableObject, WorkerEntrypoint } from "cloudflare:workers"
import { Effect } from "effect"
import { EXECUTOR_PROBE_VERSION, GATEWAY_HOST, GATEWAY_MARKER, GATEWAY_TLS_HOST } from "./executor-probe"
import { type ExecutorContainer, type ExecutorProbeReport, probeOnce } from "./executor-run"

/**
 * What the container's intercepted hosts reach. The probe only needs to recognise the answer; the
 * registry proxy (allowlist, read-only, credentials added here) replaces this body.
 */
export class RegistryGateway extends WorkerEntrypoint {
	override fetch(request: Request): Response {
		const url = new URL(request.url)
		return new Response(`${GATEWAY_MARKER} ${request.method} ${url.host}${url.pathname}`)
	}
}

const REPORT_KEY = `probe:v${EXECUTOR_PROBE_VERSION}`

const decoder = new TextDecoder()

const message = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause)).slice(0, 500)

const attempt = <A>(run: () => Promise<A>) => Effect.tryPromise({ try: run, catch: message })

export interface ExecutorEnv {
	readonly Executor: DurableObjectNamespace<Executor>
}

/** The probe's container port over `ctx.container`. */
const containerPort = (container: Container, gateway: Fetcher): ExecutorContainer => ({
	isRunning: () => container.running,
	start: attempt(async () => {
		container.start({ enableInternet: false })
		await container.setInactivityTimeout(5 * 60 * 1000)
	}),
	exec: (command, timeoutMs) =>
		attempt(async () => {
			const process = await container.exec(["bash", "-c", command], {
				env: { HOME: "/root", LANG: "C.UTF-8" },
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
				container && containerPort(container, this.ctx.exports.RegistryGateway({ props: {} })),
				Date.now(),
			),
		)
	}
}

/** Runs the probe once per probe version; the Durable Object logs the report. */
export const runExecutorProbe = (env: ExecutorEnv): Effect.Effect<void> =>
	attempt(() => env.Executor.getByName(`probe-v${EXECUTOR_PROBE_VERSION}`).probe()).pipe(
		Effect.catch((error) =>
			Effect.logWarning("executor probe failed").pipe(Effect.annotateLogs({ "error.message": error })),
		),
	)
