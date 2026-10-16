import { assert, describe, it } from "@effect/vitest"
import {
	SANDBOX_EXEC_PATH,
	SandboxExecRequest,
	SandboxExecResponse,
	SandboxRunExited,
} from "@maple/domain/sandbox"
import { Effect, Schema } from "effect"
import { handle, type SandboxHandleEnv } from "./handle"

const SHA = "a".repeat(40)
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

const env = (run: SandboxHandleEnv["run"]): SandboxHandleEnv => ({ token: SERVICE_TOKEN, run })

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
