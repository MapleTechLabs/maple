import type { GithubRepoSummary, VcsRepositoryId } from "@maple/domain/http"
import { Option } from "effect"
import { AsyncData, Command as FoldkitCommand } from "foldkit"
import type { LoadFailure } from "../../data/load-failure"
import * as Dialog from "../../ui/dialog"
import * as Popover from "../../ui/popover"
import { type PageContext, PageOutMessage, type PageReturn } from "../contract"
import {
	branchPopoverId,
	DeleteGithubRepo,
	type GithubCardModel,
	SetCiTraces,
	SetTrackedBranch,
	SpinGithubRefresh,
	SelectGithubInstallation,
} from "./github"
import { Message } from "./message"
import type { Model } from "./model"
import { chain, requestStatus } from "./update-status"
import { TrackConnected } from "./command"

// `GithubIntegrationCard`'s state changes.

type Return = PageReturn<Model, Message>

const withCard = (model: Model, card: Partial<GithubCardModel>): Model => ({
	...model,
	githubCard: { ...model.githubCard, ...card },
})

const toast = (model: Model, type: "success" | "error", title: string, description = ""): Return => ({
	model,
	outMessage: PageOutMessage.RequestedToast({ type, title, description }),
})

const refresh = (model: Model, context: PageContext): Return =>
	requestStatus(model, context, "github", "Supersede")

export const githubStatusOf = (model: Model) =>
	Option.getOrNull(AsyncData.getData(model.statuses.github.data))

export const clickedInstallation = (model: Model, installationId: string): Return => {
	const selection = model.githubCard.selection
	if (
		selection === null ||
		model.githubCard.selectingInstallation !== null ||
		!selection.installations.some((installation) => installation.id === installationId)
	)
		return { model }
	return {
		model: withCard(model, { selectingInstallation: installationId }),
		commands: [SelectGithubInstallation({ state: selection.state, installationId })],
	}
}

export const completedInstallation = (
	model: Model,
	context: PageContext,
	state: string,
	installationId: string,
	failure: LoadFailure | null,
): Return => {
	if (
		model.githubCard.selection?.state !== state ||
		model.githubCard.selectingInstallation !== installationId
	)
		return { model }
	const settled = withCard(model, { selection: null, selectingInstallation: null })
	if (failure !== null)
		return toast(
			settled,
			"error",
			"Couldn't connect GitHub",
			`${failure.message} Click Connect GitHub to retry.`,
		)
	return chain(settled, [
		(next) => ({ model: next, commands: [TrackConnected({ provider: "github" })] }),
		(next) => toast(next, "success", "GitHub connected"),
		(next) => refresh(next, context),
	])
}

const repoOf = (model: Model, repoId: VcsRepositoryId): GithubRepoSummary | undefined =>
	githubStatusOf(model)?.repositories.find((repo) => repo.id === repoId)

/** The switch's value: the optimistic one until the server's own value moves. */
export const ciTracesShown = (model: Model): boolean => {
	const server = githubStatusOf(model)?.ciTracesEnabled ?? true
	const card = model.githubCard
	return card.ciTraces !== null && card.ciTracesServer === server ? card.ciTraces : server
}

export const clickedRefresh = (model: Model, context: PageContext): Return => {
	const version = model.githubCard.refreshVersion + 1
	return chain(withCard(model, { isRefreshing: true, refreshVersion: version }), [
		(next) => refresh(next, context),
		(next) => ({ model: next, commands: [SpinGithubRefresh({ version })] }),
	])
}

export const completedRefreshSpin = (model: Model, version: number): Return =>
	version === model.githubCard.refreshVersion
		? { model: withCard(model, { isRefreshing: false }) }
		: { model }

export const toggledCiTraces = (model: Model): Return => {
	if (model.githubCard.isSavingCiTraces) return { model }
	const next = !ciTracesShown(model)
	const server = githubStatusOf(model)?.ciTracesEnabled ?? true
	return {
		model: withCard(model, { ciTraces: next, ciTracesServer: server, isSavingCiTraces: true }),
		commands: [SetCiTraces({ enabled: next })],
	}
}

export const completedCiTraces = (
	model: Model,
	context: PageContext,
	enabled: boolean,
	failure: LoadFailure | null,
): Return => {
	const settled = withCard(model, { isSavingCiTraces: false })
	if (failure !== null)
		return toast(
			withCard(settled, { ciTraces: !enabled }),
			"error",
			"Couldn't change CI traces and logs.",
			failure.message,
		)
	return chain(settled, [
		(next) =>
			toast(
				next,
				"success",
				enabled
					? "GitHub Actions runs will show up as traces and logs"
					: "CI traces and logs turned off",
			),
		(next) => refresh(next, context),
	])
}

export const endedForcePoll = (model: Model, version: number): Return =>
	version === model.githubCard.forcePollVersion
		? { model: withCard(model, { isForcePolling: false }) }
		: { model }

const deleteDialogStep = (model: Model, step: ReturnType<typeof Dialog.update>): Return => ({
	model: withCard(model, { deleteDialog: step.model }),
	commands: FoldkitCommand.mapMessages(step.commands ?? [], (message) =>
		Message.GotRepoDeleteDialogMessage({ message }),
	),
})

export const clickedRepoDelete = (model: Model, repoId: VcsRepositoryId): Return =>
	deleteDialogStep(withCard(model, { repoToDelete: repoId }), Dialog.open(model.githubCard.deleteDialog))

export const gotRepoDeleteDialog = (model: Model, message: Dialog.Message): Return =>
	model.githubCard.deletingRepo !== null
		? { model }
		: deleteDialogStep(model, Dialog.update(model.githubCard.deleteDialog, message))

/** The dialog stays open, its confirm pending, until `completedRepoDelete` closes it. */
export const confirmedRepoDelete = (model: Model): Return => {
	const repoId = model.githubCard.repoToDelete
	if (repoId === null || model.githubCard.deletingRepo !== null) return { model }
	return { model: withCard(model, { deletingRepo: repoId }), commands: [DeleteGithubRepo({ repoId })] }
}

export const completedRepoDelete = (
	model: Model,
	context: PageContext,
	repoId: VcsRepositoryId,
	failure: LoadFailure | null,
): Return => {
	const fullName = repoOf(model, repoId)?.fullName ?? ""
	// `repoToDelete` stays: the closing dialog still names the repository.
	const closed = deleteDialogStep(
		withCard(model, { deletingRepo: null }),
		Dialog.close(model.githubCard.deleteDialog),
	)
	return chain(closed.model, [
		() => closed,
		...(failure === null
			? [
					(next: Model) => toast(next, "success", `Deleted ${fullName} from Maple`),
					(next: Model) => refresh(next, context),
				]
			: [(next: Model) => toast(next, "error", `Couldn't delete ${fullName}`, failure.message)]),
	])
}

// BRANCH SELECTOR

const popoverStep = (
	model: Model,
	repoId: VcsRepositoryId,
	step: ReturnType<typeof Popover.update>,
): Return => ({
	model: withCard(model, { branchRepo: repoId, branchPopover: step.model }),
	commands: FoldkitCommand.mapMessages(step.commands ?? [], (message) =>
		Message.GotBranchPopoverMessage({ repoId, message }),
	),
})

/** The open popover's Model, or a closed one for another row (one popover at a time). */
const popoverOf = (model: Model, repoId: VcsRepositoryId): Popover.Model =>
	model.githubCard.branchRepo === repoId
		? model.githubCard.branchPopover
		: Popover.init(branchPopoverId(repoId), { align: "end" })

export const gotBranchPopover = (model: Model, repoId: VcsRepositoryId, message: Popover.Message): Return => {
	const fresh = model.githubCard.branchRepo !== repoId
	const base = fresh ? withCard(model, { branchQuery: "" }) : model
	return popoverStep(base, repoId, Popover.update(popoverOf(model, repoId), message))
}

/** The tracked branch shown: the optimistic save, else the server's (falling back to the default). */
export const trackedBranchOf = (model: Model, repo: GithubRepoSummary): string | null => {
	const saving = model.githubCard.savingBranches.find((entry) => entry.repoId === repo.id)
	if (saving !== undefined) return saving.branch
	return repo.trackedBranch ?? repo.branches.find((branch) => branch.isDefault)?.name ?? null
}

const branchDialogStep = (model: Model, step: ReturnType<typeof Dialog.update>): Return => ({
	model: withCard(model, { branchDialog: step.model }),
	commands: FoldkitCommand.mapMessages(step.commands ?? [], (message) =>
		Message.GotBranchDialogMessage({ message }),
	),
})

/** `pick`: the current branch just closes; another one asks for confirmation first. */
export const clickedBranch = (model: Model, repoId: VcsRepositoryId, branch: string): Return => {
	const repo = repoOf(model, repoId)
	if (repo === undefined) return { model }
	if (branch === trackedBranchOf(model, repo))
		return popoverStep(model, repoId, Popover.close(popoverOf(model, repoId)))
	return branchDialogStep(
		withCard(model, { pendingBranch: { repoId, branch } }),
		Dialog.open(model.githubCard.branchDialog),
	)
}

const isSavingPendingBranch = (model: Model): boolean => {
	const pending = model.githubCard.pendingBranch
	return pending !== null && model.githubCard.savingBranches.some((entry) => entry.repoId === pending.repoId)
}

export const gotBranchDialog = (model: Model, message: Dialog.Message): Return => {
	if (isSavingPendingBranch(model)) return { model }
	const step = branchDialogStep(model, Dialog.update(model.githubCard.branchDialog, message))
	return step.model.githubCard.branchDialog.isOpen
		? step
		: { ...step, model: withCard(step.model, { pendingBranch: null }) }
}

/** `commit`: optimistic; the dialog stays open, its confirm pending, until the save answers. */
export const confirmedBranch = (model: Model): Return => {
	const pending = model.githubCard.pendingBranch
	const card = model.githubCard
	if (pending === null || card.savingBranches.some((entry) => entry.repoId === pending.repoId))
		return { model }
	return {
		model: withCard(model, { savingBranches: [...card.savingBranches, pending] }),
		commands: [SetTrackedBranch(pending)],
	}
}

export const completedTrackedBranch = (
	model: Model,
	context: PageContext,
	repoId: VcsRepositoryId,
	branch: string,
	backfillQueued: boolean,
	failure: LoadFailure | null,
): Return => {
	const saved = withCard(model, {
		savingBranches: model.githubCard.savingBranches.filter((entry) => entry.repoId !== repoId),
	})
	const closing = [
		(next: Model) =>
			next.githubCard.pendingBranch?.repoId === repoId
				? branchDialogStep(next, Dialog.close(next.githubCard.branchDialog))
				: { model: next },
		(next: Model) => popoverStep(next, repoId, Popover.close(popoverOf(next, repoId))),
	]
	if (failure !== null)
		return chain(saved, [
			...closing,
			(next) => toast(next, "error", "Couldn't change tracked branch", failure.message),
		])
	if (!backfillQueued) return chain(saved, [...closing, (next) => refresh(next, context)])
	const version = model.githubCard.forcePollVersion + 1
	return chain(withCard(saved, { isForcePolling: true, forcePollVersion: version }), [
		...closing,
		(next) => toast(next, "success", `Now tracking ${branch}, re-syncing commits…`),
		(next) => refresh(next, context),
	])
}
