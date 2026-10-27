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
	/** The check script itself: a failure here leaves every check `missing`. */
	readonly script: ProbeStep
	readonly checks: ReadonlyArray<AssessedCheck>
	/** `snapshotContainer()`: the dependency cache's fast path, if the scheduling policy allows it. */
	readonly containerSnapshot: ProbeStep
}

const REPORT_KEY = `probe:v${EXECUTOR_PROBE_VERSION}`

/** The whole probe script's deadline; each check has its own 20s inside it. */
const PROBE_TIMEOUT_MS = 10 * 60 * 1000

const decoder = new TextDecoder()

const message = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause)).slice(0, 500)

/** Runs `effect`, timing it; a failure becomes a failed step instead of failing the probe. */
const step = <A>(effect: Effect.Effect<A, string>, detail?: (value: A) => string) =>
	effect.pipe(
		Effect.timed,
		Effect.map(([elapsed, value]): ProbeStep => {
			const done = { ok: true, ms: Duration.toMillis(elapsed) }
			return detail === undefined ? done : { ...done, detail: detail(value) }
		}),
		Effect.catch((error) => Effect.succeed<ProbeStep>({ ok: false, ms: 0, error })),
	)

const attempt = <A>(run: () => Promise<A>) => Effect.tryPromise({ try: run, catch: message })

const notRun: ProbeStep = { ok: false, ms: 0, error: "not run: the container did not start" }

export interface ExecutorEnv {
	readonly Executor: DurableObjectNamespace<Executor>
}

/** A report that answers every check; anything less is retried on the next tick, not stored. */
const isComplete = (report: ExecutorProbeReport) =>
	report.start.ok && report.script.ok && report.checks.every((check) => check.verdict !== "missing")

/** The report as log lines: a summary, then one per check. */
const logReport = (report: ExecutorProbeReport): Effect.Effect<void> => {
	const failed = report.checks.filter((check) => check.verdict === "fail" || check.verdict === "missing")
	const summary = Effect.logInfo("executor probe finished").pipe(
		Effect.annotateLogs({
			"maple.executor.probe.version": report.version,
			"maple.executor.probe.start": JSON.stringify(report.start),
			"maple.executor.probe.intercept_http": JSON.stringify(report.interceptHttp),
			"maple.executor.probe.intercept_https": JSON.stringify(report.interceptHttps),
			"maple.executor.probe.script": JSON.stringify(report.script),
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
}

export class Executor extends DurableObject<ExecutorEnv> {
	/**
	 * Runs the probe unless this version already has a complete report. The report is logged here,
	 * before it is stored, so a stored report has always been logged.
	 */
	async probe(): Promise<void> {
		const stored = await this.ctx.storage.get<ExecutorProbeReport>(REPORT_KEY)
		if (stored !== undefined) return
		const report = await Effect.runPromise(this.runProbe())
		await Effect.runPromise(logReport(report))
		if (isComplete(report)) await this.ctx.storage.put(REPORT_KEY, report)
	}

	private runProbe(): Effect.Effect<ExecutorProbeReport> {
		const ctx = this.ctx
		const ranAt = Date.now()
		const unstarted = (start: ProbeStep): ExecutorProbeReport => ({
			version: EXECUTOR_PROBE_VERSION,
			ranAt,
			start,
			interceptHttp: notRun,
			interceptHttps: notRun,
			script: notRun,
			checks: [],
			containerSnapshot: notRun,
		})
		const container = ctx.container
		if (container === undefined)
			return Effect.succeed(
				unstarted({ ok: false, ms: 0, error: "no container is bound to this Durable Object" }),
			)
		const exec = (command: string, timeoutMs: number) =>
			attempt(async () => {
				const process = await container.exec(["bash", "-c", command], {
					env: { HOME: "/root", LANG: "C.UTF-8" },
					signal: AbortSignal.timeout(timeoutMs),
				})
				const output = await process.output()
				return { exitCode: output.exitCode, stdout: decoder.decode(output.stdout) }
			})
		const destroy = attempt(() => container.destroy()).pipe(Effect.ignore)
		return Effect.gen(function* () {
			if (container.running) yield* destroy
			const start = yield* step(
				attempt(async () => {
					container.start({ enableInternet: false })
					await container.setInactivityTimeout(5 * 60 * 1000)
				}).pipe(
					Effect.andThen(exec("id -u", 60_000)),
					Effect.filterOrFail(
						(answer) => answer.exitCode === 0,
						(answer) => `the first command exited ${answer.exitCode}`,
					),
				),
			)
			if (!start.ok) return unstarted(start)
			const gateway = ctx.exports.RegistryGateway({ props: {} })
			const interceptHttp = yield* step(
				attempt(() => container.interceptOutboundHttp(GATEWAY_HOST, gateway)),
			)
			const interceptHttps = yield* step(
				attempt(() => container.interceptOutboundHttps(GATEWAY_TLS_HOST, gateway)),
			)
			const run = yield* exec(probeScript(), PROBE_TIMEOUT_MS).pipe(Effect.timed, Effect.result)
			const results = run._tag === "Success" ? parseProbe(run.success[1].stdout) : []
			const script: ProbeStep =
				run._tag === "Success"
					? {
							ok: true,
							ms: Duration.toMillis(run.success[0]),
							detail: `exit ${run.success[1].exitCode}, ${results.length} results`,
						}
					: { ok: false, ms: 0, error: run.failure }
			const containerSnapshot = yield* step(
				attempt(() =>
					container.snapshotContainer({ name: `executor-probe-v${EXECUTOR_PROBE_VERSION}` }),
				),
				(snapshot) => `size ${snapshot.size}`,
			)
			return {
				version: EXECUTOR_PROBE_VERSION,
				ranAt,
				start,
				interceptHttp,
				interceptHttps,
				script,
				checks: assessProbe(results),
				containerSnapshot,
			}
		}).pipe(Effect.ensuring(destroy))
	}
}

/** Runs the probe once per probe version; the Durable Object logs the report. */
export const runExecutorProbe = (env: ExecutorEnv): Effect.Effect<void> =>
	attempt(() => env.Executor.getByName(`probe-v${EXECUTOR_PROBE_VERSION}`).probe()).pipe(
		Effect.catch((error) =>
			Effect.logWarning("executor probe failed").pipe(Effect.annotateLogs({ "error.message": error })),
		),
	)
