import { assert, describe, it } from "@effect/vitest"
import {
	SANDBOX_CHECKOUT_GRACE_MINUTES,
	SANDBOX_TRAILER,
	SandboxExecRequest,
	shellCommand,
	shellQuote,
} from "@maple/domain/sandbox"
import { Effect, Option } from "effect"
import {
	CLONE_TOKEN_ENV,
	SandboxCallError,
	checkoutDir,
	checkoutStatusScript,
	cloneRunner,
	cloneScript,
	cloneStateDir,
	commandArgv,
	ensureCheckout,
	execute,
	isTimedOut,
	parseTrailer,
	runExec,
	wrapCommand,
	type SandboxContainer,
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
	/** Answers in order; the first is the checkout status script's. */
	readonly execs?: ReadonlyArray<{
		exitCode?: number
		stdout?: string
		stderr?: string
		timedOut?: boolean
	}>
	readonly failExec?: string
	readonly failSpawn?: string
}

/** A container that answers scripted results and records what it was asked to do. */
const fakeContainer = (options: FakeOptions, seen: string[] = []): SandboxContainer => {
	let next = 0
	return {
		exec: (command, execOptions) =>
			Effect.suspend(() => {
				seen.push(`exec:${command}${execOptions?.cwd ? ` @${execOptions.cwd}` : ""}`)
				if (options.failExec && next > 0)
					return Effect.fail(new SandboxCallError({ message: options.failExec }))
				const answer = options.execs?.[next++] ?? {}
				return Effect.succeed({
					exitCode: answer.exitCode ?? 0,
					stdout: answer.stdout ?? "",
					stderr: answer.stderr ?? "",
					duration: 7,
					timedOut: answer.timedOut ?? false,
				})
			}),
		spawn: (command, env) =>
			Effect.suspend(() => {
				seen.push(`spawn:${Object.keys(env).join(",")}`)
				if (command.includes(TOKEN)) seen.push("TOKEN-IN-COMMAND")
				return options.failSpawn
					? Effect.fail(new SandboxCallError({ message: options.failSpawn }))
					: Effect.void
			}),
	}
}

const status = (stdout: string) => ({ stdout: `${stdout}\n` })

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

	it("reads the token from its own environment, never from its command line", () => {
		const script = cloneScript(checkout)
		assert.notInclude(script, TOKEN)
		assert.include(script, `password=$${CLONE_TOKEN_ENV}`)
		// Dropped once the fetch that needs it is done.
		assert.isTrue(script.indexOf("fetch --quiet") < script.indexOf(`unset ${CLONE_TOKEN_ENV}`))
		assert.include(script, "chmod -R a+rX,go-w")
	})

	it("checks symlinks out as plain files, before the checkout, so none can be followed", () => {
		const script = cloneScript(checkout)
		assert.include(script, `config core.symlinks false`)
		assert.isTrue(script.indexOf("core.symlinks false") < script.indexOf("checkout --quiet --detach"))
	})

	it("evicts the least recently used checkouts, so the disk cannot fill", () => {
		const script = cloneScript(checkout)
		assert.include(script, "tail -n +4")
	})

	it("never evicts a checkout or another clone's scratch directory still in use", () => {
		const script = cloneScript(checkout)
		// Six reviews of one repository at once each held a commit; evicting by count alone deleted
		// checkouts and in-flight clones out from under them.
		assert.include(script, `-maxdepth 0 -mmin +${SANDBOX_CHECKOUT_GRACE_MINUTES}`)
		// A scratch directory goes only once the clone that made it is no longer running.
		assert.include(script, `/.clone-'"$$"-XXXXXX`)
		assert.include(script, `if ! kill -0 "$pid"`)
	})
})

/** The fake container with the Durable Object's mirror backup calls, recorded or failing. */
const withMirror = (container: SandboxContainer, seen: string[]): SandboxContainer => ({
	...container,
	restoreMirror: Effect.sync(() => seen.push("restoreMirror")),
	backupMirror: Effect.sync(() => seen.push("backupMirror")),
})

describe("cloneScript's mirror", () => {
	it("fetches into one shared mirror under a lock, and checks out a shared clone of it", () => {
		const script = cloneScript(checkout)
		assert.include(script, `flock 9`)
		assert.include(script, "fetch --quiet --no-tags")
		assert.include(script, `+${SHA}:refs/maple/${SHA}`)
		assert.include(script, "clone --quiet --shared --no-checkout")
		// The lock is released before the checkout, which is local work another commit need not wait on.
		assert.isTrue(script.indexOf("exec 9>&-") < script.indexOf("checkout --quiet --detach"))
	})

	it("keeps the mirror and its lock out of the agent account's reach", () => {
		const script = cloneScript(checkout)
		assert.isTrue(script.indexOf("umask 022") < script.indexOf("fetch --quiet"))
		assert.include(script, "chmod 600 '/workspace/maple-mirror.lock'")
	})

	it("starts the mirror from a restored seed by moving it, not copying it", () => {
		const script = cloneScript(checkout)
		assert.include(script, `mv -T '/workspace/maple-seed' "$m"`)
		assert.notInclude(script, "cp -a")
		assert.include(script, "gc.auto 0")
	})

	it("fetches with the credential helper, never a token in the URL", () => {
		const script = cloneScript(checkout)
		assert.notInclude(script, TOKEN)
		assert.isTrue(script.indexOf("credential.helper") < script.indexOf("fetch --quiet"))
	})
})

describe("checkoutStatusScript", () => {
	const script = checkoutStatusScript(SHA)
	it("answers ready before it looks at any clone state", () => {
		assert.isTrue(script.indexOf(`${checkoutDir(SHA)}'/.git`) < script.indexOf("exit-code"))
	})

	it("marks a ready checkout as used, so eviction keeps it", () => {
		assert.include(script, `touch -c '${checkoutDir(SHA)}'`)
		assert.isTrue(script.indexOf("touch -c") < script.indexOf("echo ready"))
	})

	it("claims with a mkdir that fails when another caller got there first", () => {
		assert.include(script, `if mkdir '${cloneStateDir(SHA)}' 2>/dev/null; then echo claimed`)
	})

	it("forgets a failed or lost clone as it reports it, so the next call clones again", () => {
		assert.match(script, /echo "failed \$code".*rm -rf/)
		assert.match(script, /echo lost; rm -rf/)
	})
})

describe("cloneRunner", () => {
	it("records the clone's pid, stderr and exit code under its state directory", () => {
		const runner = cloneRunner(checkout)
		const state = cloneStateDir(SHA)
		assert.include(runner, `echo $$ >'${state}'/pid`)
		assert.include(runner, `2>'${state}'/stderr.log`)
		assert.include(runner, `mv '${state}'/exit-code.tmp '${state}'/exit-code`)
		assert.notInclude(runner, TOKEN)
	})
})

describe("ensureCheckout", () => {
	it.effect("restores the mirror backup before starting a claimed clone", () =>
		Effect.gen(function* () {
			const seen: string[] = []
			yield* ensureCheckout(
				withMirror(fakeContainer({ execs: [status("claimed")] }, seen), seen),
				checkout,
			)
			assert.isTrue(seen.indexOf("restoreMirror") < seen.indexOf(`spawn:${CLONE_TOKEN_ENV}`))
			assert.notInclude(seen, "backupMirror")
		}),
	)

	it.effect("asks for a mirror backup once a checkout is ready", () =>
		Effect.gen(function* () {
			const seen: string[] = []
			const result = yield* ensureCheckout(
				withMirror(fakeContainer({ execs: [status("ready")] }, seen), seen),
				checkout,
			)
			assert.isTrue(Option.isNone(result))
			assert.include(seen, "backupMirror")
			assert.notInclude(seen, "restoreMirror")
		}),
	)

	it.effect("does nothing more when the commit is already checked out", () =>
		Effect.gen(function* () {
			const seen: string[] = []
			const result = yield* ensureCheckout(fakeContainer({ execs: [status("ready")] }, seen), checkout)
			assert.isTrue(Option.isNone(result))
			assert.strictEqual(seen.length, 1)
		}),
	)

	it.effect("starts the claimed clone with the token in its environment only", () =>
		Effect.gen(function* () {
			const seen: string[] = []
			const result = yield* ensureCheckout(
				fakeContainer({ execs: [status("claimed")] }, seen),
				checkout,
			)
			assert.isTrue(Option.isSome(result))
			if (Option.isSome(result)) assert.strictEqual(result.value._tag, "SandboxRunCheckoutPending")
			assert.include(seen, `spawn:${CLONE_TOKEN_ENV}`)
			assert.notInclude(seen, "TOKEN-IN-COMMAND")
		}),
	)

	it.effect("releases the claim when the clone cannot be started", () =>
		Effect.gen(function* () {
			const seen: string[] = []
			const failed = yield* Effect.exit(
				ensureCheckout(
					fakeContainer({ execs: [status("claimed")], failSpawn: "no container" }, seen),
					checkout,
				),
			)
			assert.strictEqual(failed._tag, "Failure")
			assert.include(seen.at(-1)!, `rm -rf '${cloneStateDir(SHA)}'`)
		}),
	)

	it.effect("waits on a clone another call already started rather than starting a second", () =>
		Effect.gen(function* () {
			const seen: string[] = []
			const result = yield* ensureCheckout(
				fakeContainer({ execs: [status("cloning")] }, seen),
				checkout,
			)
			assert.isTrue(Option.isSome(result))
			if (Option.isSome(result)) assert.strictEqual(result.value._tag, "SandboxRunCheckoutPending")
			assert.notInclude(seen.join(" "), "spawn:")
		}),
	)

	it.effect("reports a failed clone without echoing the token", () =>
		Effect.gen(function* () {
			const result = yield* ensureCheckout(
				fakeContainer({ execs: [status(`failed 128\nfatal: could not read using ${TOKEN}`)] }),
				checkout,
			)
			assert.isTrue(Option.isSome(result))
			if (Option.isSome(result)) {
				assert.strictEqual(result.value._tag, "SandboxRunCheckoutFailed")
				assert.include(result.value.message, "exit 128")
				assert.include(result.value.message, "<redacted>")
				assert.notInclude(result.value.message, TOKEN)
			}
		}),
	)

	it.effect("reports a clone that died without an exit code", () =>
		Effect.gen(function* () {
			const result = yield* ensureCheckout(fakeContainer({ execs: [status("lost")] }), checkout)
			assert.isTrue(Option.isSome(result) && result.value._tag === "SandboxRunCheckoutFailed")
		}),
	)
})

describe("runExec", () => {
	it.effect("runs the command in the checkout and reports the trailer's exit code", () =>
		Effect.gen(function* () {
			const seen: string[] = []
			const response = yield* runExec(
				fakeContainer(
					{ execs: [status("ready"), { stdout: `src/a.ts:1:x${trailer(1, 12, 0)}` }] },
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
				fakeContainer({ execs: [status("ready"), { stdout: `abc${trailer(0, 99_999, 0)}` }] }),
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
				fakeContainer({ execs: [status("ready"), { stdout: trailer(0, 0, 0, "unavailable") }] }),
				request(),
			)
			assert.strictEqual(response._tag, "SandboxRunIsolationUnavailable")
		}),
	)

	it.effect("reports a wrapper that never finished instead of inventing a result", () =>
		Effect.gen(function* () {
			const response = yield* runExec(
				fakeContainer({ execs: [status("ready"), { stdout: "no trailer", stderr: "shell died" }] }),
				request(),
			)
			assert.strictEqual(response._tag, "SandboxRunCheckoutFailed")
		}),
	)

	it.effect("reports a timeout as its own outcome", () =>
		Effect.gen(function* () {
			const response = yield* runExec(
				fakeContainer({ execs: [status("ready"), { exitCode: 124, timedOut: true }] }),
				request(),
			)
			assert.strictEqual(response._tag, "SandboxRunTimedOut")
		}),
	)

	it.effect("stays a typed failure when the container errors", () =>
		Effect.gen(function* () {
			const failed = yield* Effect.exit(
				runExec(
					fakeContainer({ execs: [status("ready")], failExec: "the container stopped" }),
					request(),
				),
			)
			assert.strictEqual(failed._tag, "Failure")
		}),
	)
})

describe("execute", () => {
	it.effect("answers a container failure as unavailable, with the token redacted", () =>
		Effect.gen(function* () {
			const response = yield* execute(
				fakeContainer({
					execs: [status("ready")],
					failExec: `Failed to execute 'git clone' with ${TOKEN}`,
				}),
				request(),
			)
			assert.strictEqual(response._tag, "SandboxRunUnavailable")
			if (response._tag === "SandboxRunUnavailable") {
				assert.notInclude(response.message, TOKEN)
				assert.include(response.message, "<redacted>")
			}
		}),
	)
})

describe("commandArgv", () => {
	it("runs the command string in bash", () => {
		assert.deepStrictEqual(commandArgv("echo hi"), ["bash", "-c", "echo hi"])
	})

	it("bounds it with coreutils timeout, rounding up to whole seconds", () => {
		assert.deepStrictEqual(commandArgv("echo hi", 1_500), [
			"timeout",
			"--kill-after=5",
			"2",
			"bash",
			"-c",
			"echo hi",
		])
	})
})

describe("isTimedOut", () => {
	it("reads TERM and KILL exits past the deadline as a timeout", () => {
		assert.isTrue(isTimedOut(124, 30_000, 30_000))
		assert.isTrue(isTimedOut(137, 35_100, 30_000))
	})

	it("leaves a command's own 124 alone when it exited early", () => {
		assert.isFalse(isTimedOut(124, 200, 30_000))
		assert.isFalse(isTimedOut(124, 200))
	})
})
