import {
	EXECUTOR_LIMITS,
	type ExecutorCommandInput,
	ExecutorArtifact,
	ExecutorRunExited,
} from "@maple/domain/executor"
import { Effect, Array as Arr, String as Str } from "effect"
import { describe, expect, it } from "vitest"
import {
	AuditExecutionError,
	type AuditExecutionApi,
	executionToolHandlers,
	invocationExecution,
} from "./execution"
import type { SourceReaderApi } from "./source"

const unread = Effect.die("no read in this test")
const source: SourceReaderApi = {
	readFile: () => unread,
	grep: () => unread,
	listFiles: () => unread,
	log: () => unread,
	nearby: () => unread,
}

const exited = (overrides: Partial<ConstructorParameters<typeof ExecutorRunExited>[0]> = {}) =>
	new ExecutorRunExited({
		exitCode: 0,
		timedOut: false,
		stdout: "",
		stderr: "",
		stdoutBytes: 0,
		stderrBytes: 0,
		wallTimeMs: 12,
		promoted: [],
		rejected: [],
		...overrides,
	})

const recording = (answer: Effect.Effect<ExecutorRunExited, AuditExecutionError>) => {
	const asked: Array<{ readonly agentId: string; readonly command: ExecutorCommandInput }> = []
	const released: Array<string> = []
	const execution: AuditExecutionApi = {
		run: (agentId, command) => Effect.suspend(() => (asked.push({ agentId, command }), answer)),
		release: (agentId) => Effect.sync(() => void released.push(agentId)),
	}
	return { execution, asked, released }
}

const run = <A, E>(effect: Effect.Effect<A, E, never>) => Effect.runPromise(Effect.result(effect))

describe("run_in_sandbox", () => {
	it("runs as the calling agent with defaults, and renders output and promoted evidence", async () => {
		const { execution, asked } = recording(
			Effect.succeed(
				exited({
					exitCode: 1,
					stdout: "tenant-b row",
					stdoutBytes: 12,
					stderr: Str.repeat(10)("x"),
					stderrBytes: 90_000,
					promoted: [
						new ExecutorArtifact({
							path: "poc/out.txt",
							bytes: 13,
							sha256: Str.repeat(32)("ab"),
							preview: "tenant-b row\n",
						}),
					],
				}),
			),
		)
		const promoted: Array<string> = []
		const { handlers } = executionToolHandlers(source, execution, "hunter-2", Effect.void, (paths) =>
			Effect.sync(() => void promoted.push(...paths)),
		)
		const result = await run(
			handlers.run_in_sandbox({ command: "node poc.js", promote: [{ path: "poc/out.txt" }] }),
		)
		expect(asked).toEqual([
			{
				agentId: "hunter-2",
				command: {
					command: "node poc.js",
					cwd: "checkout",
					timeoutMs: EXECUTOR_LIMITS.defaultTimeoutMs,
					promote: [
						expect.objectContaining({
							path: "poc/out.txt",
							maxBytes: EXECUTOR_LIMITS.promotedFileBytes,
						}),
					],
				},
			},
		])
		expect(result._tag).toBe("Success")
		expect(promoted).toEqual(["agents/hunter-2/artifacts/poc/out.txt"])
		const text = result._tag === "Success" ? result.success : ""
		expect(text).toContain("exit 1")
		expect(text).toContain("tenant-b row")
		expect(text).toContain("--- stderr (90000 bytes, first 32 KiB shown) ---")
		expect(text).toContain(
			`poc/out.txt: 13 bytes, sha256 ${Str.repeat(32)("ab")}; cite it in a local check as agents/hunter-2/artifacts/poc/out.txt`,
		)
	})

	it("clamps the wall clock and promotion limits to the sandbox's own", async () => {
		const { execution, asked } = recording(Effect.succeed(exited()))
		const { handlers } = executionToolHandlers(source, execution, "verifier-1")
		await run(
			handlers.run_in_sandbox({
				command: "npm test",
				cwd: "scratch",
				timeout_seconds: 10_000,
				promote: [{ path: "out", max_bytes: 10_000_000 }],
			}),
		)
		expect(asked[0]?.command.timeoutMs).toBe(EXECUTOR_LIMITS.maxTimeoutMs)
		expect(asked[0]?.command.cwd).toBe("scratch")
		expect(asked[0]?.command.promote[0]?.maxBytes).toBe(EXECUTOR_LIMITS.promotedFileBytes)
	})

	it("refuses promote paths outside scratch before anything runs", async () => {
		const { execution, asked } = recording(Effect.succeed(exited()))
		const { handlers } = executionToolHandlers(source, execution, "hunter-1")
		for (const path of ["../../etc/passwd", "/etc/passwd", "a//b", "./x"]) {
			const result = await run(handlers.run_in_sandbox({ command: "true", promote: [{ path }] }))
			expect(result._tag === "Failure" ? result.failure.message : "ran").toContain("scratch-relative")
		}
		expect(asked).toEqual([])
	})

	it("answers the sandbox's failure as the tool's, so the model can act on it", async () => {
		const { execution } = recording(
			Effect.fail(new AuditExecutionError({ message: "the execution sandbox did not answer in time" })),
		)
		const { handlers } = executionToolHandlers(source, execution, "hunter-1")
		const result = await run(handlers.run_in_sandbox({ command: "sleep 1" }))
		expect(result._tag === "Failure" ? result.failure.message : "").toBe(
			"the execution sandbox did not answer in time",
		)
	})
})

describe("invocationExecution", () => {
	const command: ExecutorCommandInput = {
		command: "id",
		cwd: "checkout",
		timeoutMs: EXECUTOR_LIMITS.defaultTimeoutMs,
		promote: [],
	}

	it("runs every command under the invocation's own id, and releases that id once it ends", async () => {
		const { execution, asked, released } = recording(Effect.succeed(exited()))
		const scoped = await Effect.runPromise(invocationExecution(execution, "hunter-2-ab12cd34"))
		await Effect.runPromise(
			scoped.releasingAfter(
				Effect.andThen(scoped.run("hunter-2", command), scoped.run("hunter-2", command)),
			),
		)
		expect(Arr.map(asked, ({ agentId }) => agentId)).toEqual(["hunter-2-ab12cd34", "hunter-2-ab12cd34"])
		expect(released).toEqual(["hunter-2-ab12cd34"])
	})

	it("releases nothing for an invocation that ran no command", async () => {
		const { execution, released } = recording(Effect.succeed(exited()))
		const scoped = await Effect.runPromise(invocationExecution(execution, "hunter-2-ab12cd34"))
		await Effect.runPromise(scoped.releasingAfter(Effect.void))
		expect(released).toEqual([])
	})

	it("releases when the invocation fails after a command, even one that failed itself", async () => {
		const { execution, released } = recording(Effect.fail(new AuditExecutionError({ message: "lost" })))
		const scoped = await Effect.runPromise(invocationExecution(execution, "verifier-1-0f0f0f0f"))
		const result = await run(scoped.releasingAfter(scoped.run("verifier-1", command)))
		expect(result._tag).toBe("Failure")
		expect(released).toEqual(["verifier-1-0f0f0f0f"])
	})

	it("releases when the invocation is interrupted mid-command", async () => {
		const { execution, released } = recording(Effect.never)
		const scoped = await Effect.runPromise(invocationExecution(execution, "hunter-4-12345678"))
		const outcome = await Effect.runPromise(
			Effect.exit(Effect.timeout(scoped.releasingAfter(scoped.run("hunter-4", command)), "10 millis")),
		)
		expect(outcome._tag).toBe("Failure")
		expect(released).toEqual(["hunter-4-12345678"])
	})
})
