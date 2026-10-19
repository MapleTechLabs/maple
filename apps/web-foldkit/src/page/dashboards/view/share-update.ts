import { AsyncData, Command } from "foldkit"
import { Result } from "effect"
import * as CopyButton from "../../../ui/copy-button"
import * as Dialog from "../../../ui/dialog"
import * as RadioGroup from "../../../ui/radio-group"
import * as Tabs from "../../../ui/tabs"
import type { PageContext, PageReturn } from "../../contract"
import { FetchShares } from "./command"
import { ReadOrigin, WriteShare } from "./command-share"
import { Message } from "./message"
import type { Model } from "./model"
import { type Access, boardShareOf, chartShareOf, ShareMessage, type ShareWrite, type SharingState } from "./share"

// The share and embed dialogs' steps. Writes never stack: one runs at a time, as `useAsyncAction`
// guards them, and each success re-reads the share list.

type Return = PageReturn<Model, Message>

const wrap = (message: ShareMessage) => Message.GotShareMessage({ message })
const withSharing = (model: Model, sharing: Partial<SharingState>): Model => ({
	...model,
	sharing: { ...model.sharing, ...sharing },
})
const sharesOf = (model: Model) => AsyncData.getOrElse(model.sharing.shares, () => [])

const write = (model: Model, next: Model, shareWrite: ShareWrite): Return =>
	model.sharing.isBusy
		? { model }
		: {
				model: withSharing(next, { isBusy: true, error: null }),
				commands: [WriteShare({ dashboardId: model.dashboardId, write: shareWrite })],
			}

/** The toolbar's "Share…": the dialog over the board's share list. */
export const openShare = (model: Model): Return => {
	const opened = Dialog.open(model.sharing.dialog)
	return {
		model: withSharing(model, { dialog: opened.model, pendingAccess: null, error: null }),
		commands: [...Command.mapMessages(opened.commands ?? [], (message) => wrap(ShareMessage.GotDialogMessage({ message }))), ReadOrigin()],
	}
}

/**
 * A chart's "Embed chart": on a public board without a chart link, mounting mints one. A list
 * that failed to re-read still opens the dialog, which shows the error.
 */
export const openEmbed = (model: Model, widgetId: string): Return => {
	if (!AsyncData.isSuccess(model.sharing.shares) && !AsyncData.isFailure(model.sharing.shares)) return { model }
	const opened = Dialog.open(model.sharing.embedDialog)
	const shares = sharesOf(model)
	const next = withSharing(model, {
		embedDialog: opened.model,
		embedWidgetId: widgetId,
		embedTabs: Tabs.init({ idBase: 400, values: ["html", "react"], selected: "html" }),
		embedNowMs: model.nowMs ?? 0,
		error: null,
	})
	const commands = [
		...Command.mapMessages(opened.commands ?? [], (message) => wrap(ShareMessage.GotEmbedDialogMessage({ message }))),
		ReadOrigin(),
	]
	const mint =
		AsyncData.isSuccess(model.sharing.shares) &&
		boardShareOf(shares)?.mode === "public" &&
		chartShareOf(shares, widgetId) === undefined
	if (!mint) return { model: next, commands }
	const minted = write(model, next, { _tag: "MintChart", widgetId })
	return { ...minted, commands: [...commands, ...(minted.commands ?? [])] }
}

const fetched = (model: Model, result: ShareMessage & { _tag: "CompletedFetchShares" }): Return => {
	if (result.seq !== model.sharing.fetchSeq) return { model }
	const shares = Result.match(result.result, {
		onSuccess: (rows) => AsyncData.succeed(rows),
		onFailure: (failure) => AsyncData.fail(failure),
	})
	const serverAccess: Access = boardShareOf(AsyncData.getOrElse(shares, () => []))?.mode ?? "off"
	const pendingAccess = model.sharing.pendingAccess === serverAccess ? null : model.sharing.pendingAccess
	return {
		model: {
			...withSharing(model, { shares, pendingAccess }),
			// `useWidgetEmbed`'s `loaded`: a listed board offers "Embed chart" on every chart.
			shares: Result.isSuccess(result.result) ? "Loaded" : model.shares,
		},
	}
}

const pickAccess = (model: Model, message: RadioGroup.Message): Return => {
	const next = RadioGroup.update(RadioGroup.init(model.sharing.pendingAccess ?? undefined), message)
	const commands = Command.mapMessages(next.commands ?? [], (inner) => wrap(ShareMessage.GotAccessMessage({ message: inner })))
	const access = message._tag === "CompletedFocusRadio" ? undefined : message.value
	if (access !== "off" && access !== "org" && access !== "public") return { model, commands }
	const written = write(model, withSharing(model, { pendingAccess: access }), { _tag: "SetBoardMode", access })
	return { ...written, commands: [...commands, ...(written.commands ?? [])] }
}

const dialogStep = (
	model: Model,
	key: "dialog" | "replaceDialog" | "embedDialog",
	next: ReturnType<typeof Dialog.update>,
	toMessage: (message: Dialog.Message) => ShareMessage,
): Return => ({
	model: withSharing(model, { [key]: next.model }),
	commands: Command.mapMessages(next.commands ?? [], (message) => wrap(toMessage(message))),
})

const copyStep = (model: Model, key: "linkCopy" | "snippetCopy", message: CopyButton.Message, toMessage: (message: CopyButton.Message) => ShareMessage): Return => {
	const next = CopyButton.update(model.sharing[key], message)
	return {
		model: withSharing(model, { [key]: next.model }),
		commands: Command.mapMessages(next.commands ?? [], (inner) => wrap(toMessage(inner))),
	}
}

/** Replace: the chart's link when the embed dialog is open, else the board's. */
const replace = (model: Model): Return => {
	const closed = dialogStep(model, "replaceDialog", Dialog.close(model.sharing.replaceDialog), (message) =>
		ShareMessage.GotReplaceDialogMessage({ message }),
	)
	const widgetId = model.sharing.embedDialog.isOpen ? model.sharing.embedWidgetId : null
	const written = write(closed.model, closed.model, widgetId === null ? { _tag: "RotateBoard" } : { _tag: "RotateChart", widgetId })
	return { ...written, commands: [...(closed.commands ?? []), ...(written.commands ?? [])] }
}

export const shareStep = (model: Model, _context: PageContext, message: ShareMessage): Return =>
	ShareMessage.match<Return>(message, {
		CompletedFetchShares: (result) => fetched(model, result),
		GotOrigin: ({ origin }) => ({ model: withSharing(model, { origin }) }),
		GotDialogMessage: ({ message: inner }) =>
			dialogStep(model, "dialog", Dialog.update(model.sharing.dialog, inner), (m) => ShareMessage.GotDialogMessage({ message: m })),
		GotAccessMessage: ({ message: inner }) => pickAccess(model, inner),
		ClickedReplace: () =>
			dialogStep(model, "replaceDialog", Dialog.open(model.sharing.replaceDialog), (m) =>
				ShareMessage.GotReplaceDialogMessage({ message: m }),
			),
		GotReplaceDialogMessage: ({ message: inner }) =>
			dialogStep(model, "replaceDialog", Dialog.update(model.sharing.replaceDialog, inner), (m) =>
				ShareMessage.GotReplaceDialogMessage({ message: m }),
			),
		ConfirmedReplace: () => replace(model),
		CompletedWrite: ({ error }) => {
			const queued = model.sharing.queuedChart
			if (error !== null)
				return { model: withSharing(model, { isBusy: false, error, pendingAccess: null, queuedChart: null }) }
			const fetchSeq = model.sharing.fetchSeq + 1
			const refetch = FetchShares({ dashboardId: model.dashboardId, seq: fetchSeq })
			return queued === null
				? { model: withSharing(model, { isBusy: false, fetchSeq }), commands: [refetch] }
				: {
						model: withSharing(model, { queuedChart: null, fetchSeq }),
						commands: [
							refetch,
							WriteShare({ dashboardId: model.dashboardId, write: { _tag: "MintChart", widgetId: queued } }),
						],
					}
		},
		GotLinkCopyMessage: ({ message: inner }) =>
			copyStep(model, "linkCopy", inner, (m) => ShareMessage.GotLinkCopyMessage({ message: m })),
		GotEmbedDialogMessage: ({ message: inner }) =>
			dialogStep(model, "embedDialog", Dialog.update(model.sharing.embedDialog, inner), (m) =>
				ShareMessage.GotEmbedDialogMessage({ message: m }),
			),
		GotEmbedTabsMessage: ({ message: inner }) => {
			const next = Tabs.update(model.sharing.embedTabs, inner)
			return {
				model: withSharing(model, { embedTabs: next.model }),
				commands: Command.mapMessages(next.commands ?? [], (m) => wrap(ShareMessage.GotEmbedTabsMessage({ message: m }))),
			}
		},
		GotSnippetCopyMessage: ({ message: inner }) =>
			copyStep(model, "snippetCopy", inner, (m) => ShareMessage.GotSnippetCopyMessage({ message: m })),
		ClickedMakePublic: () => {
			const widgetId = model.sharing.embedWidgetId
			if (widgetId === null) return { model }
			const queuedChart = chartShareOf(sharesOf(model), widgetId) === undefined ? widgetId : null
			return write(model, withSharing(model, { queuedChart }), { _tag: "SetBoardMode", access: "public" })
		},
	})
