/**
 * The execution sandbox's Durable Object and its registry gateway. Today it only runs the platform
 * probe (`executor-probe.ts`): one container started with `enableInternet: false`, the gateway
 * intercepted on a made-up host, every check run once per probe version, the report kept in
 * storage and logged. The audit's execution environment is built on what the report proves.
 */
import { DurableObject, WorkerEntrypoint } from "cloudflare:workers"
import { Duration, Effect } from "effect"
import {
	type AssessedCheck,
	EXECUTOR_PROBE_VERSION,
	GATEWAY_HOST,
	GATEWAY_MARKER,
	GATEWAY_TLS_HOST,
	assessProbe,
	parseProbe,
	probeScript,
} from "./executor-probe"

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

/** One step of the probe: what it took, or why it failed. */
export interface ProbeStep {
	readonly ok: boolean
	readonly ms: number
	readonly error?: string
	readonly detail?: string
}

export interface ExecutorProbeReport {
	readonly version: number
	readonly ranAt: number
	/** `container.start({ enableInternet: false })` and the first exec answering. */
	readonly start: ProbeStep
	readonly interceptHttp: ProbeStep
	readonly interceptHttps: ProbeStep
	readonly checks: ReadonlyArray<AssessedCheck>
	/** `snapshotContainer()`: the dependency cache's fast path, if the scheduling policy allows it. */
	readonly containerSnapshot: ProbeStep
}

const REPORT_KEY = `probe:v${EXECUTOR_PROBE_VERSION}`

/** The whole probe script's deadline; each check has its own 20s inside it. */
const PROBE_TIMEOUT_MS = 10 * 60 * 1000

const decoder = new TextDecoder()

const message = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause)).slice(0, 500)

/** Runs `run`, timing it; a rejection becomes a failed step instead of failing the probe. */
const step = <A>(run: () => Promise<A>, detail?: (value: A) => string) =>
	Effect.tryPromise({ try: run, catch: message }).pipe(
		Effect.timed,
		Effect.map(([elapsed, value]): ProbeStep => {
			const done = { ok: true, ms: Duration.toMillis(elapsed) }
			return detail === undefined ? done : { ...done, detail: detail(value) }
		}),
		Effect.catch((error) => Effect.succeed<ProbeStep>({ ok: false, ms: 0, error })),
	)

const notRun: ProbeStep = { ok: false, ms: 0, error: "not run: the container did not start" }

export interface ExecutorEnv {
	readonly Executor: DurableObjectNamespace<Executor>
}

export class Executor extends DurableObject<ExecutorEnv> {
	/**
	 * The stored report for this probe version, or a fresh run. `fresh` says whether this call ran
	 * it, so the caller logs each report once.
	 */
	async probe(): Promise<{ readonly report: ExecutorProbeReport; readonly fresh: boolean }> {
		const stored = await this.ctx.storage.get<ExecutorProbeReport>(REPORT_KEY)
		if (stored !== undefined) return { report: stored, fresh: false }
		const report = await Effect.runPromise(this.runProbe())
		// A run whose container never answered says nothing about the platform: try again next tick.
		if (report.start.ok) await this.ctx.storage.put(REPORT_KEY, report)
		return { report, fresh: true }
	}

	private runProbe(): Effect.Effect<ExecutorProbeReport> {
		const ctx = this.ctx
		return Effect.gen(function* () {
			const ranAt = Date.now()
			const container = ctx.container
			if (container === undefined)
				return {
					version: EXECUTOR_PROBE_VERSION,
					ranAt,
					start: { ok: false, ms: 0, error: "no container is bound to this Durable Object" },
					interceptHttp: notRun,
					interceptHttps: notRun,
					checks: [],
					containerSnapshot: notRun,
				}
			const exec = async (command: string, timeoutMs: number) => {
				const process = await container.exec(["bash", "-c", command], {
					env: { HOME: "/root", LANG: "C.UTF-8" },
					signal: AbortSignal.timeout(timeoutMs),
				})
				const output = await process.output()
				return { exitCode: output.exitCode, stdout: decoder.decode(output.stdout) }
			}
			const destroy = Effect.tryPromise(() => container.destroy()).pipe(Effect.ignore)
			if (container.running) yield* destroy
			const start = yield* step(
				async () => {
					container.start({ enableInternet: false })
					await container.setInactivityTimeout(5 * 60 * 1000)
					return exec("id -u", 60_000)
				},
				(answer) => `exit ${answer.exitCode}`,
			)
			if (!start.ok)
				return {
					version: EXECUTOR_PROBE_VERSION,
					ranAt,
					start,
					interceptHttp: notRun,
					interceptHttps: notRun,
					checks: [],
					containerSnapshot: notRun,
				}
			const gateway = ctx.exports.RegistryGateway({ props: {} })
			const interceptHttp = yield* step(() => container.interceptOutboundHttp(GATEWAY_HOST, gateway))
			const interceptHttps = yield* step(() =>
				container.interceptOutboundHttps(GATEWAY_TLS_HOST, gateway),
			)
			const run = yield* Effect.tryPromise({
				try: () => exec(probeScript(), PROBE_TIMEOUT_MS),
				catch: message,
			}).pipe(Effect.option)
			const checks = assessProbe(run._tag === "Some" ? parseProbe(run.value.stdout) : [])
			const containerSnapshot = yield* step(
				() => container.snapshotContainer({ name: `executor-probe-v${EXECUTOR_PROBE_VERSION}` }),
				(snapshot) => `size ${snapshot.size}`,
			)
			yield* destroy
			return {
				version: EXECUTOR_PROBE_VERSION,
				ranAt,
				start,
				interceptHttp,
				interceptHttps,
				checks,
				containerSnapshot,
			}
		})
	}
}

/** Runs the probe if this version has no report yet, and logs a fresh report one line per check. */
export const runExecutorProbe = (env: ExecutorEnv): Effect.Effect<void> =>
	Effect.tryPromise({
		try: () => env.Executor.getByName(`probe-v${EXECUTOR_PROBE_VERSION}`).probe(),
		catch: message,
	}).pipe(
		Effect.flatMap(({ report, fresh }) => {
			if (!fresh) return Effect.void
			const failed = report.checks.filter(
				(check) => check.verdict === "fail" || check.verdict === "missing",
			)
			const summary = Effect.logInfo("executor probe finished").pipe(
				Effect.annotateLogs({
					"maple.executor.probe.version": report.version,
					"maple.executor.probe.start": JSON.stringify(report.start),
					"maple.executor.probe.intercept_http": JSON.stringify(report.interceptHttp),
					"maple.executor.probe.intercept_https": JSON.stringify(report.interceptHttps),
					"maple.executor.probe.container_snapshot": JSON.stringify(report.containerSnapshot),
					"maple.executor.probe.failed": failed.map((check) => check.id).join(","),
				}),
			)
			const lines = Effect.forEach(
				report.checks,
				(check) =>
					Effect.logInfo("executor probe check").pipe(
						Effect.annotateLogs({
							"maple.executor.probe.version": report.version,
							"maple.executor.probe.check": check.id,
							"maple.executor.probe.verdict": check.verdict,
							"maple.executor.probe.exit_code": check.exitCode ?? -1,
							"maple.executor.probe.output": check.output ?? "",
						}),
					),
				{ discard: true },
			)
			return Effect.andThen(summary, lines)
		}),
		Effect.catch((error) =>
			Effect.logWarning("executor probe failed").pipe(Effect.annotateLogs({ "error.message": error })),
		),
	)
