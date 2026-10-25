import { GithubSetCiTracesRequest, GithubSetTrackedBranchRequest, VcsRepositoryId } from "@maple/domain/http"
import { Duration, Effect, Schema } from "effect"
import { Command } from "foldkit"
import { LoadFailure, toLoadFailure } from "../../data/load-failure"
import { MapleInternalApiClient } from "../../platform/api-clients"
import * as Dialog from "../../ui/dialog"
import * as Popover from "../../ui/popover"
import { Message } from "./message"

// `GithubIntegrationCard`: state and writes.

export const GithubCardModel = Schema.Struct({
	/** The Refresh button's 700 ms spinner (`refreshing`), versioned so a late timer is ignored. */
	isRefreshing: Schema.Boolean,
	refreshVersion: Schema.Number,
	/** `CiTracesSetting`: the optimistic value (null = the server's) and the write in flight. */
	ciTraces: Schema.NullOr(Schema.Boolean),
	/** The server value the optimistic one was set against; a new server value wins. */
	ciTracesServer: Schema.NullOr(Schema.Boolean),
	isSavingCiTraces: Schema.Boolean,
	/** Re-read every 3 s for 10 s after a branch change queues a backfill (`forcePoll`). */
	isForcePolling: Schema.Boolean,
	forcePollVersion: Schema.Number,
	/** Removed repository awaiting the delete confirmation, and the one being deleted. */
	repoToDelete: Schema.NullOr(VcsRepositoryId),
	deletingRepo: Schema.NullOr(VcsRepositoryId),
	deleteDialog: Dialog.Model,
	/** `BranchSelector`: one popover open at a time; its repo, search and the pending change. */
	branchRepo: Schema.NullOr(VcsRepositoryId),
	branchPopover: Popover.Model,
	branchQuery: Schema.String,
	pendingBranch: Schema.NullOr(Schema.Struct({ repoId: VcsRepositoryId, branch: Schema.String })),
	branchDialog: Dialog.Model,
	/** The optimistic tracked branches whose saves are in flight, one per repository (`useAsyncAction` per row). */
	savingBranches: Schema.Array(Schema.Struct({ repoId: VcsRepositoryId, branch: Schema.String })),
})
export type GithubCardModel = typeof GithubCardModel.Type

export const branchPopoverId = (repoId: string) => `github-branch-${repoId}`

export const initGithubCard = (): GithubCardModel => ({
	isRefreshing: false,
	refreshVersion: 0,
	ciTraces: null,
	ciTracesServer: null,
	isSavingCiTraces: false,
	isForcePolling: false,
	forcePollVersion: 0,
	repoToDelete: null,
	deletingRepo: null,
	deleteDialog: Dialog.init("github-repo-delete", "alert-dialog"),
	branchRepo: null,
	branchPopover: Popover.init("github-branch"),
	branchQuery: "",
	pendingBranch: null,
	branchDialog: Dialog.init("github-branch-change", "alert-dialog"),
	savingBranches: [],
})

const failureOf = (error: unknown): LoadFailure => toLoadFailure(error)

export const SpinGithubRefresh = Command.define("SpinGithubRefresh", {
	args: { version: Schema.Number },
	messages: [Message.CompletedGithubRefreshSpin],
	execute: ({ version }) =>
		Effect.as(Effect.sleep(Duration.millis(700)), Message.CompletedGithubRefreshSpin({ version })),
})

export const SetCiTraces = Command.define("SetGithubCiTraces", {
	args: { enabled: Schema.Boolean },
	messages: [Message.CompletedCiTraces],
	execute: ({ enabled }) =>
		Effect.gen(function* () {
			const client = yield* MapleInternalApiClient
			yield* client.integrations.githubSetCiTraces({
				payload: new GithubSetCiTracesRequest({ enabled }),
			})
		}).pipe(
			Effect.match({
				onFailure: (error) => Message.CompletedCiTraces({ enabled, failure: failureOf(error) }),
				onSuccess: () => Message.CompletedCiTraces({ enabled, failure: null }),
			}),
		),
})

export const SetTrackedBranch = Command.define("SetGithubTrackedBranch", {
	args: { repoId: VcsRepositoryId, branch: Schema.String },
	messages: [Message.CompletedTrackedBranch],
	execute: ({ repoId, branch }) =>
		Effect.gen(function* () {
			const client = yield* MapleInternalApiClient
			return yield* client.integrations.githubSetTrackedBranch({
				params: { repositoryId: repoId },
				payload: new GithubSetTrackedBranchRequest({ trackedBranch: branch }),
			})
		}).pipe(
			Effect.match({
				onFailure: (error) =>
					Message.CompletedTrackedBranch({
						repoId,
						branch,
						backfillQueued: false,
						failure: failureOf(error),
					}),
				onSuccess: (response) =>
					Message.CompletedTrackedBranch({
						repoId,
						branch,
						backfillQueued: response.backfillQueued,
						failure: null,
					}),
			}),
		),
})

export const DeleteGithubRepo = Command.define("DeleteGithubRepository", {
	args: { repoId: VcsRepositoryId },
	messages: [Message.CompletedRepoDelete],
	execute: ({ repoId }) =>
		Effect.gen(function* () {
			const client = yield* MapleInternalApiClient
			yield* client.integrations.githubDeleteRepository({ params: { repositoryId: repoId } })
		}).pipe(
			Effect.match({
				onFailure: (error) => Message.CompletedRepoDelete({ repoId, failure: failureOf(error) }),
				onSuccess: () => Message.CompletedRepoDelete({ repoId, failure: null }),
			}),
		),
})
