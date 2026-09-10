/**
 * The repository sandbox container: one per connected repository, holding
 * read-only checkouts and running agent commands with no network. Only the
 * class lives here so the Durable Object's bundle stays free of the runtime;
 * the implementation is `RepoSandbox.runtime.ts`, provided by the root stack.
 */
import * as Cloudflare from "alchemy/Cloudflare"
import type { Effect } from "effect"
import type { SandboxExecInput, SandboxExecOutput, SandboxWorkspace } from "./protocol"

/** A type alias, not an interface: alchemy's RPC shape wants an index signature an interface cannot satisfy. */
export type RepoSandboxApi = {
	readonly listWorkspaces: () => Effect.Effect<ReadonlyArray<SandboxWorkspace>>
	readonly removeWorkspace: (sha: string) => Effect.Effect<void>
	readonly exec: (input: SandboxExecInput) => Effect.Effect<SandboxExecOutput>
}

export class RepoSandbox extends Cloudflare.Container<RepoSandbox, RepoSandboxApi>()("RepoSandbox") {}

/** The container's HTTP port; archives are streamed in over it because RPC arguments are JSON. */
export const REPO_SANDBOX_PORT = 3000

export const workspaceUploadPath = (sha: string) => `/workspaces/${sha}`
