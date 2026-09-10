import { assert, describe, it } from "@effect/vitest"
import {
	SANDBOX_CREDENTIAL_PATH,
	SANDBOX_TRAILER,
	SandboxExecRequest,
	shellCommand,
	shellQuote,
} from "@maple/domain/sandbox"
import { Effect, Option } from "effect"
import {
	checkoutDir,
	cloneProcessId,
	cloneScript,
	ensureCheckout,
	parseTrailer,
	runExec,
	wrapCommand,
	type SandboxLike,
	type SandboxProcess,
} from "./checkout"

const SHA = "a".repeat(40)
const TOKEN = "ghs_secret_token"

const checkout = {
	repository: "octo/shop",
	sha: SHA,
	remoteUrl: "https://github.com/octo/shop.git",
	token: TOKEN,
}

const request = (overrides: Partial<SandboxExecRequest> = {}) =>
	new SandboxExecRequest({
		sandboxKey: "org_1:github:octo/shop",
		checkout,
		command: "git",
		args: ["grep", "-e", "card declined"],
		cwd: ".",
		timeoutMs: 30_000,
		maxOutputBytes: 1024,
		...overrides,
	})

const trailer = (
	exitCode: number,
	outBytes: number,
	errBytes: number,
	isolation: "isolated" | "unavailable" = "isolated",
) => `\n${SANDBOX_TRAILER} ${exitCode} ${outBytes} ${errBytes} ${isolation}\n`

interface FakeOptions {
	readonly execs?: ReadonlyArray<{ exitCode?: number; stdout?: string; stderr?: string }>
	readonly process?: SandboxProcess | null
	readonly logs?: { stdout: string; stderr: string }
	readonly rejectExec?: Error
}

/** A container that answers scripted results and records what it was asked to run. */
const fakeSandbox = (options: FakeOptions, seen: string[] = []): SandboxLike => {
	let next = 0
	return {
		exec: async (command, execOptions) => {
			seen.push(`exec:${command}${execOptions?.cwd ? ` @${execOptions.cwd}` : ""}`)
			if (options.rejectExec && next > 0) throw options.rejectExec
			const answer = options.execs?.[next++] ?? {}
			return {
				exitCode: answer.exitCode ?? 0,
				stdout: answer.stdout ?? "",
				stderr: answer.stderr ?? "",
				duration: 7,
			}
		},
		startProcess: async (command, processOptions) => {
			seen.push(`start:${processOptions?.processId}`)
			void command
			return { id: processOptions?.processId ?? "p", status: "running" }
		},
		getProcess: async (id) => {
			seen.push(`get:${id}`)
			return options.process ?? null
		},
		getProcessLogs: async () => options.logs ?? { stdout: "", stderr: "" },
		writeFile: async (path) => {
			seen.push(`write:${path}`)
			return undefined
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
	it("drops privileges and runs only inside its own network namespace", () => {
		const wrapped = wrapCommand(request())
		assert.include(wrapped, "unshare -n")
		assert.include(wrapped, "runuser -u maple-agent --")
		// The probe decides `ns` first, and the command runs only when it is `isolated`,
		// so a container that cannot isolate never runs it with egress.
		assert.isTrue(wrapped.indexOf("unshare -n true") < wrapped.indexOf('if [ "$ns" = isolated ]'))
		assert.include(wrapped, "ns=unavailable")
	})

	it("reports isolation out of band, so a command exiting 97 is not mistaken for one that never ran", () => {
		assert.include(wrapCommand(request()), '"$rc" "$ob" "$eb" "$ns"')
	})

	it("never uses `exec`, which would replace the shell running the wrapper", () => {
		// The trailer is printed after the command returns, so nothing may replace
		// the wrapper's own process.
		assert.notMatch(wrapCommand(request()), /(^|\s)exec\s/)
	})

	it("bounds each stream where it is produced and carries the real exit code out", () => {
		const wrapped = wrapCommand(request({ maxOutputBytes: 2048 }))
		assert.include(wrapped, "head -c 2048")
		assert.include(wrapped, `${SANDBOX_TRAILER} %s %s %s %s`)
		assert.include(wrapped, '"$rc" "$ob" "$eb" "$ns"')
	})
})

describe("parseTrailer", () => {
	it("splits the command's own output from the trailer", () => {
		const parsed = parseTrailer(`hello\nworld${trailer(1, 12, 0)}`)
		assert.isTrue(Option.isSome(parsed))
		if (Option.isSome(parsed)) {
			assert.strictEqual(parsed.value.body, "hello\nworld")
			assert.deepStrictEqual(parsed.value.trailer, {
				exitCode: 1,
				stdoutBytes: 12,
				stderrBytes: 0,
				isolation: "isolated",
			})
		}
	})

	it("takes the last trailer, so output that mimics one cannot displace it", () => {
		const parsed = parseTrailer(`${SANDBOX_TRAILER} 9 9 9 isolated\nreal${trailer(0, 4, 0)}`)
		assert.isTrue(Option.isSome(parsed))
		if (Option.isSome(parsed)) assert.strictEqual(parsed.value.trailer.exitCode, 0)
	})

	it("is none when the wrapper never finished", () => {
		assert.isTrue(Option.isNone(parseTrailer("partial output")))
	})
})

describe("cloneScript", () => {
	it("clones into a unique directory so concurrent callers cannot collide", () => {
		const script = cloneScript(checkout)
		assert.include(script, "mktemp -d")
		// `-T` refuses to nest, so the loser discards its copy instead of corrupting the winner's.
		assert.include(script, `mv -T "$t"`)
		assert.include(script, 'rm -rf "$t"')
	})

	it("keeps the credential out of the command line and removes it afterwards", () => {
		const script = cloneScript(checkout)
		// The token reaches the container through the file API; a command's arguments
		// are readable by the account the agent's own commands run as.
		assert.notInclude(script, TOKEN)
		assert.include(script, SANDBOX_CREDENTIAL_PATH)
		assert.include(script, `rm -f ${SANDBOX_CREDENTIAL_PATH}`)
		assert.isTrue(script.indexOf("clone") < script.indexOf(`rm -f ${SANDBOX_CREDENTIAL_PATH}`))
		assert.include(script, "chmod -R a+rX,go-w")
	})

	it("evicts the oldest checkouts, scratch directories included, so the disk cannot fill", () => {
		const script = cloneScript(checkout)
		assert.include(script, "tail -n +4")
		assert.include(script, ".clone-*/")
	})
})

describe("ensureCheckout", () => {
	it.effect("does nothing when the commit is already checked out", () =>
		Effect.gen(function* () {
			const seen: string[] = []
			const result = yield* ensureCheckout(fakeSandbox({ execs: [{ exitCode: 0 }] }, seen), checkout)
			assert.isTrue(Option.isNone(result))
			assert.strictEqual(seen.length, 1)
			assert.include(seen[0]!, checkoutDir(SHA))
		}),
	)

	it.effect("starts one background clone and reports the checkout as pending", () =>
		Effect.gen(function* () {
			const seen: string[] = []
			const result = yield* ensureCheckout(
				fakeSandbox({ execs: [{ exitCode: 1 }], process: null }, seen),
				checkout,
			)
			assert.isTrue(Option.isSome(result))
			if (Option.isSome(result)) assert.strictEqual(result.value._tag, "SandboxRunCheckoutPending")
			assert.include(seen, `write:${SANDBOX_CREDENTIAL_PATH}`)
			assert.include(seen, `start:${cloneProcessId(SHA)}`)
			// Staged before the clone, never after.
			assert.isTrue(
				seen.indexOf(`write:${SANDBOX_CREDENTIAL_PATH}`) <
					seen.indexOf(`start:${cloneProcessId(SHA)}`),
			)
		}),
	)

	it.effect("joins a clone another call already started rather than starting a second", () =>
		Effect.gen(function* () {
			const seen: string[] = []
			const result = yield* ensureCheckout(
				fakeSandbox(
					{ execs: [{ exitCode: 1 }], process: { id: cloneProcessId(SHA), status: "running" } },
					seen,
				),
				checkout,
			)
			assert.isTrue(Option.isSome(result))
			if (Option.isSome(result)) assert.strictEqual(result.value._tag, "SandboxRunCheckoutPending")
			assert.notInclude(seen.join(" "), "start:")
		}),
	)

	it.effect("reports a failed clone without echoing the credential", () =>
		Effect.gen(function* () {
			const result = yield* ensureCheckout(
				fakeSandbox({
					execs: [{ exitCode: 1 }],
					process: { id: cloneProcessId(SHA), status: "failed", exitCode: 128 },
					logs: { stdout: "", stderr: `fatal: could not read using ${TOKEN}` },
				}),
				checkout,
			)
			assert.isTrue(Option.isSome(result))
			if (Option.isSome(result)) {
				assert.strictEqual(result.value._tag, "SandboxRunCheckoutFailed")
				assert.include(result.value.message, "<redacted>")
				assert.notInclude(result.value.message, TOKEN)
			}
		}),
	)
})

describe("runExec", () => {
	it.effect("runs the command in the checkout and reports the trailer's exit code", () =>
		Effect.gen(function* () {
			const seen: string[] = []
			const response = yield* runExec(
				fakeSandbox(
					{ execs: [{ exitCode: 0 }, { stdout: `src/a.ts:1:x${trailer(1, 12, 0)}` }] },
					seen,
				),
				request(),
			)
			assert.strictEqual(response._tag, "SandboxRunExited")
			if (response._tag === "SandboxRunExited") {
				// The wrapper always exits 0; the command's own status rides the trailer.
				assert.strictEqual(response.exitCode, 1)
				assert.strictEqual(response.stdout, "src/a.ts:1:x")
				assert.isFalse(response.stdoutTruncated)
			}
			assert.include(seen[1]!, `@${checkoutDir(SHA)}`)
		}),
	)

	it.effect("marks a stream the container had to cut", () =>
		Effect.gen(function* () {
			const response = yield* runExec(
				fakeSandbox({ execs: [{ exitCode: 0 }, { stdout: `abc${trailer(0, 99_999, 0)}` }] }),
				request(),
			)
			assert.strictEqual(response._tag, "SandboxRunExited")
			if (response._tag === "SandboxRunExited") {
				assert.isTrue(response.stdoutTruncated)
				assert.strictEqual(response.stdoutBytes, 99_999)
			}
		}),
	)

	it.effect("refuses a no-egress command the container could not isolate", () =>
		Effect.gen(function* () {
			const response = yield* runExec(
				fakeSandbox({ execs: [{ exitCode: 0 }, { stdout: trailer(0, 0, 0, "unavailable") }] }),
				request(),
			)
			assert.strictEqual(response._tag, "SandboxRunIsolationUnavailable")
		}),
	)

	it.effect("reports a wrapper that never finished instead of inventing a result", () =>
		Effect.gen(function* () {
			const response = yield* runExec(
				fakeSandbox({ execs: [{ exitCode: 0 }, { stdout: "no trailer", stderr: "shell died" }] }),
				request(),
			)
			assert.strictEqual(response._tag, "SandboxRunCheckoutFailed")
		}),
	)

	it.effect("reports a timeout as its own outcome", () =>
		Effect.gen(function* () {
			const response = yield* runExec(
				fakeSandbox({
					execs: [{ exitCode: 0 }],
					rejectExec: new Error("Command timeout after 30000ms"),
				}),
				request(),
			)
			assert.strictEqual(response._tag, "SandboxRunTimedOut")
		}),
	)

	it.effect("keeps the credential out of a container error that echoes the command", () =>
		Effect.gen(function* () {
			const failed = yield* Effect.exit(
				runExec(
					fakeSandbox({
						execs: [{ exitCode: 0 }],
						rejectExec: new Error(`Failed to execute 'git clone' with ${TOKEN}`),
					}),
					request(),
				),
			)
			// The Worker redacts before this leaves; here it must at least stay in the
			// typed failure rather than becoming a response the model reads.
			assert.strictEqual(failed._tag, "Failure")
		}),
	)
})
