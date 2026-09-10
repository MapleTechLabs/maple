/**
 * The wire between the api Worker, the `RepoSandbox` Durable Object and the
 * container it runs. Plain data: it crosses Workers RPC and alchemy's
 * container RPC as JSON, so nothing here is a class or an Effect error.
 */

/** Where checkouts live inside the container; one directory per commit SHA. */
export const WORKSPACE_ROOT = "/workspace"

/** The unprivileged user every agent command runs as. Created by the image. */
export const SANDBOX_USER = "sandbox"

/**
 * Ambient container variables a command may receive. `PATH` is what makes
 * `rg`/`awk` resolvable; the rest keep tools from misbehaving. Nothing else
 * in the container environment is reachable from a command.
 */
export const SAFE_ENVIRONMENT = ["PATH", "HOME", "LANG", "LC_ALL", "TERM"] as const

export interface SandboxWorkspace {
	readonly sha: string
	readonly lastUsedAtMs: number
}

export interface SandboxExecInput {
	readonly sha: string
	readonly command: string
	readonly args: ReadonlyArray<string>
	/** Workspace-relative; `.` for the checkout root. */
	readonly cwd: string
	/** Names copied from the container environment; intersected with {@link SAFE_ENVIRONMENT}. */
	readonly envAllow: ReadonlyArray<string>
	readonly maxOutputBytes: number
	readonly maxWallTimeMs: number
}

export type SandboxExecOutput =
	| {
			readonly _tag: "exited"
			readonly exitCode: number
			readonly stdout: string
			readonly stderr: string
			readonly stdoutBytes: number
			readonly stderrBytes: number
			readonly wallTimeMs: number
	  }
	| { readonly _tag: "timed-out"; readonly wallTimeMs: number }
	| {
			readonly _tag: "output-limit"
			readonly stream: "stdout" | "stderr"
			readonly limit: number
			readonly observed: number
	  }
	| { readonly _tag: "spawn-failed"; readonly message: string }
	| { readonly _tag: "missing-workspace"; readonly sha: string }

export type EnsureWorkspaceResult =
	| { readonly _tag: "present" }
	| { readonly _tag: "restored"; readonly bytes: number }
	| { readonly _tag: "archive-unavailable"; readonly status: number }
	| { readonly _tag: "restore-failed"; readonly message: string }

export interface EnsureWorkspaceInput {
	readonly sha: string
	/** A pre-signed archive URL; carries no credential of its own. */
	readonly archiveUrl: string
}
