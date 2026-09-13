/**
 * What the sandbox Worker asks its container to do.
 *
 * Kept apart from `worker.ts` so it can be unit-tested without a Worker
 * runtime: everything here is a function of a minimal `SandboxLike` port, which
 * Cloudflare's `Sandbox` satisfies structurally.
 *
 * Two facts about that container drive most of the shape below. Commands run
 * sessionlessly, one fresh process each — a shared shell would carry `set -e`
 * and an `exec` from one command into the next. And a request is capped well
 * below what a cold `git clone` of a real repository takes, so the clone is a
 * background process this polls rather than something a request waits on.
 */
import {
	SANDBOX_COMMAND_ENV,
	SANDBOX_MAX_CHECKOUTS,
	SANDBOX_RUN_AS_USER,
	SANDBOX_TRAILER,
	SANDBOX_WORKSPACE_ROOT,
	SandboxCheckout,
	SandboxExecRequest,
	SandboxRunCheckoutFailed,
	SandboxRunCheckoutPending,
	SandboxRunExited,
	SandboxRunIsolationUnavailable,
	SandboxRunTimedOut,
	boundMessage,
	redactSecret,
	sandboxCredentialPath,
	shellCommand,
	shellQuote,
	type SandboxExecResponse,
} from "@maple/domain/sandbox"
import { Effect, Option, Schema } from "effect"

export interface SandboxExecResult {
	readonly exitCode: number
	readonly stdout: string
	readonly stderr: string
	readonly duration: number
}

/** What the container reports after a write. Only the outcome matters here. */
export interface SandboxWriteResult {
	readonly success: boolean
}

export interface SandboxProcess {
	readonly id: string
	readonly status: "starting" | "running" | "completed" | "failed" | "killed" | "error"
	readonly exitCode?: number | undefined
}

/** The slice of Cloudflare's `Sandbox` this Worker uses. */
export interface SandboxLike {
	readonly exec: (
		command: string,
		options?: { readonly cwd?: string; readonly timeout?: number },
	) => Promise<SandboxExecResult>
	readonly startProcess: (
		command: string,
		options?: { readonly processId?: string },
	) => Promise<SandboxProcess>
	readonly getProcess: (id: string) => Promise<SandboxProcess | null>
	readonly getProcessLogs: (id: string) => Promise<{ readonly stdout: string; readonly stderr: string }>
	/**
	 * Writes through the container's file API, so the content travels in a request
	 * body. Anything handed to a command instead would sit in `/proc/<pid>/cmdline`,
	 * which the unprivileged account can read.
	 */
	readonly writeFile: (path: string, content: string) => Promise<SandboxWriteResult>
}

export class SandboxCallError extends Schema.TaggedError<SandboxCallError>()(
	"@maple/sandbox/SandboxCallError",
	{ message: Schema.String, cause: Schema.optionalKey(Schema.Defect()) },
) {}

const TIMED_OUT = /timed?\s?out/i

const call = (sandbox: SandboxLike, command: string, options?: { cwd?: string; timeout?: number }) =>
	Effect.tryPromise({
		try: () => sandbox.exec(command, options),
		catch: (cause) =>
			new SandboxCallError({
				message: cause instanceof Error ? cause.message : "the sandbox container did not answer",
				cause,
			}),
	})

const promise = <A>(run: () => Promise<A>, what: string) =>
	Effect.tryPromise({
		try: run,
		catch: (cause) =>
			new SandboxCallError({
				message:
					cause instanceof Error ? cause.message : `the sandbox container did not answer (${what})`,
				cause,
			}),
	})

/** A commit's checkout directory. */
export const checkoutDir = (sha: string): string => `${SANDBOX_WORKSPACE_ROOT}/${sha}`

/** One clone per commit, named so two concurrent callers join the same background process. */
export const cloneProcessId = (sha: string): string => `maple-clone-${sha}`

const utf8 = new TextEncoder()

/**
 * A shell program that runs `command` as the unprivileged account, bounds each
 * output stream where it is produced, and — when the request asked for it —
 * inside a fresh network namespace.
 *
 * The namespace is probed in the same program rather than beforehand, so a
 * container that cannot provide one refuses the command instead of running it
 * with egress. Nothing here may `exec`: commands run sessionlessly, but the
 * trailer has to be printed after the command returns.
 */
export const wrapCommand = (
	request: Pick<SandboxExecRequest, "command" | "args" | "maxOutputBytes">,
): string => {
	const environment = Object.entries(SANDBOX_COMMAND_ENV)
		.map(([name, value]) => `${name}=${shellQuote(value)}`)
		.join(" ")
	// `runuser` first, then `env -i`: the command starts from an empty environment
	// and receives only the names the contract's allowlist covers. The other order
	// looks equivalent and is not — `runuser` adds `USER` and `LOGNAME` after
	// `env -i` has run, so the command would see five names while `admit` promised
	// three, and `runuser` itself would have to be found on the command's PATH.
	const dropped = `runuser -u ${SANDBOX_RUN_AS_USER} -- env -i ${environment} ${shellCommand(request.command, request.args)}`
	const limit = String(Math.max(1, Math.floor(request.maxOutputBytes)))
	// Streams land in files, are cut to the bound, and the real exit status rides
	// the trailer — piping through `head` directly would report `head`'s status.
	// The command runs only if its own network namespace could be opened, so one
	// that asked for no egress never runs with some.
	return [
		`o=$(mktemp) && e=$(mktemp)`,
		`if unshare -n true 2>/dev/null; then ns=isolated; else ns=unavailable; fi`,
		`rc=0`,
		`if [ "$ns" = isolated ]; then { unshare -n ${dropped}; } >"$o" 2>"$e"; rc=$?; fi`,
		`ob=$(wc -c <"$o") && eb=$(wc -c <"$e")`,
		`head -c ${limit} "$o"`,
		`head -c ${limit} "$e" >&2`,
		`rm -f "$o" "$e"`,
		`printf '\n${SANDBOX_TRAILER} %s %s %s %s\n' "$rc" "$ob" "$eb" "$ns"`,
	].join("\n")
}

interface Trailer {
	readonly exitCode: number
	readonly stdoutBytes: number
	readonly stderrBytes: number
	readonly isolation: "isolated" | "unavailable"
}

/**
 * Read the wrapper's trailer off the end of stdout.
 *
 * The last match wins, because a command is free to print the sentinel itself —
 * it can only mislead its own caller, which is the same agent.
 */
export const parseTrailer = (
	stdout: string,
): Option.Option<{ readonly body: string; readonly trailer: Trailer }> => {
	const at = stdout.lastIndexOf(SANDBOX_TRAILER)
	if (at === -1) return Option.none()
	const parts = stdout
		.slice(at + SANDBOX_TRAILER.length)
		.trim()
		.split(/\s+/)
	const [exitCode, stdoutBytes, stderrBytes] = parts.slice(0, 3).map(Number)
	const isolation = parts[3]
	if (
		parts.length < 4 ||
		exitCode === undefined ||
		stdoutBytes === undefined ||
		stderrBytes === undefined ||
		![exitCode, stdoutBytes, stderrBytes].every(Number.isFinite) ||
		(isolation !== "isolated" && isolation !== "unavailable")
	)
		return Option.none()
	// The wrapper prints a newline before the sentinel; drop exactly that one.
	const body = stdout.slice(0, at).replace(/\n$/, "")
	return Option.some({ body, trailer: { exitCode, stdoutBytes, stderrBytes, isolation } })
}

/** The clone, as a single shell program run in the background. */
export const cloneScript = (checkout: SandboxCheckout): string => {
	const dir = checkoutDir(checkout.sha)
	const credential = sandboxCredentialPath(checkout.sha)
	// The token is read out of a root-only file by a credential helper rather than
	// carried in the URL: this process's arguments are readable by the account the
	// agent's own commands run as, and the two overlap by design.
	const helper = `!f() { echo username=x-access-token; echo "password=$(cat ${credential})"; }; f`
	return [
		"set -e",
		// `set -e` exits the moment a clone fails, so removal cannot be a later
		// line in the script: the trap is what guarantees the token leaves disk
		// on every path out.
		`trap 'rm -f ${credential}' EXIT`,
		`id -u ${SANDBOX_RUN_AS_USER} >/dev/null 2>&1 || useradd --system --no-create-home --home-dir /tmp --shell /usr/sbin/nologin ${SANDBOX_RUN_AS_USER}`,
		// Commands run as an account that does not own the tree, which git refuses to read without this.
		`git config --system --replace-all safe.directory '*'`,
		`chmod 600 ${credential}`,
		`mkdir -p ${shellQuote(SANDBOX_WORKSPACE_ROOT)}`,
		`t=$(mktemp -d ${shellQuote(`${SANDBOX_WORKSPACE_ROOT}/.clone-XXXXXX`)})`,
		`git -c ${shellQuote(`credential.helper=${helper}`)} clone --quiet --no-checkout ${shellQuote(checkout.remoteUrl)} "$t"`,
		`git -C "$t" checkout --quiet --detach ${shellQuote(checkout.sha)}`,
		// Nothing may leave the credential behind, in git's config or on disk.
		`git -C "$t" config --unset-all credential.helper 2>/dev/null || true`,
		`rm -f ${credential}`,
		// Readable and traversable by the agent account, writable by nobody but root.
		// `mktemp -d` creates the directory mode 700, so read and execute have to be
		// added back — removing write alone would leave a tree nothing else can enter.
		`chmod -R a+rX,go-w "$t"`,
		// `-T` refuses to nest inside an existing directory, so a checkout another
		// caller finished first stands and this one's copy is discarded.
		`mv -T "$t" ${shellQuote(dir)} 2>/dev/null || rm -rf "$t"`,
		// Keep the newest few commits and drop the rest; a container's disk is small
		// and every distinct commit an investigation touches leaves one behind. The
		// glob covers the `.clone-*` scratch directories a failed clone leaves too.
		`ls -1dt ${shellQuote(SANDBOX_WORKSPACE_ROOT)}/*/ ${shellQuote(SANDBOX_WORKSPACE_ROOT)}/.clone-*/ 2>/dev/null | tail -n +${SANDBOX_MAX_CHECKOUTS + 1} | while read -r old; do chmod -R u+w "$old" && rm -rf "$old"; done`,
		"true",
	].join("\n")
}

/**
 * Make sure the commit is checked out, starting the clone if nobody has.
 *
 * `Option.none` means ready. Anything else is the answer the caller should
 * return as-is: still preparing, or a clone that failed.
 */
export const ensureCheckout = (
	sandbox: SandboxLike,
	checkout: SandboxCheckout,
): Effect.Effect<Option.Option<SandboxRunCheckoutPending | SandboxRunCheckoutFailed>, SandboxCallError> =>
	Effect.gen(function* () {
		const dir = checkoutDir(checkout.sha)
		const redact = (text: string) => boundMessage(redactSecret(text, checkout.token))
		const present = yield* call(sandbox, `test -d ${shellQuote(`${dir}/.git`)}`)
		if (present.exitCode === 0) return Option.none()

		const id = cloneProcessId(checkout.sha)
		const running = yield* promise(() => sandbox.getProcess(id), "getProcess")
		if (running === null) {
			// Through the file API, so the token travels in a request body. Anything
			// handed to a command would sit in `/proc/<pid>/cmdline`, which the account
			// the agent's own commands run as can read — and the clone overlaps them by
			// design.
			yield* promise(
				() => sandbox.writeFile(sandboxCredentialPath(checkout.sha), checkout.token),
				"writeFile",
			)
			yield* promise(
				() => sandbox.startProcess(cloneScript(checkout), { processId: id }),
				"startProcess",
			)
			return Option.some(
				new SandboxRunCheckoutPending({
					message: `Preparing a checkout of ${checkout.repository} at ${checkout.sha}. Call again in a few seconds.`,
				}),
			)
		}
		if (running.status === "starting" || running.status === "running")
			return Option.some(
				new SandboxRunCheckoutPending({
					message: `The checkout of ${checkout.repository} at ${checkout.sha} is still being prepared. Call again in a few seconds.`,
				}),
			)
		// Completed, but the directory is not there: the clone lost a race and
		// discarded its copy, or it failed. Its own logs say which.
		if (running.status === "completed" && running.exitCode === 0)
			return Option.some(
				new SandboxRunCheckoutPending({
					message: `The checkout of ${checkout.repository} at ${checkout.sha} has just finished. Call again.`,
				}),
			)
		const logs = yield* promise(() => sandbox.getProcessLogs(id), "getProcessLogs").pipe(
			Effect.orElseSucceed(() => ({ stdout: "", stderr: "" })),
		)
		return Option.some(
			new SandboxRunCheckoutFailed({
				message: redact(
					`Cloning ${checkout.repository} failed (${running.status}, exit ${running.exitCode ?? "unknown"}): ${logs.stderr.trim().slice(0, 500)}`,
				),
			}),
		)
	})

/** Run one request end to end: prepare the commit if needed, then the command. */
export const runExec = (
	sandbox: SandboxLike,
	request: SandboxExecRequest,
): Effect.Effect<SandboxExecResponse, SandboxCallError> =>
	Effect.gen(function* () {
		const notReady = yield* ensureCheckout(sandbox, request.checkout)
		if (Option.isSome(notReady)) return notReady.value
		const dir = checkoutDir(request.checkout.sha)
		const cwd = request.cwd === "." || request.cwd === "" ? dir : `${dir}/${request.cwd}`
		const result = yield* call(sandbox, wrapCommand(request), { cwd, timeout: request.timeoutMs }).pipe(
			Effect.asSome,
			// Cloudflare's client rejects a command that outran its timeout. Matching
			// the message is a heuristic: a transport timeout would read the same way,
			// and would be reported to the caller as its own command timing out.
			Effect.catchIf(
				(error) => TIMED_OUT.test(error.message),
				() => Effect.succeedNone,
			),
		)
		if (Option.isNone(result)) return new SandboxRunTimedOut({ wallTimeMs: request.timeoutMs })

		const parsed = parseTrailer(result.value.stdout)
		if (Option.isNone(parsed)) {
			// No trailer means the wrapper itself never finished — the shell died, or
			// the container answered something else entirely.
			return new SandboxRunCheckoutFailed({
				message: boundMessage(
					redactSecret(
						`The sandbox did not run the command: ${result.value.stderr.trim().slice(0, 500) || "no output"}`,
						request.checkout.token,
					),
				),
			})
		}
		const { body, trailer } = parsed.value
		if (trailer.isolation === "unavailable")
			return new SandboxRunIsolationUnavailable({
				message:
					"this container cannot open a network namespace, so a command requiring no egress was refused",
			})
		const stderr = result.value.stderr
		return new SandboxRunExited({
			exitCode: trailer.exitCode,
			stdout: body,
			stderr,
			stdoutBytes: trailer.stdoutBytes,
			stderrBytes: trailer.stderrBytes,
			stdoutTruncated: trailer.stdoutBytes > utf8.encode(body).length,
			stderrTruncated: trailer.stderrBytes > utf8.encode(stderr).length,
			wallTimeMs: result.value.duration,
		})
	})
