/**
 * The executor probe's orchestration, as a function of {@link ExecutorContainer} and
 * {@link ProbeStore}: which container calls it makes in which order, when it stores a report, and
 * that it always destroys the container. The Durable Object in `executor.ts` implements both ports
 * over `ctx.container` and `ctx.storage`, so everything here tests without a Workers runtime.
 */
import { Duration, Effect } from "effect"
import {
	type AssessedCheck,
	EXECUTOR_PROBE_VERSION,
	assessProbe,
	parseProbe,
	probeScript,
} from "./executor-probe"

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

/** What the probe asks of its container. Failures are messages: each becomes a failed step. */
export interface ExecutorContainer {
	readonly isRunning: () => boolean
	/** Starts with internet off. */
	readonly start: Effect.Effect<void, string>
	readonly exec: (
		command: string,
		timeoutMs: number,
	) => Effect.Effect<{ readonly exitCode: number; readonly stdout: string }, string>
	readonly interceptHttp: Effect.Effect<void, string>
	readonly interceptHttps: Effect.Effect<void, string>
	readonly snapshot: Effect.Effect<{ readonly size: number }, string>
	readonly destroy: Effect.Effect<void>
}

/** Where a complete report is kept, keyed by probe version. */
export interface ProbeStore {
	readonly has: Effect.Effect<boolean, string>
	readonly put: (report: ExecutorProbeReport) => Effect.Effect<void, string>
}

/** The whole probe script's deadline; each check has its own 20s inside it. */
export const PROBE_TIMEOUT_MS = 10 * 60 * 1000

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

const notRun: ProbeStep = { ok: false, ms: 0, error: "not run: the container did not start" }

/** Every step in order, then the container destroyed whatever happened. */
export const runProbe = (
	container: ExecutorContainer | undefined,
	ranAt: number,
): Effect.Effect<ExecutorProbeReport> => {
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
	if (container === undefined)
		return Effect.succeed(
			unstarted({ ok: false, ms: 0, error: "no container is bound to this Durable Object" }),
		)
	return Effect.gen(function* () {
		if (container.isRunning()) yield* container.destroy
		const start = yield* step(
			container.start.pipe(
				Effect.andThen(container.exec("id -u", 60_000)),
				Effect.filterOrFail(
					(answer) => answer.exitCode === 0,
					(answer) => `the first command exited ${answer.exitCode}`,
				),
			),
		)
		if (!start.ok) return unstarted(start)
		const interceptHttp = yield* step(container.interceptHttp)
		const interceptHttps = yield* step(container.interceptHttps)
		const run = yield* container.exec(probeScript(), PROBE_TIMEOUT_MS).pipe(Effect.timed, Effect.result)
		const results = run._tag === "Success" ? parseProbe(run.success[1].stdout) : []
		const script: ProbeStep =
			run._tag === "Success"
				? {
						ok: true,
						ms: Duration.toMillis(run.success[0]),
						detail: `exit ${run.success[1].exitCode}, ${results.length} results`,
					}
				: { ok: false, ms: 0, error: run.failure }
		const containerSnapshot = yield* step(container.snapshot, (snapshot) => `size ${snapshot.size}`)
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
	}).pipe(Effect.ensuring(container.destroy))
}

/** A report that answers every check; anything less is retried on the next tick, not stored. */
export const isComplete = (report: ExecutorProbeReport): boolean =>
	report.start.ok && report.script.ok && report.checks.every((check) => check.verdict !== "missing")

/** The report as log lines: a summary, then one per check. */
export const logReport = (report: ExecutorProbeReport): Effect.Effect<void> => {
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

/**
 * Runs the probe unless this version already has a complete report. The report is logged before
 * it is stored, so a stored report has always been logged.
 */
export const probeOnce = (
	store: ProbeStore,
	container: ExecutorContainer | undefined,
	ranAt: number,
): Effect.Effect<void, string> =>
	Effect.gen(function* () {
		if (yield* store.has) return
		const report = yield* runProbe(container, ranAt)
		yield* logReport(report)
		if (isComplete(report)) yield* store.put(report)
	})
