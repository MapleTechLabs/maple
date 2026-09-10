/**
 * What the sandbox Worker asks its container to do.
 *
 * Kept apart from `worker.ts` so it can be unit-tested without a Worker
 * runtime: everything here is a function of a minimal `SandboxLike` port, which
 * Cloudflare's `Sandbox` satisfies structurally.
 */
import {
	SANDBOX_NETNS_UNAVAILABLE_EXIT,
	SANDBOX_COMMAND_ENV,
	SANDBOX_RUN_AS_USER,
	SANDBOX_WORKSPACE_ROOT,
	SandboxCheckout,
	SandboxCheckoutFailed,
	SandboxExecRequest,
	SandboxExited,
	SandboxIsolationUnavailable,
	SandboxOutputExceeded,
	SandboxTimedOut,
	shellCommand,
	shellQuote,
	type SandboxExecResponse,
} from "@maple/domain/sandbox"
import { Effect, Option, Schema } from "effect"

/** The slice of Cloudflare's `Sandbox` this Worker uses. */
export interface SandboxLike {
	readonly exec: (
		command: string,
		options?: { readonly cwd?: string; readonly timeout?: number },
	) => Promise<{
		readonly exitCode: number
		readonly stdout: string
		readonly stderr: string
		readonly duration: number
	}>
}

export class SandboxCallError extends Schema.TaggedError<SandboxCallError>()(
	"@maple/sandbox/SandboxCallError",
	{ message: Schema.String, cause: Schema.optionalKey(Schema.Defect()) },
) {}

const call = (sandbox: SandboxLike, command: string, options?: { cwd?: string; timeout?: number }) =>
	Effect.tryPromise({
		try: () => sandbox.exec(command, options),
		catch: (cause) =>
			new SandboxCallError({
				message: cause instanceof Error ? cause.message : "the sandbox container did not answer",
				cause,
			}),
	})

/** A commit's checkout directory. The key is already `<org>:<provider>:<owner/name>`. */
export const checkoutDir = (sha: string): string => `${SANDBOX_WORKSPACE_ROOT}/${sha}`

const utf8 = new TextEncoder()

/** A clone can be a large repository on a cold container, so it gets its own budget. */
const CLONE_TIMEOUT_MS = 180_000

const TIMED_OUT = /timed?\s?out/i
const TIMEOUT = Symbol.for("@maple/sandbox/timeout")

/** Keep a credential-bearing URL out of anything that travels back to the caller. */
const redact = (text: string, secret: string): string => text.replaceAll(secret, "<redacted>")

/**
 * A shell program that runs `command` as the unprivileged account, and — when
 * the request asked for it — inside a fresh network namespace.
 *
 * The namespace is probed in the same program rather than beforehand, so a
 * container that cannot provide one refuses the command instead of running it
 * with egress. `exec` replaces the shell so signals and the exit code pass
 * through unchanged.
 */
export const wrapCommand = (
	command: string,
	args: ReadonlyArray<string>,
	network: "disabled" | "enabled",
): string => {
	const environment = Object.entries(SANDBOX_COMMAND_ENV)
		.map(([name, value]) => `${name}=${shellQuote(value)}`)
		.join(" ")
	// `env -i` first: the command starts from an empty environment and receives
	// only the names the contract's allowlist covers, whatever else the container holds.
	const dropped = `env -i ${environment} runuser -u ${SANDBOX_RUN_AS_USER} -- ${shellCommand(command, args)}`
	if (network === "enabled") return dropped
	return `if unshare -n true 2>/dev/null; then exec unshare -n ${dropped}; else exit ${SANDBOX_NETNS_UNAVAILABLE_EXIT}; fi`
}

/**
 * Prepare the container once per commit: the unprivileged account, a full clone
 * at that commit, and the credential scrubbed back out of git's config.
 *
 * The clone is deliberately not shallow — history is the reason this runs a real
 * git checkout rather than unpacking an archive. `safe.directory` is set because
 * commands run as an account that does not own the tree, which git otherwise
 * refuses to read.
 *
 * A failed clone is a response, not an error: it is something the calling agent
 * can read and act on, unlike a container that never answered.
 */
export const ensureCheckout = (
	sandbox: SandboxLike,
	checkout: SandboxCheckout,
): Effect.Effect<Option.Option<SandboxCheckoutFailed>, SandboxCallError> =>
	Effect.gen(function* () {
		const dir = checkoutDir(checkout.sha)
		const present = yield* call(sandbox, `test -d ${shellQuote(`${dir}/.git`)}`)
		if (present.exitCode === 0) return Option.none()
		const script = [
			"set -e",
			`id -u ${SANDBOX_RUN_AS_USER} >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin ${SANDBOX_RUN_AS_USER}`,
			`git config --system --replace-all safe.directory '*'`,
			`rm -rf ${shellQuote(`${dir}.partial`)}`,
			`mkdir -p ${shellQuote(SANDBOX_WORKSPACE_ROOT)}`,
			`git clone --quiet --no-checkout ${shellQuote(checkout.cloneUrl)} ${shellQuote(`${dir}.partial`)}`,
			// The token has done its job; nothing below may leave it on disk.
			`git -C ${shellQuote(`${dir}.partial`)} remote set-url origin ${shellQuote(checkout.remoteUrl)}`,
			`git -C ${shellQuote(`${dir}.partial`)} checkout --quiet --detach ${shellQuote(checkout.sha)}`,
			// Readable by the agent account, writable by nobody but root.
			`chmod -R go-w ${shellQuote(`${dir}.partial`)}`,
			`mv ${shellQuote(`${dir}.partial`)} ${shellQuote(dir)}`,
		].join("\n")
		const cloned = yield* call(sandbox, script, { timeout: CLONE_TIMEOUT_MS })
		if (cloned.exitCode === 0) return Option.none()
		// The clone URL carries a credential, so only git's own message goes back.
		return Option.some(
			new SandboxCheckoutFailed({
				message: `git clone failed with ${cloned.exitCode}: ${redact(cloned.stderr, checkout.cloneUrl).trim().slice(0, 500)}`,
			}),
		)
	})

/** Run one request end to end: prepare the commit if needed, then the command. */
export const runExec = (
	sandbox: SandboxLike,
	request: SandboxExecRequest,
): Effect.Effect<SandboxExecResponse, SandboxCallError> =>
	Effect.gen(function* () {
		const failed = yield* ensureCheckout(sandbox, request.checkout)
		if (Option.isSome(failed)) return failed.value
		const dir = checkoutDir(request.checkout.sha)
		const cwd = request.cwd === "." || request.cwd === "" ? dir : `${dir}/${request.cwd}`
		const result = yield* call(sandbox, wrapCommand(request.command, request.args, request.network), {
			cwd,
			timeout: request.timeoutMs,
		}).pipe(
			// Cloudflare's client rejects a command that outran its timeout. The
			// request's own bound is the only one in play, so that is what is reported.
			Effect.catch((error) =>
				TIMED_OUT.test(error.message) ? Effect.succeed(TIMEOUT) : Effect.fail(error),
			),
		)
		if (result === TIMEOUT) return new SandboxTimedOut({ wallTimeMs: request.timeoutMs })
		if (result.exitCode === SANDBOX_NETNS_UNAVAILABLE_EXIT && request.network === "disabled") {
			return new SandboxIsolationUnavailable({
				message:
					"this container cannot open a network namespace, so a command requiring no egress was refused",
			})
		}
		const stdoutBytes = utf8.encode(result.stdout).length
		const stderrBytes = utf8.encode(result.stderr).length
		if (stdoutBytes > request.maxOutputBytes)
			return new SandboxOutputExceeded({
				stream: "stdout",
				limit: request.maxOutputBytes,
				observed: stdoutBytes,
			})
		if (stderrBytes > request.maxOutputBytes)
			return new SandboxOutputExceeded({
				stream: "stderr",
				limit: request.maxOutputBytes,
				observed: stderrBytes,
			})
		return new SandboxExited({
			exitCode: result.exitCode,
			stdout: result.stdout,
			stderr: result.stderr,
			stdoutBytes,
			stderrBytes,
			wallTimeMs: result.duration,
		})
	})
