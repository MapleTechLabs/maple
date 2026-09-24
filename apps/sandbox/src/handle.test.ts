import { assert, describe, it } from "@effect/vitest"
import { SANDBOX_EXEC_PATH, SandboxExecRequest, sandboxCredentialPath } from "@maple/domain/sandbox"
import { Effect, Schema } from "effect"
import type { SandboxLike } from "./checkout"
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

const env = (open: SandboxHandleEnv["open"]): SandboxHandleEnv => ({ token: SERVICE_TOKEN, open })

const unreachable: SandboxHandleEnv["open"] = () => {
	throw new TypeError("Cannot read properties of undefined (reading 'idFromName')")
}

const answered = (response: Response) => response.json() as Promise<Record<string, unknown>>

describe("handle", () => {
	it.effect("reports a missing container binding instead of a bare 500", () =>
		Effect.gen(function* () {
			const response = yield* handle(post(), env(unreachable))
			assert.strictEqual(response.status, 200)
			const payload = yield* Effect.promise(() => answered(response))
			assert.strictEqual(payload._tag, "SandboxRunUnavailable")
			assert.include(String(payload.message), "idFromName")
		}),
	)

	it.effect("keeps the clone credential out of a failure it did not expect", () =>
		Effect.gen(function* () {
			const leaky: SandboxHandleEnv["open"] = () => {
				throw new Error(`clone failed: ${sandboxCredentialPath(SHA)} held ${TOKEN}`)
			}
			const response = yield* handle(post(), env(leaky))
			const payload = yield* Effect.promise(() => answered(response))
			assert.notInclude(String(payload.message), TOKEN)
			assert.include(String(payload.message), "<redacted>")
		}),
	)

	it.effect("answers a command the container ran", () =>
		Effect.gen(function* () {
			const container: SandboxLike = {
				exec: async () => ({
					exitCode: 0,
					stdout: "apps\n__maple_sandbox_trailer__ 0 5 0 isolated\n",
					stderr: "",
					duration: 12,
				}),
				startProcess: async () => ({ id: "p", status: "running" as const }),
				getProcess: async () => ({ id: "p", status: "running" as const }),
				getProcessLogs: async () => ({ stdout: "", stderr: "" }),
				writeFile: async () => ({ success: true }),
			}
			const response = yield* handle(
				post(),
				env(() => container),
			)
			const payload = yield* Effect.promise(() => answered(response))
			assert.strictEqual(payload._tag, "SandboxRunExited")
			assert.strictEqual(payload.stdout, "apps")
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
