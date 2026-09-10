/**
 * The wire between the api Worker and the sandbox Worker.
 *
 * The sandbox Worker hosts Cloudflare's Sandbox Durable Object, so it owns the
 * container and the checkout; the api owns the tenant, the credential and the
 * decision to run anything at all. Everything below crosses a service binding
 * as JSON, so it is data only.
 *
 * The `SandboxRun*` names are deliberate: `@effect-agent/sandbox` has its own
 * `SandboxExited` and friends, and both sets meet in the api's port. Distinct
 * names keep a `switch` on one from silently reading like the other.
 */
import { Schema } from "effect"

/** Where checkouts live inside the container; one directory per commit. */
export const SANDBOX_WORKSPACE_ROOT = "/workspace/maple"

/** The unprivileged account every agent command runs as. Created on first checkout. */
export const SANDBOX_RUN_AS_USER = "maple-agent"

/**
 * The entire environment an agent command sees. The wrapper starts from an empty
 * one (`env -i`) and sets exactly these, so the contract's environment allowlist
 * is enforced rather than described: nothing else in the container's environment
 * can reach a command, whatever a request asks for.
 */
export const SANDBOX_COMMAND_ENV = {
	PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
	HOME: "/tmp",
	LANG: "C.UTF-8",
} as const satisfies Readonly<Record<string, string>>

/**
 * Where the clone's credential is staged inside the container.
 *
 * It is written through the container's file API rather than named in a command,
 * because every process's arguments are readable by the unprivileged account
 * (`/proc/<pid>/cmdline`) while agent commands and a background clone overlap by
 * design. `/root` is not readable by that account.
 */
export const SANDBOX_CREDENTIAL_PATH = "/root/.maple-clone-credential"

/**
 * Trailer the wrapper prints after the command's own output, carrying the real
 * exit code and whether either stream was cut.
 *
 * It exists because the output bound has to be applied where the bytes are
 * produced — Cloudflare's `exec` materialises whole strings, so checking after
 * the fact spends the memory it was meant to save, and a caller asking for 48 KiB
 * of a large `git ls-files` got nothing at all instead of the first 48 KiB. Piping
 * through `head` costs the command's exit status, which is load-bearing (`git grep`
 * exits 1 on no matches), so the status travels here instead.
 */
export const SANDBOX_TRAILER = "__maple_sandbox_trailer__"

/**
 * Whether the wrapper could put the command in its own network namespace.
 *
 * A field rather than a reserved exit code: the trailer also carries the
 * command's real status, and a command that exits 97 of its own accord must not
 * be reported as one that never ran.
 */
export const SandboxIsolationState = Schema.Literals(["isolated", "unavailable"])
export type SandboxIsolationState = typeof SandboxIsolationState.Type

/** How many checkouts a container keeps before the least recently used are dropped. */
export const SANDBOX_MAX_CHECKOUTS = 3

/** Bounded so a container's diagnostic can never overflow the agent contract's own limits. */
const BoundedMessage = Schema.String.check(Schema.isMaxLength(4 * 1024))

/**
 * How the sandbox obtains the repository. `cloneUrl` carries a short-lived,
 * repository-scoped credential and is used once; `remoteUrl` replaces it in the
 * checkout's git config immediately afterwards, so no token is left on disk.
 */
/** A commit, as the only thing the sandbox will check out. */
export const SandboxCommitSha = Schema.String.check(Schema.isPattern(/^[0-9a-f]{40}$/))

/**
 * A checkout-relative directory. Validated here as well as at the api's own
 * boundary: the sandbox Worker trusts its caller, and this is the schema that
 * would stop a regression there from reaching the container's filesystem.
 */
export const SandboxRelativePath = Schema.String.check(
	Schema.isMaxLength(1024),
	Schema.makeFilter(
		(value: string) =>
			!value.startsWith("/") &&
			!value.split("/").includes("..") &&
			// eslint-disable-next-line no-control-regex
			!/[\u0000-\u001f]/.test(value),
		{ title: "sandboxRelativePath", expected: "a checkout-relative path with no `..` segment" },
	),
)

/** A program name or argument. Control characters are refused: they truncate the shell program. */
export const SandboxArgument = Schema.String.check(
	Schema.isMaxLength(4096),
	// eslint-disable-next-line no-control-regex
	Schema.makeFilter((value: string) => !/[\u0000]/.test(value), {
		title: "sandboxArgument",
		expected: "text with no NUL byte",
	}),
)

export class SandboxCheckout extends Schema.Class<SandboxCheckout>("SandboxCheckout")({
	repository: Schema.String,
	sha: SandboxCommitSha,
	/** Carries no credential; the token below is staged separately. */
	remoteUrl: Schema.String,
	/** Short-lived and scoped to this repository. Never placed in a command's arguments. */
	token: Schema.String,
}) {}

export class SandboxExecRequest extends Schema.Class<SandboxExecRequest>("SandboxExecRequest")({
	/** One Cloudflare sandbox per repository per organization. */
	sandboxKey: Schema.String,
	checkout: SandboxCheckout,
	command: SandboxArgument,
	args: Schema.Array(SandboxArgument).check(Schema.isMaxLength(64)),
	/** Checkout-relative; `.` is the repository root. */
	cwd: SandboxRelativePath,
	timeoutMs: Schema.Finite,
	maxOutputBytes: Schema.Finite,
}) {}

export class SandboxRunExited extends Schema.TaggedClass<SandboxRunExited>()("SandboxRunExited", {
	exitCode: Schema.Number,
	stdout: Schema.String,
	stderr: Schema.String,
	stdoutBytes: Schema.Number,
	stderrBytes: Schema.Number,
	/** The stream was cut at `maxOutputBytes`; what came back is its prefix. */
	stdoutTruncated: Schema.Boolean,
	stderrTruncated: Schema.Boolean,
	wallTimeMs: Schema.Number,
}) {}

export class SandboxRunTimedOut extends Schema.TaggedClass<SandboxRunTimedOut>()("SandboxRunTimedOut", {
	wallTimeMs: Schema.Number,
}) {}

/**
 * The clone for this commit is still running.
 *
 * A first checkout of a large repository outlives any single request — the
 * container SDK caps a request well below what a cold clone can take — so the
 * clone runs as a background process and this says "ask again shortly". It is
 * not a failure, and the caller should surface it as retryable.
 */
export class SandboxRunCheckoutPending extends Schema.TaggedClass<SandboxRunCheckoutPending>()(
	"SandboxRunCheckoutPending",
	{ message: BoundedMessage },
) {}

export class SandboxRunCheckoutFailed extends Schema.TaggedClass<SandboxRunCheckoutFailed>()(
	"SandboxRunCheckoutFailed",
	{ message: BoundedMessage },
) {}

/**
 * The container refused to open a network namespace, so `network: "disabled"`
 * could not be honoured. The command was not run.
 */
export class SandboxRunIsolationUnavailable extends Schema.TaggedClass<SandboxRunIsolationUnavailable>()(
	"SandboxRunIsolationUnavailable",
	{ message: BoundedMessage },
) {}

export class SandboxRunUnavailable extends Schema.TaggedClass<SandboxRunUnavailable>()(
	"SandboxRunUnavailable",
	{ message: BoundedMessage },
) {}

export const SandboxExecResponse = Schema.Union([
	SandboxRunExited,
	SandboxRunTimedOut,
	SandboxRunCheckoutPending,
	SandboxRunCheckoutFailed,
	SandboxRunIsolationUnavailable,
	SandboxRunUnavailable,
])
export type SandboxExecResponse = typeof SandboxExecResponse.Type

export const SANDBOX_EXEC_PATH = "/internal/sandbox/exec"

/**
 * Quote one argument for a POSIX shell.
 *
 * Cloudflare's sandbox takes a command *string*, not a program and an argument
 * vector, so every argument this repo passes is quoted here. Single quotes are
 * literal in `sh` apart from the quote itself, which is closed, escaped and
 * reopened — the one rule this needs to get right.
 */
export const shellQuote = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`

/** A command line for `sh -c`, with every argument quoted. */
export const shellCommand = (command: string, args: ReadonlyArray<string>): string =>
	[command, ...args].map(shellQuote).join(" ")

/**
 * Remove a credential from anything travelling back to a caller.
 *
 * The container puts a failing command line into its own error messages and the
 * SDK copies those into the thrown error, so a secret can surface on paths that
 * never touch the clone's own output. Every string that leaves the sandbox Worker
 * goes through this.
 */
export const redactSecret = (text: string, secret: string): string =>
	secret === "" ? text : text.replaceAll(secret, "<redacted>")

/** Bound a diagnostic to what the wire schema accepts. */
export const boundMessage = (text: string): string =>
	text.length <= 4 * 1024 ? text : `${text.slice(0, 4 * 1024 - 1)}…`
