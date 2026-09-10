/**
 * The `RepoSandbox` binding as the Worker-side code reaches it: the native
 * Durable Object namespace off the env, whose stub methods are the object's
 * RPC surface as Promises. Read by name, like `chatSessionStub`, so the chat
 * turn, the workflow lanes and the HTTP graph all resolve it the same way.
 */
import type { OrgId } from "@maple/domain/http"
import { Effect, Schema } from "effect"
import type {
	EnsureWorkspaceInput,
	EnsureWorkspaceResult,
	SandboxExecInput,
	SandboxExecOutput,
} from "./protocol"

export interface RepoSandboxStub {
	readonly ensureWorkspace: (input: EnsureWorkspaceInput) => Promise<EnsureWorkspaceResult>
	readonly exec: (input: SandboxExecInput) => Promise<SandboxExecOutput>
}

export interface RepoSandboxNamespace {
	readonly getByName: (name: string) => RepoSandboxStub
}

export const REPO_SANDBOX_BINDING = "RepoSandbox"

export const isRepoSandboxNamespace = (value: unknown): value is RepoSandboxNamespace =>
	typeof value === "object" &&
	value !== null &&
	typeof (value as { getByName?: unknown }).getByName === "function"

/** One object per repository per organization; the org is in the key so a tenant can never reach another's checkout. */
export const repoSandboxKey = (orgId: OrgId, provider: string, fullName: string): string =>
	`${orgId}:${provider}:${fullName.toLowerCase()}`

export const repoSandboxStub = (env: Record<string, unknown>, key: string): RepoSandboxStub | undefined => {
	const namespace = env[REPO_SANDBOX_BINDING]
	if (!isRepoSandboxNamespace(namespace)) return undefined
	return namespace.getByName(key)
}

export class RepoSandboxCallError extends Schema.TaggedError<RepoSandboxCallError>()(
	"@maple/api/sandbox/RepoSandboxCallError",
	{ message: Schema.String, cause: Schema.optionalKey(Schema.Defect()) },
) {}

/** A stub call as an Effect; the object answers with data, so a rejection is a transport failure. */
export const callStub = <A>(run: () => Promise<A>): Effect.Effect<A, RepoSandboxCallError> =>
	Effect.tryPromise({
		try: run,
		catch: (cause) =>
			new RepoSandboxCallError({
				message: cause instanceof Error ? cause.message : "sandbox call failed",
				cause,
			}),
	})
