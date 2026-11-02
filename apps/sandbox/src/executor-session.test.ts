import { assert, describe, it } from "@effect/vitest"
import { ExecutorPrepareRequest, ExecutorPromotion, ExecutorRunRequest } from "@maple/domain/executor"
import { Effect } from "effect"
import type { GatewayProps } from "./executor-gateway"
import { PREPARE_STATE_DIR, PROMOTE_HELPER, RUN_TRAILER } from "./executor-scripts"
import { type ExecResult, type ExecutorHost, destroy, prepare, run } from "./executor-session"

const SHA = "b".repeat(40)
const TOKEN = "ghs_clone_token"

const prepareRequest = new ExecutorPrepareRequest({
	executorKey: "run-1",
	checkout: {
		repository: "octo/shop",
		sha: SHA,
		remoteUrl: "https://github.com/octo/shop.git",
		token: TOKEN,
	},
})

const runRequest = (promote: ReadonlyArray<ExecutorPromotion> = []) =>
	new ExecutorRunRequest({
		executorKey: "run-1",
		agentId: "hunter-3",
		command: "node poc.js",
		cwd: "checkout",
		timeoutMs: 30_000,
		promote,
	})

const exited = (stdout: string, stderr = "", durationMs = 40): ExecResult => ({
	exitCode: 0,
	stdout,
	stderr,
	durationMs,
})

/** A fake container: answers each script by the first matching rule, and records every call. */
const fakeHost = (
	answers: ReadonlyArray<readonly [(script: string) => boolean, ExecResult | string]>,
	options: { readonly running?: boolean; readonly startFails?: string } = {},
) => {
	const execs: Array<string> = []
	const spawned: Array<string> = []
	const gateways: Array<GatewayProps> = []
	let destroyed = false
	const host: ExecutorHost = {
		isRunning: () => options.running ?? true,
		ensureStarted: (gateway) => {
			gateways.push(gateway)
			return options.startFails === undefined ? Effect.void : Effect.fail(options.startFails)
		},
		exec: (script) => {
			execs.push(script)
			const answer = answers.find(([matches]) => matches(script))?.[1]
			if (answer === undefined) return Effect.fail(`no answer for ${script.slice(0, 60)}`)
			return typeof answer === "string" ? Effect.fail(answer) : Effect.succeed(answer)
		},
		spawn: (script) => {
			spawned.push(script)
			return Effect.void
		},
		destroy: Effect.sync(() => {
			destroyed = true
		}),
	}
	return { host, execs, spawned, gateways, wasDestroyed: () => destroyed }
}

const isStatus = (script: string) => script.includes(`${PREPARE_STATE_DIR}/exit-code ]; then`)
const isRun = (script: string) => script.includes("unshare --net --mount --pid")
const isPromote = (script: string) => script.includes(PROMOTE_HELPER)

describe("prepare", () => {
	it.effect(
		"starts prepare in the background on a fresh container, with the gateway holding the credential",
		() =>
			Effect.gen(function* () {
				const fake = fakeHost([[isStatus, exited("claimed\n")]])
				const answer = yield* prepare(fake.host, prepareRequest)
				assert.strictEqual(answer._tag, "ExecutorPreparing")
				assert.lengthOf(fake.spawned, 1)
				assert.include(fake.spawned[0], SHA)
				assert.notInclude(fake.spawned[0], TOKEN)
				assert.deepStrictEqual(fake.gateways, [
					{ git: { remoteUrl: "https://github.com/octo/shop.git", token: TOKEN } },
				])
			}),
	)

	it.effect("answers prepared with each lockfile's install", () =>
		Effect.gen(function* () {
			const fake = fakeHost([[isStatus, exited(`ready ${SHA}\n.\tnpm\tinstalled\tadded 3 packages\n`)]])
			const answer = yield* prepare(fake.host, prepareRequest)
			assert.strictEqual(answer._tag, "ExecutorPrepared")
			if (answer._tag !== "ExecutorPrepared") return
			assert.deepStrictEqual(
				answer.installs.map((install) => [install.dir, install.manager, install.outcome]),
				[[".", "npm", "installed"]],
			)
			assert.lengthOf(fake.spawned, 0)
		}),
	)

	it.effect("refuses a container already prepared for another commit", () =>
		Effect.gen(function* () {
			const fake = fakeHost([[isStatus, exited(`ready ${"c".repeat(40)}\n`)]])
			assert.strictEqual((yield* prepare(fake.host, prepareRequest))._tag, "ExecutorPrepareFailed")
		}),
	)

	it.effect("reports a failed prepare with its log, and never the credential", () =>
		Effect.gen(function* () {
			const fake = fakeHost([[isStatus, exited(`failed 11\nfatal: auth failed for ${TOKEN}\n`)]])
			const answer = yield* prepare(fake.host, prepareRequest)
			assert.strictEqual(answer._tag, "ExecutorPrepareFailed")
			if (answer._tag !== "ExecutorPrepareFailed") return
			assert.include(answer.message, "exit 11")
			assert.notInclude(answer.message, TOKEN)
		}),
	)

	it.effect("clears a prepare that stopped without finishing so the next call starts again", () =>
		Effect.gen(function* () {
			const fake = fakeHost([
				[isStatus, exited("lost\n")],
				[(script) => script.startsWith("rm -rf"), exited("")],
			])
			assert.strictEqual((yield* prepare(fake.host, prepareRequest))._tag, "ExecutorPreparing")
			assert.isTrue(fake.execs.some((script) => script.startsWith("rm -rf")))
		}),
	)

	it.effect("answers unavailable, redacted, when the container will not start", () =>
		Effect.gen(function* () {
			const fake = fakeHost([], { startFails: `could not start with ${TOKEN}` })
			const answer = yield* prepare(fake.host, prepareRequest)
			assert.strictEqual(answer._tag, "ExecutorUnavailable")
			if (answer._tag !== "ExecutorUnavailable") return
			assert.notInclude(answer.message, TOKEN)
		}),
	)
})

describe("run", () => {
	it.effect("returns the command's output, exit code and promoted artifacts", () =>
		Effect.gen(function* () {
			const fake = fakeHost([
				[isRun, exited(`tenant-b row\n${RUN_TRAILER} started 1 13 4\n`, "boom", 120)],
				[
					isPromote,
					exited(
						JSON.stringify({
							promoted: [
								{
									path: "out.txt",
									bytes: 13,
									sha256: "f".repeat(64),
									preview: "tenant-b row\n",
								},
							],
							rejected: [{ path: "link", reason: "the file is a symlink" }],
						}),
					),
				],
			])
			const answer = yield* run(
				fake.host,
				runRequest([
					new ExecutorPromotion({ path: "out.txt", maxBytes: 100 }),
					new ExecutorPromotion({ path: "link", maxBytes: 100 }),
				]),
				"call-1",
			)
			assert.strictEqual(answer._tag, "ExecutorRunExited")
			if (answer._tag !== "ExecutorRunExited") return
			assert.strictEqual(answer.exitCode, 1)
			assert.strictEqual(answer.stdout, "tenant-b row")
			assert.strictEqual(answer.stderr, "boom")
			assert.isFalse(answer.timedOut)
			assert.deepStrictEqual(
				answer.promoted.map((artifact) => artifact.path),
				["out.txt"],
			)
			assert.deepStrictEqual(
				answer.rejected.map((rejected) => rejected.reason),
				["the file is a symlink"],
			)
		}),
	)

	it.effect("skips promotion when nothing was declared", () =>
		Effect.gen(function* () {
			const fake = fakeHost([[isRun, exited(`ok\n${RUN_TRAILER} started 0 3 0\n`)]])
			assert.strictEqual((yield* run(fake.host, runRequest(), "call-1"))._tag, "ExecutorRunExited")
			assert.isFalse(fake.execs.some(isPromote))
		}),
	)

	it.effect("reports a command killed at its deadline as timed out", () =>
		Effect.gen(function* () {
			const fake = fakeHost([[isRun, exited(`${RUN_TRAILER} started 124 0 0\n`, "", 30_400)]])
			const answer = yield* run(fake.host, runRequest(), "call-1")
			assert.isTrue(answer._tag === "ExecutorRunExited" && answer.timedOut)
		}),
	)

	it.effect("discards every declared file when promotion cannot run", () =>
		Effect.gen(function* () {
			const fake = fakeHost([
				[isRun, exited(`${RUN_TRAILER} started 0 0 0\n`)],
				[isPromote, exited("Traceback: something")],
			])
			const answer = yield* run(
				fake.host,
				runRequest([new ExecutorPromotion({ path: "out.txt", maxBytes: 10 })]),
				"c",
			)
			assert.strictEqual(answer._tag, "ExecutorRunExited")
			if (answer._tag !== "ExecutorRunExited") return
			assert.deepStrictEqual(answer.promoted, [])
			assert.deepStrictEqual(
				answer.rejected.map((rejected) => rejected.path),
				["out.txt"],
			)
		}),
	)

	it.effect("asks for a new prepare when the container stopped or was never prepared", () =>
		Effect.gen(function* () {
			const stopped = fakeHost([], { running: false })
			assert.strictEqual((yield* run(stopped.host, runRequest(), "c"))._tag, "ExecutorNotPrepared")
			assert.lengthOf(stopped.execs, 0)
			const unprepared = fakeHost([[isRun, exited(`\n${RUN_TRAILER} not-prepared 0 0 0\n`)]])
			assert.strictEqual((yield* run(unprepared.host, runRequest(), "c"))._tag, "ExecutorNotPrepared")
		}),
	)

	it.effect("never reports a command whose isolation failed as having run", () =>
		Effect.gen(function* () {
			const fake = fakeHost([
				[isRun, exited(`${RUN_TRAILER} setup-failed 1 0 30\n`, "unshare: Operation not permitted")],
			])
			const answer = yield* run(fake.host, runRequest(), "c")
			assert.strictEqual(answer._tag, "ExecutorUnavailable")
			if (answer._tag !== "ExecutorUnavailable") return
			assert.include(answer.message, "Operation not permitted")
		}),
	)
})

describe("destroy", () => {
	it.effect("destroys the container", () =>
		Effect.gen(function* () {
			const fake = fakeHost([])
			assert.strictEqual((yield* destroy(fake.host))._tag, "ExecutorDestroyed")
			assert.isTrue(fake.wasDestroyed())
		}),
	)
})
