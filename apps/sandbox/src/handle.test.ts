import { assert, describe, it } from "@effect/vitest"
import {
	SANDBOX_EXEC_PATH,
	SandboxExecRequest,
	SandboxExecResponse,
	SandboxRunExited,
} from "@maple/domain/sandbox"
import {
	EXECUTOR_DESTROY_PATH,
	EXECUTOR_PREPARE_PATH,
	EXECUTOR_RELEASE_PATH,
	EXECUTOR_RUN_PATH,
} from "@maple/domain/executor"
import { Effect, Schema, String as Str } from "effect"
import { handle, type SandboxHandleEnv } from "./handle"

const SHA = Str.repeat(40)("a")
const TOKEN = "ghs_secret_token"
const SERVICE_TOKEN = "service-token"

const encodeRequest = Schema.encodeUnknownSync(SandboxExecRequest)

const body = () =>
	encodeRequest(
		new SandboxExecRequest({
			sandboxKey: "repo-0123456789abcdef",
			checkout: {
				repository: "octo/shop",
				sha: SHA,
				remoteUrl: "https://github.com/octo/shop.git",
				token: TOKEN,
			},
			command: "git",
			args: ["ls-files"],
			cwd: ".",
			timeoutMs: 30_000,
			maxOutputBytes: 1024,
		}),
	)

const post = (payload: unknown = body(), authorization = `Bearer ${SERVICE_TOKEN}`) =>
	new Request(`https://sandbox.internal${SANDBOX_EXEC_PATH}`, {
		method: "POST",
		headers: { authorization, "content-type": "application/json" },
		body: JSON.stringify(payload),
	})

const noExecutor: SandboxHandleEnv["executor"] = {
	prepare: () => Promise.reject(new Error("no executor in this test")),
	run: () => Promise.reject(new Error("no executor in this test")),
	release: () => Promise.reject(new Error("no executor in this test")),
	destroy: () => Promise.reject(new Error("no executor in this test")),
}

const env = (run: SandboxHandleEnv["run"], executor = noExecutor): SandboxHandleEnv => ({
	token: SERVICE_TOKEN,
	run,
	executor,
})

const unreachable: SandboxHandleEnv["run"] = () => {
	throw new TypeError("Cannot read properties of undefined (reading 'getByName')")
}

const answered = (response: Response) => response.json() as Promise<Record<string, unknown>>

describe("handle", () => {
	it.effect("reports a missing container binding instead of a bare 500", () =>
		Effect.gen(function* () {
			const response = yield* handle(post(), env(unreachable))
			assert.strictEqual(response.status, 200)
			const payload = yield* Effect.promise(() => answered(response))
			assert.strictEqual(payload._tag, "SandboxRunUnavailable")
			assert.include(String(payload.message), "getByName")
		}),
	)

	it.effect("keeps the clone token out of a Durable Object failure", () =>
		Effect.gen(function* () {
			const leaky: SandboxHandleEnv["run"] = () =>
				Promise.reject(new Error(`clone failed with ${TOKEN}`))
			const response = yield* handle(post(), env(leaky))
			const payload = yield* Effect.promise(() => answered(response))
			assert.notInclude(String(payload.message), TOKEN)
			assert.include(String(payload.message), "<redacted>")
		}),
	)

	it.effect("hands the Durable Object the encoded request and returns its answer", () =>
		Effect.gen(function* () {
			const seen: Array<{ key: string; request: unknown }> = []
			const answer = Schema.encodeSync(SandboxExecResponse)(
				new SandboxRunExited({
					exitCode: 0,
					stdout: "apps",
					stderr: "",
					stdoutBytes: 4,
					stderrBytes: 0,
					stdoutTruncated: false,
					stderrTruncated: false,
					wallTimeMs: 12,
				}),
			)
			const response = yield* handle(
				post(),
				env(async (key, request) => {
					seen.push({ key, request })
					return answer
				}),
			)
			const payload = yield* Effect.promise(() => answered(response))
			assert.strictEqual(payload._tag, "SandboxRunExited")
			assert.strictEqual(payload.stdout, "apps")
			assert.strictEqual(seen[0]?.key, "repo-0123456789abcdef")
			assert.deepStrictEqual(seen[0]?.request, body())
		}),
	)

	it.effect("refuses a caller without the service token", () =>
		Effect.gen(function* () {
			const response = yield* handle(post(body(), "Bearer wrong"), env(unreachable))
			assert.strictEqual(response.status, 401)
		}),
	)

	it.effect("refuses a body it cannot decode", () =>
		Effect.gen(function* () {
			const response = yield* handle(post({ nope: true }), env(unreachable))
			assert.strictEqual(response.status, 400)
		}),
	)
})

const executorPost = (path: string, payload: unknown, authorization = `Bearer ${SERVICE_TOKEN}`) =>
	new Request(`https://sandbox.internal${path}`, {
		method: "POST",
		headers: { authorization, "content-type": "application/json" },
		body: JSON.stringify(payload),
	})

const prepareBody = {
	executorKey: "run-1",
	checkout: {
		repository: "octo/shop",
		sha: SHA,
		remoteUrl: "https://github.com/octo/shop.git",
		token: TOKEN,
	},
}

describe("handle, executor routes", () => {
	it.effect("hands a prepare to the run's executor by its key", () =>
		Effect.gen(function* () {
			const keys: Array<string> = []
			const response = yield* handle(
				executorPost(EXECUTOR_PREPARE_PATH, prepareBody),
				env(unreachable, {
					...noExecutor,
					prepare: async (key) => {
						keys.push(key)
						return { _tag: "ExecutorPreparing", message: "fetching" }
					},
				}),
			)
			const payload = yield* Effect.promise(() => answered(response))
			assert.strictEqual(payload._tag, "ExecutorPreparing")
			assert.deepStrictEqual(keys, ["run-1"])
		}),
	)

	it.effect("hands a release to the run's executor, naming the agent", () =>
		Effect.gen(function* () {
			const asked: Array<string> = []
			const response = yield* handle(
				executorPost(EXECUTOR_RELEASE_PATH, { executorKey: "run-1", agentId: "hunter-2-ab12cd34" }),
				env(unreachable, {
					...noExecutor,
					release: async (key, request) => {
						asked.push(`${key} ${request.agentId}`)
						return { _tag: "ExecutorReleased" }
					},
				}),
			)
			const payload = yield* Effect.promise(() => answered(response))
			assert.strictEqual(payload._tag, "ExecutorReleased")
			assert.deepStrictEqual(asked, ["run-1 hunter-2-ab12cd34"])
			const invalid = yield* handle(
				executorPost(EXECUTOR_RELEASE_PATH, { executorKey: "run-1", agentId: "../other" }),
				env(unreachable),
			)
			assert.strictEqual(invalid.status, 400)
		}),
	)

	it.effect("never echoes the clone token when the executor cannot be reached", () =>
		Effect.gen(function* () {
			const response = yield* handle(
				executorPost(EXECUTOR_PREPARE_PATH, prepareBody),
				env(unreachable, {
					...noExecutor,
					prepare: () => Promise.reject(new Error(`failed with ${TOKEN}`)),
				}),
			)
			const payload = yield* Effect.promise(() => answered(response))
			assert.strictEqual(payload._tag, "ExecutorUnavailable")
			assert.notInclude(String(payload.message), TOKEN)
		}),
	)

	it.effect("refuses an executor call without the service token, or with an invalid agent id", () =>
		Effect.gen(function* () {
			const unauthorized = yield* handle(
				executorPost(EXECUTOR_DESTROY_PATH, { executorKey: "run-1" }, "Bearer x"),
				env(unreachable),
			)
			assert.strictEqual(unauthorized.status, 401)
			const invalid = yield* handle(
				executorPost(EXECUTOR_RUN_PATH, {
					executorKey: "run-1",
					agentId: "../other",
					command: "id",
					cwd: "checkout",
					timeoutMs: 5000,
					promote: [],
				}),
				env(unreachable),
			)
			assert.strictEqual(invalid.status, 400)
		}),
	)
})
