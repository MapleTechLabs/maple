/**
 * The wire between the api Worker and the sandbox Worker.
 *
 * The sandbox Worker hosts Cloudflare's Sandbox Durable Object, so it owns the
 * container and the checkout; the api owns the tenant, the credential and the
 * decision to run anything at all. Everything below crosses a service binding
 * as JSON, so it is data only.
 */
import { Schema } from "effect"

/** Where checkouts live inside the container; one directory per repository and commit. */
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
 * Exit code the wrapper uses when the container cannot open a network namespace,
 * so a command that demanded isolation is refused *before* it runs rather than
 * silently running with egress.
 */
export const SANDBOX_NETNS_UNAVAILABLE_EXIT = 97

/** What the command is allowed to reach. `disabled` is enforced with a network namespace. */
export const SandboxNetworkMode = Schema.Literals(["disabled", "enabled"])
export type SandboxNetworkMode = typeof SandboxNetworkMode.Type

/**
 * How the sandbox obtains the repository. `cloneUrl` carries a short-lived,
 * repository-scoped credential and is used once; `remoteUrl` replaces it in the
 * checkout's git config immediately afterwards, so no token is left on disk.
 */
export class SandboxCheckout extends Schema.Class<SandboxCheckout>("SandboxCheckout")({
	repository: Schema.String,
	sha: Schema.String,
	cloneUrl: Schema.String,
	remoteUrl: Schema.String,
}) {}

export class SandboxExecRequest extends Schema.Class<SandboxExecRequest>("SandboxExecRequest")({
	/** One Cloudflare sandbox per repository per organization. */
	sandboxKey: Schema.String,
	checkout: SandboxCheckout,
	command: Schema.String,
	args: Schema.Array(Schema.String),
	/** Checkout-relative; `.` is the repository root. */
	cwd: Schema.String,
	network: SandboxNetworkMode,
	timeoutMs: Schema.Number,
	maxOutputBytes: Schema.Number,
}) {}

export class SandboxExited extends Schema.TaggedClass<SandboxExited>()("SandboxExited", {
	exitCode: Schema.Number,
	stdout: Schema.String,
	stderr: Schema.String,
	stdoutBytes: Schema.Number,
	stderrBytes: Schema.Number,
	wallTimeMs: Schema.Number,
}) {}

export class SandboxTimedOut extends Schema.TaggedClass<SandboxTimedOut>()("SandboxTimedOut", {
	wallTimeMs: Schema.Number,
}) {}

export class SandboxOutputExceeded extends Schema.TaggedClass<SandboxOutputExceeded>()(
	"SandboxOutputExceeded",
	{ stream: Schema.Literals(["stdout", "stderr"]), limit: Schema.Number, observed: Schema.Number },
) {}

export class SandboxCheckoutFailed extends Schema.TaggedClass<SandboxCheckoutFailed>()(
	"SandboxCheckoutFailed",
	{ message: Schema.String },
) {}

/**
 * The container refused to open a network namespace, so `network: "disabled"`
 * could not be honoured. The command was not run.
 */
export class SandboxIsolationUnavailable extends Schema.TaggedClass<SandboxIsolationUnavailable>()(
	"SandboxIsolationUnavailable",
	{ message: Schema.String },
) {}

export class SandboxUnavailable extends Schema.TaggedClass<SandboxUnavailable>()("SandboxUnavailable", {
	message: Schema.String,
}) {}

export const SandboxExecResponse = Schema.Union([
	SandboxExited,
	SandboxTimedOut,
	SandboxOutputExceeded,
	SandboxCheckoutFailed,
	SandboxIsolationUnavailable,
	SandboxUnavailable,
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
