/**
 * `RepoSandbox` — the Durable Object that owns one repository's container,
 * keyed `"<orgId>:<provider>:<owner/name>"`. It restores checkouts into the
 * container from pre-signed archive URLs and forwards commands; the container
 * itself has no network, so this object is the only way content gets in.
 *
 * alchemy's Effect-native form, like `ChatSession`: the api Worker's init yields
 * it, and the container layer below binds, starts and monitors the container.
 * Like the chat object, nothing here imports the app service graph.
 */
import * as Cloudflare from "alchemy/Cloudflare"
import type { RuntimeContext } from "alchemy/RuntimeContext"
import { Cause, Effect, Layer, Semaphore } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http"
import type {
	EnsureWorkspaceInput,
	EnsureWorkspaceResult,
	SandboxExecInput,
	SandboxExecOutput,
} from "./protocol"
import { REPO_SANDBOX_PORT, RepoSandbox, workspaceUploadPath } from "./RepoSandbox"

/** Checkouts kept per repository; the oldest goes when a fourth SHA is restored. */
export const WORKSPACES_PER_REPOSITORY = 3

/** How long an idle container stays up before Cloudflare stops it (and its disk with it). */
const IDLE_TIMEOUT_MS = 10 * 60 * 1000

/** The object's RPC surface; alchemy runs each Effect per call and hands the caller a Promise of its value. */
export type RepoSandboxObjectApi = {
	readonly ensureWorkspace: (
		input: EnsureWorkspaceInput,
	) => Effect.Effect<EnsureWorkspaceResult, never, RuntimeContext>
	readonly exec: (input: SandboxExecInput) => Effect.Effect<SandboxExecOutput, never, RuntimeContext>
}

const describe = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause))

export const makeRepoSandboxObject = Effect.map(
	Effect.all([RepoSandbox, HttpClient.HttpClient]),
	([sandbox, client]) =>
		Effect.gen(function* () {
			// Restores are serialised: two tool calls asking for the same SHA at once must not race the download.
			const restoring = yield* Semaphore.make(1)
			const touch = sandbox.setInactivityTimeout(IDLE_TIMEOUT_MS).pipe(Effect.ignore)

			const restore = Effect.fn("RepoSandboxObject.restore")(function* (input: EnsureWorkspaceInput) {
				const archive = yield* client.execute(HttpClientRequest.get(input.archiveUrl))
				if (archive.status !== 200) {
					return {
						_tag: "archive-unavailable",
						status: archive.status,
					} satisfies EnsureWorkspaceResult
				}
				const { fetch } = yield* sandbox.getTcpPort(REPO_SANDBOX_PORT)
				const upload = yield* fetch(
					HttpClientRequest.put(`http://container${workspaceUploadPath(input.sha)}`).pipe(
						HttpClientRequest.bodyStream(archive.stream, { contentType: "application/gzip" }),
					),
				)
				if (upload.status !== 201) {
					const message = yield* upload.text.pipe(Effect.orElseSucceed(() => ""))
					return {
						_tag: "restore-failed",
						message: `container answered ${upload.status}${message ? `: ${message.slice(0, 300)}` : ""}`,
					} satisfies EnsureWorkspaceResult
				}
				const restored = yield* upload.json
				const bytes =
					typeof restored === "object" && restored !== null && "bytes" in restored
						? Number(restored.bytes)
						: 0
				return { _tag: "restored", bytes } satisfies EnsureWorkspaceResult
			})

			const prune = Effect.fn("RepoSandboxObject.prune")(function* (keep: string) {
				const workspaces = yield* sandbox.listWorkspaces()
				const stale = workspaces
					.filter((workspace) => workspace.sha !== keep)
					.sort((a, b) => b.lastUsedAtMs - a.lastUsedAtMs)
					.slice(WORKSPACES_PER_REPOSITORY - 1)
				yield* Effect.forEach(stale, (workspace) => sandbox.removeWorkspace(workspace.sha))
			})

			const ensureWorkspace: RepoSandboxObjectApi["ensureWorkspace"] = Effect.fn(
				"RepoSandboxObject.ensureWorkspace",
			)(function* (input) {
				yield* Effect.annotateCurrentSpan({ "vcs.ref.head.revision": input.sha })
				const result = yield* Semaphore.withPermits(
					restoring,
					1,
					Effect.gen(function* () {
						const present = yield* sandbox.listWorkspaces()
						if (present.some((workspace) => workspace.sha === input.sha)) {
							return { _tag: "present" } satisfies EnsureWorkspaceResult
						}
						const outcome = yield* restore(input)
						if (outcome._tag === "restored") yield* prune(input.sha)
						return outcome
					}),
				).pipe(
					Effect.catchCause((cause) =>
						Effect.succeed({
							_tag: "restore-failed",
							message: describe(Cause.squash(cause)),
						} satisfies EnsureWorkspaceResult),
					),
				)
				yield* touch
				yield* Effect.annotateCurrentSpan({ "maple.sandbox.workspace": result._tag })
				return result
			})

			const exec: RepoSandboxObjectApi["exec"] = Effect.fn("RepoSandboxObject.exec")(function* (input) {
				const output = yield* sandbox.exec(input).pipe(
					Effect.catchCause((cause) =>
						Effect.succeed({
							_tag: "spawn-failed",
							message: describe(Cause.squash(cause)),
						} satisfies SandboxExecOutput),
					),
				)
				yield* touch
				yield* Effect.annotateCurrentSpan({ "maple.sandbox.outcome": output._tag })
				return output
			})

			return { ensureWorkspace, exec } satisfies RepoSandboxObjectApi
		}),
).pipe(
	// The object's init is an entry point: the container is bound, started and
	// monitored here, and the archive client has no other home.
	// oxlint-disable-next-line effecttsgo/strict-effect-provide
	Effect.provide(
		Layer.mergeAll(
			Cloudflare.Containers.layer(RepoSandbox, { enableInternet: false }),
			FetchHttpClient.layer,
		),
	),
)

export default class RepoSandboxObject extends Cloudflare.DurableObject<RepoSandboxObject>()(
	"RepoSandbox",
	makeRepoSandboxObject,
) {}
