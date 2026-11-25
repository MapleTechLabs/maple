import {
	GithubInstallationSelection,
	GithubSelectInstallationRequest,
	GithubSetAuditCategoriesRequest,
	GithubSetAuditLogRequest,
	GithubSetCiTracesRequest,
	GithubSetTrackedBranchRequest,
	VcsRepositoryId,
} from "@maple/domain/http"
import { GithubAuditCategoryId } from "@maple/domain/github-audit"
import { Duration, Effect, Schema } from "effect"
import { Command } from "foldkit"
import { defineMessageUnion } from "foldkit/message"
import { LoadFailure, toLoadFailure } from "@maple/views/data/load-failure"
import { MapleInternalApiClient } from "../../platform/api-clients"
import * as Dialog from "@maple/views/ui/dialog"
import * as Popover from "@maple/views/ui/popover"

/** The GitHub module's own messages; the hub carries them in `GotGithubMessage`. */
export const GithubMessage = defineMessageUnion({
	ClickedSelectGithubInstallation: { installationId: Schema.String },
	CompletedSelectGithubInstallation: {
		state: Schema.String,
		installationId: Schema.String,
		failure: Schema.NullOr(LoadFailure),
	},
	ClickedGithubRefresh: {},
	CompletedGithubRefreshSpin: { version: Schema.Number },
	ToggledCiTraces: {},
	CompletedCiTraces: { enabled: Schema.Boolean, failure: Schema.NullOr(LoadFailure) },
	ToggledAuditLog: {},
	CompletedAuditLog: { enabled: Schema.Boolean, failure: Schema.NullOr(LoadFailure) },
	ToggledAuditCategory: { id: GithubAuditCategoryId },
	CompletedAuditCategory: {
		id: GithubAuditCategoryId,
		enabled: Schema.Boolean,
		failure: Schema.NullOr(LoadFailure),
	},
	/** The 3 s status poll while the popup is out, a branch change settles or a repo syncs. */
	TickedGithubPoll: {},
	EndedGithubForcePoll: { version: Schema.Number },
	ClickedRepoDelete: { repoId: VcsRepositoryId },
	GotRepoDeleteDialogMessage: { message: Dialog.Message },
	ConfirmedRepoDelete: {},
	CompletedRepoDelete: { repoId: VcsRepositoryId, failure: Schema.NullOr(LoadFailure) },
	GotBranchPopoverMessage: { repoId: VcsRepositoryId, message: Popover.Message },
	ChangedBranchQuery: { value: Schema.String },
	ClickedBranch: { repoId: VcsRepositoryId, branch: Schema.String },
	GotBranchDialogMessage: { message: Dialog.Message },
	ConfirmedBranch: {},
	CompletedTrackedBranch: {
		repoId: VcsRepositoryId,
		branch: Schema.String,
		backfillQueued: Schema.Boolean,
		failure: Schema.NullOr(LoadFailure),
	},
})
export type GithubMessage = typeof GithubMessage.Type

/** The hub's status read for GitHub. */
export const GITHUB_STATUS_READ = {
	name: "LoadIntegrationsGithubStatus",
	read: (_refresh: boolean) =>
		Effect.flatMap(MapleInternalApiClient, (client) => client.integrations.githubStatus()),
}

export const GithubCardModel = Schema.Struct({
	selection: Schema.NullOr(GithubInstallationSelection),
	selectingInstallation: Schema.NullOr(Schema.String),
	/** The Refresh button's 700 ms spinner (`refreshing`), versioned so a late timer is ignored. */
	isRefreshing: Schema.Boolean,
	refreshVersion: Schema.Number,
	/** The CI traces switch: the optimistic value (null = the server's) and the write in flight. */
	ciTraces: Schema.NullOr(Schema.Boolean),
	/** The server value the optimistic one was set against; a new server value wins. */
	ciTracesServer: Schema.NullOr(Schema.Boolean),
	isSavingCiTraces: Schema.Boolean,
	/** The audit log switch, the same way. */
	auditLog: Schema.NullOr(Schema.Boolean),
	auditLogServer: Schema.NullOr(Schema.Boolean),
	isSavingAuditLog: Schema.Boolean,
	/**
	 * The audit categories switched here, until a status read with no save in flight replaces them:
	 * each one's optimistic value and whether its write is in flight.
	 */
	auditCategories: Schema.Array(
		Schema.Struct({ id: GithubAuditCategoryId, enabled: Schema.Boolean, isSaving: Schema.Boolean }),
	),
	/** Re-read every 3 s for 10 s after a branch change queues a backfill. */
	isForcePolling: Schema.Boolean,
	forcePollVersion: Schema.Number,
	/** Removed repository awaiting the delete confirmation, and the one being deleted. */
	repoToDelete: Schema.NullOr(VcsRepositoryId),
	deletingRepo: Schema.NullOr(VcsRepositoryId),
	deleteDialog: Dialog.Model,
	/** The branch selector: one popover open at a time; its repo, search and the pending change. */
	branchRepo: Schema.NullOr(VcsRepositoryId),
	branchPopover: Popover.Model,
	branchQuery: Schema.String,
	pendingBranch: Schema.NullOr(Schema.Struct({ repoId: VcsRepositoryId, branch: Schema.String })),
	branchDialog: Dialog.Model,
	/** The optimistic tracked branches whose saves are in flight, one per repository. */
	savingBranches: Schema.Array(Schema.Struct({ repoId: VcsRepositoryId, branch: Schema.String })),
})
export type GithubCardModel = typeof GithubCardModel.Type

export const branchPopoverId = (repoId: string) => `github-branch-${repoId}`

export const initGithubCard = (): GithubCardModel => ({
	selection: null,
	selectingInstallation: null,
	isRefreshing: false,
	refreshVersion: 0,
	ciTraces: null,
	ciTracesServer: null,
	isSavingCiTraces: false,
	auditLog: null,
	auditLogServer: null,
	isSavingAuditLog: false,
	auditCategories: [],
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

export const SelectGithubInstallation = Command.define("SelectGithubInstallation", {
	args: { state: Schema.String, installationId: Schema.String },
	messages: [GithubMessage.CompletedSelectGithubInstallation],
	execute: ({ state, installationId }) =>
		Effect.gen(function* () {
			const client = yield* MapleInternalApiClient
			yield* client.integrations.githubSelectInstallation({
				payload: new GithubSelectInstallationRequest({ state, installationId }),
			})
		}).pipe(
			Effect.match({
				onFailure: (error) =>
					GithubMessage.CompletedSelectGithubInstallation({
						state,
						installationId,
						failure: failureOf(error),
					}),
				onSuccess: () =>
					GithubMessage.CompletedSelectGithubInstallation({ state, installationId, failure: null }),
			}),
		),
})

export const SpinGithubRefresh = Command.define("SpinGithubRefresh", {
	args: { version: Schema.Number },
	messages: [GithubMessage.CompletedGithubRefreshSpin],
	execute: ({ version }) =>
		Effect.as(Effect.sleep(Duration.millis(700)), GithubMessage.CompletedGithubRefreshSpin({ version })),
})

export const SetCiTraces = Command.define("SetGithubCiTraces", {
	args: { enabled: Schema.Boolean },
	messages: [GithubMessage.CompletedCiTraces],
	execute: ({ enabled }) =>
		Effect.gen(function* () {
			const client = yield* MapleInternalApiClient
			yield* client.integrations.githubSetCiTraces({
				payload: new GithubSetCiTracesRequest({ enabled }),
			})
		}).pipe(
			Effect.match({
				onFailure: (error) => GithubMessage.CompletedCiTraces({ enabled, failure: failureOf(error) }),
				onSuccess: () => GithubMessage.CompletedCiTraces({ enabled, failure: null }),
			}),
		),
})

export const SetAuditLog = Command.define("SetGithubAuditLog", {
	args: { enabled: Schema.Boolean },
	messages: [GithubMessage.CompletedAuditLog],
	execute: ({ enabled }) =>
		Effect.gen(function* () {
			const client = yield* MapleInternalApiClient
			yield* client.integrations.githubSetAuditLog({
				payload: new GithubSetAuditLogRequest({ enabled }),
			})
		}).pipe(
			Effect.match({
				onFailure: (error) => GithubMessage.CompletedAuditLog({ enabled, failure: failureOf(error) }),
				onSuccess: () => GithubMessage.CompletedAuditLog({ enabled, failure: null }),
			}),
		),
})

export const SetAuditCategory = Command.define("SetGithubAuditCategory", {
	args: { id: GithubAuditCategoryId, enabled: Schema.Boolean },
	messages: [GithubMessage.CompletedAuditCategory],
	execute: ({ id, enabled }) =>
		Effect.gen(function* () {
			const client = yield* MapleInternalApiClient
			yield* client.integrations.githubSetAuditCategories({
				payload: new GithubSetAuditCategoriesRequest({ categories: { [id]: enabled } }),
			})
		}).pipe(
			Effect.match({
				onFailure: (error) =>
					GithubMessage.CompletedAuditCategory({ id, enabled, failure: failureOf(error) }),
				onSuccess: () => GithubMessage.CompletedAuditCategory({ id, enabled, failure: null }),
			}),
		),
})

export const SetTrackedBranch = Command.define("SetGithubTrackedBranch", {
	args: { repoId: VcsRepositoryId, branch: Schema.String },
	messages: [GithubMessage.CompletedTrackedBranch],
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
					GithubMessage.CompletedTrackedBranch({
						repoId,
						branch,
						backfillQueued: false,
						failure: failureOf(error),
					}),
				onSuccess: (response) =>
					GithubMessage.CompletedTrackedBranch({
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
	messages: [GithubMessage.CompletedRepoDelete],
	execute: ({ repoId }) =>
		Effect.gen(function* () {
			const client = yield* MapleInternalApiClient
			yield* client.integrations.githubDeleteRepository({ params: { repositoryId: repoId } })
		}).pipe(
			Effect.match({
				onFailure: (error) =>
					GithubMessage.CompletedRepoDelete({ repoId, failure: failureOf(error) }),
				onSuccess: () => GithubMessage.CompletedRepoDelete({ repoId, failure: null }),
			}),
		),
})
