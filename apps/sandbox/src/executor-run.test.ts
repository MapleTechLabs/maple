import { assert, describe, it } from "@effect/vitest"
import { Effect, Logger } from "effect"
import { PROBE_CHECKS, PROBE_SENTINEL } from "./executor-probe"
import { type ExecutorContainer, type ExecutorProbeReport, type ProbeStore, probeOnce } from "./executor-run"

/** Script output answering every check with exit 0. */
const ALL_ANSWERED = PROBE_CHECKS.map((check) => `${PROBE_SENTINEL} ${check.id} 0 `).join("\n")

interface Fake {
	readonly calls: Array<string>
	readonly container: ExecutorContainer
	readonly store: ProbeStore
	readonly stored: Array<ExecutorProbeReport>
}

const fake = (options: {
	readonly firstExit?: number
	readonly script?: "answers" | "fails" | "partial"
	readonly alreadyStored?: boolean
}): Fake => {
	const calls: Array<string> = []
	const stored: Array<ExecutorProbeReport> = []
	const record = (name: string) => Effect.sync(() => void calls.push(name))
	const container: ExecutorContainer = {
		isRunning: () => false,
		start: record("start"),
		exec: (command) => {
			if (command === "id -u")
				return record("exec id").pipe(Effect.as({ exitCode: options.firstExit ?? 0, stdout: "0" }))
			if (options.script === "fails")
				return record("exec script").pipe(Effect.andThen(Effect.fail("aborted")))
			const stdout =
				options.script === "partial" ? ALL_ANSWERED.split("\n").slice(0, 3).join("\n") : ALL_ANSWERED
			return record("exec script").pipe(Effect.as({ exitCode: 0, stdout }))
		},
		interceptHttp: record("intercept http"),
		interceptHttps: record("intercept https"),
		snapshot: record("snapshot").pipe(Effect.andThen(Effect.fail("not supported under this policy"))),
		destroy: record("destroy"),
	}
	const store: ProbeStore = {
		has: Effect.succeed(options.alreadyStored === true),
		put: (report) =>
			Effect.sync(() => {
				calls.push("put")
				stored.push(report)
			}),
	}
	return { calls, container, store, stored }
}

/** Runs the probe with its log lines recorded into `calls` as `log <message>`. */
const run = (subject: Fake) =>
	probeOnce(subject.store, subject.container, 0).pipe(
		Effect.provide(
			Logger.layer([
				Logger.make(({ message }) => {
					const [first] = Array.isArray(message) ? message : [message]
					subject.calls.push(`log ${String(first)}`)
				}),
			]),
		),
	)

const withoutCheckLogs = (calls: ReadonlyArray<string>) =>
	calls.filter((call) => call !== "log executor probe check")

describe("probeOnce", () => {
	it.effect("runs every step, logs the report, stores it, then destroys the container", () =>
		Effect.gen(function* () {
			const subject = fake({ script: "answers" })
			yield* run(subject)
			assert.deepStrictEqual(withoutCheckLogs(subject.calls), [
				"start",
				"exec id",
				"intercept http",
				"intercept https",
				"exec script",
				"snapshot",
				"destroy",
				"log executor probe finished",
				"put",
			])
			assert.strictEqual(
				subject.calls.filter((call) => call === "log executor probe check").length,
				PROBE_CHECKS.length,
			)
			const [report] = subject.stored
			assert.strictEqual(report?.containerSnapshot.ok, false)
			assert.strictEqual(report?.containerSnapshot.error, "not supported under this policy")
		}),
	)

	it.effect("logs but does not store a run whose script failed, and still destroys the container", () =>
		Effect.gen(function* () {
			const subject = fake({ script: "fails" })
			yield* run(subject)
			assert.isTrue(subject.calls.includes("destroy"))
			assert.isTrue(subject.calls.includes("log executor probe finished"))
			assert.deepStrictEqual(subject.stored, [])
		}),
	)

	it.effect("does not store a run that left checks unanswered", () =>
		Effect.gen(function* () {
			const subject = fake({ script: "partial" })
			yield* run(subject)
			assert.deepStrictEqual(subject.stored, [])
		}),
	)

	it.effect("stops after a start whose first command failed, without intercepting", () =>
		Effect.gen(function* () {
			const subject = fake({ firstExit: 1, script: "answers" })
			yield* run(subject)
			assert.deepStrictEqual(withoutCheckLogs(subject.calls), [
				"start",
				"exec id",
				"destroy",
				"log executor probe finished",
			])
			assert.deepStrictEqual(subject.stored, [])
		}),
	)

	it.effect("touches no container once this version has a stored report", () =>
		Effect.gen(function* () {
			const subject = fake({ script: "answers", alreadyStored: true })
			yield* run(subject)
			assert.deepStrictEqual(subject.calls, [])
		}),
	)

	it.effect("logs a report without storing it when no container is bound", () =>
		Effect.gen(function* () {
			const subject = fake({})
			yield* probeOnce(subject.store, undefined, 0)
			assert.deepStrictEqual(subject.stored, [])
		}),
	)
})
