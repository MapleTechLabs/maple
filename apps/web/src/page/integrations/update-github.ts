import type {
	GithubInstallationSelection,
	GithubIntegrationStatus,
	GithubRepoSummary,
	VcsRepositoryId,
} from "@maple/domain/http"
import { GITHUB_AUDIT_CATEGORIES, type GithubAuditCategoryId } from "@maple/domain/github-audit"
import { Option, Array as Arr } from "effect"
import { AsyncData, Command } from "foldkit"
import type * as Keyed from "@maple/views/data/keyed"
import type { LoadFailure } from "@maple/views/data/load-failure"
import * as Dialog from "@maple/views/ui/dialog"
import * as Popover from "@maple/views/ui/popover"
import {
	branchPopoverId,
	DeleteGithubRepo,
	type GithubCardModel,
	GithubMessage,
	SetAuditCategory,
	SetAuditLog,
	SetCiTraces,
	SetTrackedBranch,
	SpinGithubRefresh,
	SelectGithubInstallation,
} from "./github"
import type { Model } from "./model"
import {
	andThen as then,
	HubRequest,
	type ProviderEnv,
	type ProviderReturn,
	type StatusAnswer,
} from "./provider"

// The GitHub card's state changes, as the GitHub module's update.

type Env = ProviderEnv<GithubIntegrationStatus>
type Return = ProviderReturn<GithubCardModel, GithubMessage>
type Status = GithubIntegrationStatus | null

const withCard = (model: GithubCardModel, card: Partial<GithubCardModel>): GithubCardModel => ({
	...model,
	...card,
})

/** Both answers concatenated: the second step's model, every request and Command in order. */
const statusOf = (slot: Keyed.Keyed<GithubIntegrationStatus, LoadFailure>): Status =>
	Option.getOrNull(AsyncData.getData(slot.data))

const refresh = HubRequest.readStatus("Supersede")

/** The GitHub status the page holds, for the views. */
export const githubStatusOf = (model: Model): Status => statusOf(model.statuses.github)

const clickedInstallation = (model: GithubCardModel, installationId: string): Return => {
	const selection = model.selection
	if (
		selection === null ||
		model.selectingInstallation !== null ||
		!Arr.some(selection.installations, (installation) => installation.id === installationId)
	)
		return { model }
	return {
		model: withCard(model, { selectingInstallation: installationId }),
		commands: [SelectGithubInstallation({ state: selection.state, installationId })],
	}
}

const completedInstallation = (
	model: GithubCardModel,
	state: string,
	installationId: string,
	failure: LoadFailure | null,
): Return => {
	if (model.selection?.state !== state || model.selectingInstallation !== installationId) return { model }
	const settled = withCard(model, { selection: null, selectingInstallation: null })
	if (failure !== null)
		return {
			model: settled,
			requests: [
				HubRequest.toast(
					"error",
					"Couldn't connect GitHub",
					`${failure.message} Click Connect GitHub to retry.`,
				),
			],
		}
	return {
		model: settled,
		requests: [
			HubRequest.trackConnected("github"),
			HubRequest.toast("success", "GitHub connected"),
			refresh,
		],
	}
}

const repoOf = (status: Status, repoId: VcsRepositoryId): GithubRepoSummary | undefined =>
	Option.getOrUndefined(Arr.findFirst(status?.repositories ?? [], (repo) => repo.id === repoId))

/** The switch's value: the optimistic one until the server's own value moves. */
const ciTracesOf = (card: GithubCardModel, status: Status): boolean => {
	const server = status?.ciTracesEnabled ?? true
	return card.ciTraces !== null && card.ciTracesServer === server ? card.ciTraces : server
}

export const ciTracesShown = (model: Model): boolean => ciTracesOf(model.githubCard, githubStatusOf(model))

/**
 * A status read that lands with no save in flight is the server's word: the switches drop their
 * optimistic values, so a later change made elsewhere shows instead of the old override.
 */
const settledSwitches = (card: GithubCardModel): GithubCardModel =>
	withCard(card, {
		...(card.isSavingCiTraces ? undefined : { ciTraces: null, ciTracesServer: null }),
		...(card.isSavingAuditLog ? undefined : { auditLog: null, auditLogServer: null }),
		auditCategories: Arr.filter(card.auditCategories, (entry) => entry.isSaving),
	})

/** Only the current, successful read settles the switches. */
export const statusAnswered = (
	model: GithubCardModel,
	env: Env,
	answer: StatusAnswer<GithubIntegrationStatus>,
): Return =>
	answer.isCurrent && AsyncData.isSuccess(env.status.data) ? { model: settledSwitches(model) } : { model }

/** The audit log switch's value, read like the CI traces one. */
const auditLogOf = (card: GithubCardModel, status: Status): boolean => {
	const server = status?.auditLogEnabled ?? true
	return card.auditLog !== null && card.auditLogServer === server ? card.auditLog : server
}

export const auditLogShown = (model: Model): boolean => auditLogOf(model.githubCard, githubStatusOf(model))

const toggledAuditLog = (model: GithubCardModel, status: Status): Return => {
	if (model.isSavingAuditLog) return { model }
	const next = !auditLogOf(model, status)
	const server = status?.auditLogEnabled ?? true
	return {
		model: withCard(model, { auditLog: next, auditLogServer: server, isSavingAuditLog: true }),
		commands: [SetAuditLog({ enabled: next })],
	}
}

const completedAuditLog = (model: GithubCardModel, enabled: boolean, failure: LoadFailure | null): Return => {
	const settled = withCard(model, { isSavingAuditLog: false })
	// A lost response can follow a committed write, so a failure re-reads the status too.
	if (failure !== null)
		return {
			model: withCard(settled, { auditLog: !enabled }),
			requests: [HubRequest.toast("error", "Couldn't change the audit log.", failure.message), refresh],
		}
	return {
		model: settled,
		requests: [
			HubRequest.toast(
				"success",
				enabled ? "GitHub changes will show up in the audit log" : "GitHub audit log turned off",
			),
			refresh,
		],
	}
}

/** An audit category's switch: its value switched here, else the server's, else its default. */
const auditCategoryOf = (card: GithubCardModel, status: Status, id: GithubAuditCategoryId): boolean => {
	const local = Arr.findFirst(card.auditCategories, (entry) => entry.id === id)
	if (Option.isSome(local)) return local.value.enabled
	const server = status?.auditCategories[id]
	return server ?? Arr.some(GITHUB_AUDIT_CATEGORIES, (spec) => spec.id === id && spec.defaultEnabled)
}

export const auditCategoryShown = (model: Model, id: GithubAuditCategoryId): boolean =>
	auditCategoryOf(model.githubCard, githubStatusOf(model), id)

const withAuditCategory = (
	model: GithubCardModel,
	id: GithubAuditCategoryId,
	entry: { readonly enabled: boolean; readonly isSaving: boolean } | null,
): GithubCardModel =>
	withCard(model, {
		auditCategories: [
			...Arr.filter(model.auditCategories, (other) => other.id !== id),
			...(entry === null ? [] : [{ id, ...entry }]),
		],
	})

const toggledAuditCategory = (model: GithubCardModel, status: Status, id: GithubAuditCategoryId): Return => {
	const saving = Arr.some(model.auditCategories, (entry) => entry.id === id && entry.isSaving)
	if (saving) return { model }
	const enabled = !auditCategoryOf(model, status, id)
	return {
		model: withAuditCategory(model, id, { enabled, isSaving: true }),
		commands: [SetAuditCategory({ id, enabled })],
	}
}

const completedAuditCategory = (
	model: GithubCardModel,
	id: GithubAuditCategoryId,
	enabled: boolean,
	failure: LoadFailure | null,
): Return =>
	// A lost response can follow a committed write, so a failure re-reads the status too.
	failure !== null
		? {
				model: withAuditCategory(model, id, null),
				requests: [
					HubRequest.toast("error", "Couldn't change that audit category.", failure.message),
					refresh,
				],
			}
		: { model: withAuditCategory(model, id, { enabled, isSaving: false }), requests: [refresh] }

const clickedRefresh = (model: GithubCardModel): Return => {
	const version = model.refreshVersion + 1
	return {
		model: withCard(model, { isRefreshing: true, refreshVersion: version }),
		requests: [refresh],
		commands: [SpinGithubRefresh({ version })],
	}
}

const toggledCiTraces = (model: GithubCardModel, status: Status): Return => {
	if (model.isSavingCiTraces) return { model }
	const next = !ciTracesOf(model, status)
	const server = status?.ciTracesEnabled ?? true
	return {
		model: withCard(model, { ciTraces: next, ciTracesServer: server, isSavingCiTraces: true }),
		commands: [SetCiTraces({ enabled: next })],
	}
}

const completedCiTraces = (model: GithubCardModel, enabled: boolean, failure: LoadFailure | null): Return => {
	const settled = withCard(model, { isSavingCiTraces: false })
	if (failure !== null)
		return {
			model: withCard(settled, { ciTraces: !enabled }),
			requests: [HubRequest.toast("error", "Couldn't change CI traces and logs.", failure.message)],
		}
	return {
		model: settled,
		requests: [
			HubRequest.toast(
				"success",
				enabled
					? "GitHub Actions runs will show up as traces and logs"
					: "CI traces and logs turned off",
			),
			refresh,
		],
	}
}

const deleteDialogStep = (model: GithubCardModel, step: ReturnType<typeof Dialog.update>): Return => ({
	model: withCard(model, { deleteDialog: step.model }),
	commands: Command.mapMessages(step.commands ?? [], (message) =>
		GithubMessage.GotRepoDeleteDialogMessage({ message }),
	),
})

/** The dialog stays open, its confirm pending, until `completedRepoDelete` closes it. */
const confirmedRepoDelete = (model: GithubCardModel): Return => {
	const repoId = model.repoToDelete
	if (repoId === null || model.deletingRepo !== null) return { model }
	return { model: withCard(model, { deletingRepo: repoId }), commands: [DeleteGithubRepo({ repoId })] }
}

const completedRepoDelete = (
	model: GithubCardModel,
	status: Status,
	repoId: VcsRepositoryId,
	failure: LoadFailure | null,
): Return => {
	const fullName = repoOf(status, repoId)?.fullName ?? ""
	// `repoToDelete` stays: the closing dialog still names the repository.
	const closed = deleteDialogStep(withCard(model, { deletingRepo: null }), Dialog.close(model.deleteDialog))
	return {
		...closed,
		requests:
			failure === null
				? [HubRequest.toast("success", `Deleted ${fullName} from Maple`), refresh]
				: [HubRequest.toast("error", `Couldn't delete ${fullName}`, failure.message)],
	}
}

const popoverStep = (
	model: GithubCardModel,
	repoId: VcsRepositoryId,
	step: ReturnType<typeof Popover.update>,
): Return => ({
	model: withCard(model, { branchRepo: repoId, branchPopover: step.model }),
	commands: Command.mapMessages(step.commands ?? [], (message) =>
		GithubMessage.GotBranchPopoverMessage({ repoId, message }),
	),
})

/** The open popover's Model, or a closed one for another row (one popover at a time). */
const popoverOf = (model: GithubCardModel, repoId: VcsRepositoryId): Popover.Model =>
	model.branchRepo === repoId
		? model.branchPopover
		: Popover.init(branchPopoverId(repoId), { align: "end" })

const gotBranchPopover = (
	model: GithubCardModel,
	repoId: VcsRepositoryId,
	message: Popover.Message,
): Return => {
	const fresh = model.branchRepo !== repoId
	const base = fresh ? withCard(model, { branchQuery: "" }) : model
	return popoverStep(base, repoId, Popover.update(popoverOf(model, repoId), message))
}

/** The tracked branch shown: the optimistic save, else the server's (falling back to the default). */
const trackedBranchIn = (card: GithubCardModel, repo: GithubRepoSummary): string | null => {
	const saving = Arr.findFirst(card.savingBranches, (entry) => entry.repoId === repo.id)
	if (Option.isSome(saving)) return saving.value.branch
	return (
		repo.trackedBranch ??
		Option.getOrNull(
			Option.flatMapNullishOr(
				Arr.findFirst(repo.branches, (branch) => branch.isDefault),
				(branch) => branch.name,
			),
		)
	)
}

export const trackedBranchOf = (model: Model, repo: GithubRepoSummary): string | null =>
	trackedBranchIn(model.githubCard, repo)

const branchDialogStep = (model: GithubCardModel, step: ReturnType<typeof Dialog.update>): Return => ({
	model: withCard(model, { branchDialog: step.model }),
	commands: Command.mapMessages(step.commands ?? [], (message) =>
		GithubMessage.GotBranchDialogMessage({ message }),
	),
})

/** `pick`: the current branch just closes; another one asks for confirmation first. */
const clickedBranch = (
	model: GithubCardModel,
	status: Status,
	repoId: VcsRepositoryId,
	branch: string,
): Return => {
	const repo = repoOf(status, repoId)
	if (repo === undefined) return { model }
	if (branch === trackedBranchIn(model, repo))
		return popoverStep(model, repoId, Popover.close(popoverOf(model, repoId)))
	return branchDialogStep(
		withCard(model, { pendingBranch: { repoId, branch } }),
		Dialog.open(model.branchDialog),
	)
}

const isSavingPendingBranch = (model: GithubCardModel): boolean => {
	const pending = model.pendingBranch
	return pending !== null && Arr.some(model.savingBranches, (entry) => entry.repoId === pending.repoId)
}

const gotBranchDialog = (model: GithubCardModel, message: Dialog.Message): Return => {
	if (isSavingPendingBranch(model)) return { model }
	const step = branchDialogStep(model, Dialog.update(model.branchDialog, message))
	return step.model.branchDialog.isOpen
		? step
		: { ...step, model: withCard(step.model, { pendingBranch: null }) }
}

/** `commit`: optimistic; the dialog stays open, its confirm pending, until the save answers. */
const confirmedBranch = (model: GithubCardModel): Return => {
	const pending = model.pendingBranch
	if (pending === null || Arr.some(model.savingBranches, (entry) => entry.repoId === pending.repoId))
		return { model }
	return {
		model: withCard(model, { savingBranches: [...model.savingBranches, pending] }),
		commands: [SetTrackedBranch(pending)],
	}
}

const completedTrackedBranch = (
	model: GithubCardModel,
	repoId: VcsRepositoryId,
	branch: string,
	backfillQueued: boolean,
	failure: LoadFailure | null,
): Return => {
	const saved = withCard(model, {
		savingBranches: Arr.filter(model.savingBranches, (entry) => entry.repoId !== repoId),
	})
	const closing = (start: GithubCardModel): Return =>
		then(
			start.pendingBranch?.repoId === repoId
				? branchDialogStep(start, Dialog.close(start.branchDialog))
				: { model: start },
			(next) => popoverStep(next, repoId, Popover.close(popoverOf(next, repoId))),
		)
	if (failure !== null)
		return then(closing(saved), (next) => ({
			model: next,
			requests: [HubRequest.toast("error", "Couldn't change tracked branch", failure.message)],
		}))
	if (!backfillQueued) return then(closing(saved), (next) => ({ model: next, requests: [refresh] }))
	const version = model.forcePollVersion + 1
	return then(closing(withCard(saved, { isForcePolling: true, forcePollVersion: version })), (next) => ({
		model: next,
		requests: [HubRequest.toast("success", `Now tracking ${branch}, re-syncing commits…`), refresh],
	}))
}

/** An authorization that found accounts: the picker shows them. */
export const receivedSelection = (
	model: GithubCardModel,
	selection: GithubInstallationSelection,
): Return => ({
	model: withCard(model, { selection, selectingInstallation: null }),
})

/** The popup is out: a choice it replaces goes now, so a blocked popup keeps the verified picker. */
export const openedPopup = (model: GithubCardModel): Return => ({
	model: withCard(model, { selection: null }),
})

/** The popup is out, repository discovery is pending, or a repository is still syncing. */
export const isPolling = (
	model: GithubCardModel,
	env: Pick<Env, "status" | "isShown" | "isConnecting">,
): boolean => {
	if (!env.isShown) return false
	const status = statusOf(env.status)
	const syncing =
		status?.connected === true &&
		status.repositoryDiscovery?._tag !== "Failed" &&
		Arr.some(
			status.repositories,
			(repo) => repo.syncStatus === "pending" || repo.syncStatus === "backfilling",
		)
	return (
		env.isConnecting || model.isForcePolling || status?.repositoryDiscovery?._tag === "Pending" || syncing
	)
}

export const update = (model: GithubCardModel, message: GithubMessage, env: Env): Return => {
	const status = statusOf(env.status)
	return GithubMessage.match<Return>(message, {
		ClickedSelectGithubInstallation: ({ installationId }) => clickedInstallation(model, installationId),
		CompletedSelectGithubInstallation: ({ state, installationId, failure }) =>
			completedInstallation(model, state, installationId, failure),
		ClickedGithubRefresh: () => clickedRefresh(model),
		CompletedGithubRefreshSpin: ({ version }) =>
			version === model.refreshVersion
				? { model: withCard(model, { isRefreshing: false }) }
				: { model },
		ToggledCiTraces: () => toggledCiTraces(model, status),
		CompletedCiTraces: ({ enabled, failure }) => completedCiTraces(model, enabled, failure),
		ToggledAuditLog: () => toggledAuditLog(model, status),
		CompletedAuditLog: ({ enabled, failure }) => completedAuditLog(model, enabled, failure),
		ToggledAuditCategory: ({ id }) => toggledAuditCategory(model, status, id),
		CompletedAuditCategory: ({ id, enabled, failure }) =>
			completedAuditCategory(model, id, enabled, failure),
		TickedGithubPoll: () => ({ model, requests: [HubRequest.readStatus("Refresh")] }),
		EndedGithubForcePoll: ({ version }) =>
			version === model.forcePollVersion
				? { model: withCard(model, { isForcePolling: false }) }
				: { model },
		ClickedRepoDelete: ({ repoId }) =>
			deleteDialogStep(withCard(model, { repoToDelete: repoId }), Dialog.open(model.deleteDialog)),
		GotRepoDeleteDialogMessage: ({ message: child }) =>
			model.deletingRepo !== null
				? { model }
				: deleteDialogStep(model, Dialog.update(model.deleteDialog, child)),
		ConfirmedRepoDelete: () => confirmedRepoDelete(model),
		CompletedRepoDelete: ({ repoId, failure }) => completedRepoDelete(model, status, repoId, failure),
		GotBranchPopoverMessage: ({ repoId, message: child }) => gotBranchPopover(model, repoId, child),
		ChangedBranchQuery: ({ value }) => ({ model: withCard(model, { branchQuery: value }) }),
		ClickedBranch: ({ repoId, branch }) => clickedBranch(model, status, repoId, branch),
		GotBranchDialogMessage: ({ message: child }) => gotBranchDialog(model, child),
		ConfirmedBranch: () => confirmedBranch(model),
		CompletedTrackedBranch: ({ repoId, branch, backfillQueued, failure }) =>
			completedTrackedBranch(model, repoId, branch, backfillQueued, failure),
	})
}
