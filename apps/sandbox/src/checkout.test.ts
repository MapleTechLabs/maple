import { assert, describe, it } from "@effect/vitest"
import {
	SandboxExecRequest,
	SANDBOX_NETNS_UNAVAILABLE_EXIT,
	shellCommand,
	shellQuote,
} from "@maple/domain/sandbox"
import { Effect, Option } from "effect"
import { checkoutDir, ensureCheckout, runExec, wrapCommand, type SandboxLike } from "./checkout"

const SHA = "a".repeat(40)
const CLONE_URL = "https://x-access-token:ghs_secret@github.com/octo/shop.git"

const checkout = {
	repository: "octo/shop",
	sha: SHA,
	cloneUrl: CLONE_URL,
	remoteUrl: "https://github.com/octo/shop.git",
}

const request = (overrides: Partial<SandboxExecRequest> = {}) =>
	new SandboxExecRequest({
		sandboxKey: "org_1:github:octo/shop",
		checkout,
		command: "git",
		args: ["grep", "-e", "card declined"],
		cwd: ".",
		network: "disabled",
		timeoutMs: 30_000,
		maxOutputBytes: 1024,
		...overrides,
	})

/** A container that answers a scripted exit code per call and records the commands. */
const fakeSandbox = (
	answers: ReadonlyArray<{ exitCode?: number; stdout?: string; stderr?: string }>,
	seen: string[] = [],
): SandboxLike => {
	let next = 0
	return {
		exec: async (command, options) => {
			seen.push(`${command}${options?.cwd ? ` @${options.cwd}` : ""}`)
			const answer = answers[next++] ?? {}
			return {
				exitCode: answer.exitCode ?? 0,
				stdout: answer.stdout ?? "",
				stderr: answer.stderr ?? "",
				duration: 7,
			}
		},
	}
}

describe("shell quoting", () => {
	it("survives quotes, spaces and dollar signs", () => {
		assert.strictEqual(shellQuote("it's $HOME"), `'it'\\''s $HOME'`)
		assert.strictEqual(shellCommand("git", ["grep", "a b"]), `'git' 'grep' 'a b'`)
	})
})

describe("wrapCommand", () => {
	it("drops privileges and opens a network namespace when egress is disabled", () => {
		const wrapped = wrapCommand("git", ["status"], "disabled")
		assert.include(wrapped, "unshare -n")
		assert.include(wrapped, "runuser -u maple-agent --")
		// The probe runs first, so a container that cannot isolate refuses instead of running.
		assert.include(wrapped, `exit ${SANDBOX_NETNS_UNAVAILABLE_EXIT}`)
		assert.isTrue(wrapped.indexOf("unshare -n true") < wrapped.indexOf("exec unshare"))
	})

	it("still drops privileges when egress is allowed", () => {
		const wrapped = wrapCommand("git", ["status"], "enabled")
		assert.include(wrapped, "runuser -u maple-agent --")
		assert.notInclude(wrapped, "unshare")
	})
})

describe("ensureCheckout", () => {
	it.effect("does nothing when the commit is already checked out", () =>
		Effect.gen(function* () {
			const seen: string[] = []
			const result = yield* ensureCheckout(fakeSandbox([{ exitCode: 0 }], seen), checkout)
			assert.isTrue(Option.isNone(result))
			assert.strictEqual(seen.length, 1)
			assert.include(seen[0]!, checkoutDir(SHA))
		}),
	)

	it.effect("clones, scrubs the credential from the remote, and makes the tree unwritable", () =>
		Effect.gen(function* () {
			const seen: string[] = []
			const result = yield* ensureCheckout(
				fakeSandbox([{ exitCode: 1 }, { exitCode: 0 }], seen),
				checkout,
			)
			assert.isTrue(Option.isNone(result))
			const script = seen[1]!
			assert.include(script, "git clone --quiet --no-checkout")
			assert.include(script, "remote set-url origin 'https://github.com/octo/shop.git'")
			assert.include(script, "chmod -R go-w")
			assert.include(script, "checkout --quiet --detach")
			// The scrub must come before anything that could leave the URL behind.
			assert.isTrue(script.indexOf("remote set-url") < script.indexOf("chmod -R go-w"))
		}),
	)

	it.effect("reports a failed clone without echoing the credential", () =>
		Effect.gen(function* () {
			const result = yield* ensureCheckout(
				fakeSandbox([
					{ exitCode: 1 },
					{ exitCode: 128, stderr: `fatal: could not read ${CLONE_URL}` },
				]),
				checkout,
			)
			assert.isTrue(Option.isSome(result))
			if (Option.isSome(result)) {
				assert.include(result.value.message, "<redacted>")
				assert.notInclude(result.value.message, "ghs_secret")
			}
		}),
	)
})

describe("runExec", () => {
	it.effect("runs the command in the checkout and reports its output", () =>
		Effect.gen(function* () {
			const seen: string[] = []
			const response = yield* runExec(
				fakeSandbox([{ exitCode: 0 }, { exitCode: 1, stdout: "src/a.ts:1:x" }], seen),
				request(),
			)
			assert.strictEqual(response._tag, "SandboxExited")
			if (response._tag === "SandboxExited") {
				assert.strictEqual(response.exitCode, 1)
				assert.strictEqual(response.stdout, "src/a.ts:1:x")
			}
			assert.include(seen[1]!, `@${checkoutDir(SHA)}`)
		}),
	)

	it.effect("refuses a no-egress command the container could not isolate", () =>
		Effect.gen(function* () {
			const response = yield* runExec(
				fakeSandbox([{ exitCode: 0 }, { exitCode: SANDBOX_NETNS_UNAVAILABLE_EXIT }]),
				request(),
			)
			assert.strictEqual(response._tag, "SandboxIsolationUnavailable")
		}),
	)

	it.effect("reports output past the bound rather than returning it", () =>
		Effect.gen(function* () {
			const response = yield* runExec(
				fakeSandbox([{ exitCode: 0 }, { exitCode: 0, stdout: "x".repeat(2048) }]),
				request({ maxOutputBytes: 1024 }),
			)
			assert.strictEqual(response._tag, "SandboxOutputExceeded")
			if (response._tag === "SandboxOutputExceeded") assert.strictEqual(response.observed, 2048)
		}),
	)

	it.effect("passes a failed checkout straight back", () =>
		Effect.gen(function* () {
			const response = yield* runExec(fakeSandbox([{ exitCode: 1 }, { exitCode: 128 }]), request())
			assert.strictEqual(response._tag, "SandboxCheckoutFailed")
		}),
	)
})
