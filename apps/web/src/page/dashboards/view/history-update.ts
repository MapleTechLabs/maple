import { AsyncData, Command } from "foldkit"
import { Result } from "effect"
import * as Dialog from "../../../ui/dialog"
import { PageOutMessage, type PageReturn } from "../../contract"
import { FetchSnapshot, FetchVersions, RestoreVersion } from "./command-history"
import type { HistoryState } from "./history"
import { Message } from "./message"
import type { Model } from "./model"

// The history panel's steps: open and close, preview a version, restore it.

type Return = PageReturn<Model, Message>

const wrapDialog = (message: Dialog.Message) => Message.GotRestoreDialogMessage({ message })
const withHistory = (model: Model, history: Partial<HistoryState>): Model => ({
	...model,
	history: { ...model.history, ...history },
})
const toAsync = <A, E>(result: Result.Result<A, E>) =>
	Result.match(result, {
		onSuccess: (data) => AsyncData.succeed<A, E>(data),
		onFailure: (error) => AsyncData.fail<E, A>(error),
	})

/** A version-list read under a new generation; only its answer is kept. */
const readVersions = (model: Model, history: Partial<HistoryState>): Return => {
	const generation = model.history.versionsGeneration + 1
	return {
		model: withHistory(model, { ...history, versionsGeneration: generation }),
		commands: [FetchVersions({ dashboardId: model.dashboardId, generation })],
	}
}

/** `openHistory`: the panel mounts and reads the version list. */
export const openHistory = (model: Model): Return =>
	model.history.isOpen ? { model } : readVersions(model, { isOpen: true, versions: AsyncData.Loading() })

type HistoryMessage = Extract<
	Message,
	{
		readonly _tag:
			| "ClickedCloseHistory"
			| "CompletedFetchVersions"
			| "ClickedVersion"
			| "CompletedFetchSnapshot"
			| "ClickedCancelPreview"
			| "ClickedRestoreVersion"
			| "GotRestoreDialogMessage"
			| "ConfirmedRestore"
			| "CompletedRestore"
	}
>

const preview = (model: Model, versionId: string): Return => {
	const version = AsyncData.getOrElse(model.history.versions, () => []).find((row) => row.id === versionId)
	if (version === undefined || model.history.previewed?.id === versionId) return { model }
	return {
		model: withHistory(model, { previewed: version, snapshot: AsyncData.Loading(), sectionView: {} }),
		commands: [FetchSnapshot({ dashboardId: model.dashboardId, versionId })],
	}
}

const closePreview = (model: Model): Model =>
	withHistory(model, { previewed: null, snapshot: AsyncData.Idle(), sectionView: {} })

const toast = (type: "success" | "error", title: string, description: string) =>
	PageOutMessage.RequestedToast({ type, title, description, timeoutMs: null, action: null })

const restored = (model: Model, versionNumber: number, error: string | null): Return => {
	if (error !== null)
		return {
			model: withHistory(model, { isRestoring: false }),
			outMessage: toast("error", "Restore failed", error),
		}
	const closed = Dialog.close(model.history.restoreDialog)
	// The restore cuts a version: the list re-reads, as its reactivity key does.
	const reread = readVersions(closePreview(model), { isRestoring: false, restoreDialog: closed.model })
	return {
		model: reread.model,
		commands: [...Command.mapMessages(closed.commands ?? [], wrapDialog), ...(reread.commands ?? [])],
		outMessage: toast("success", `Restored from v${versionNumber}`, ""),
	}
}

const dialogStep = (model: Model, next: ReturnType<typeof Dialog.update>): Return => ({
	model: withHistory(model, { restoreDialog: next.model }),
	commands: Command.mapMessages(next.commands ?? [], wrapDialog),
})

export const historyStep = (model: Model, message: HistoryMessage): Return => {
	const history = model.history
	switch (message._tag) {
		case "ClickedCloseHistory":
			return { model: withHistory(closePreview(model), { isOpen: false }) }
		case "CompletedFetchVersions":
			return message.generation !== history.versionsGeneration
				? { model }
				: { model: withHistory(model, { versions: toAsync(message.result) }) }
		case "ClickedVersion":
			return preview(model, message.versionId)
		case "CompletedFetchSnapshot":
			return history.previewed?.id !== message.versionId
				? { model }
				: { model: withHistory(model, { snapshot: toAsync(message.result) }) }
		case "ClickedCancelPreview":
			return { model: closePreview(model) }
		case "ClickedRestoreVersion":
			return dialogStep(model, Dialog.open(history.restoreDialog))
		case "GotRestoreDialogMessage":
			return dialogStep(model, Dialog.update(history.restoreDialog, message.message))
		case "ConfirmedRestore":
			return history.previewed === null || history.isRestoring
				? { model }
				: {
						model: withHistory(model, { isRestoring: true }),
						commands: [
							RestoreVersion({
								dashboardId: model.dashboardId,
								versionId: history.previewed.id,
								versionNumber: history.previewed.versionNumber,
							}),
						],
					}
		case "CompletedRestore":
			return restored(model, message.versionNumber, message.error)
	}
}
