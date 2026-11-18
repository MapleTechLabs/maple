import { statusPageOrgKey } from "@maple/domain/status-page"
import type { StatusPageId } from "@maple/domain"
import { AsyncData, Command as FoldkitCommand } from "foldkit"
import { Option, Result, Array as Arr } from "effect"
import * as Keyed from "@maple/views/data/keyed"
import { requestKey } from "@maple/views/data/request-key"
import type { LoadFailure } from "@maple/views/data/load-failure"
import * as Dialog from "@maple/views/ui/dialog"
import * as Menu from "@maple/views/ui/menu"
import type { AppRoute } from "../../../route"
import { type PageContext, PageOutMessage, type PageReturn } from "../../contract"
import {
	publicPageLink,
	publicUrl,
	STATUS_PAGE_BASE_URL,
	statusPageHref,
	statusPageViewHref,
} from "../shared/commands"
import { OPEN_PREVIEW_VALUE, OPEN_PUBLIC_VALUE } from "../shared/open-page"
import type { StatusPageSummary } from "../shared/derive"
import {
	DeleteListedPage,
	FetchListSession,
	FetchStatusPages,
	OpenPageInNewTab,
	ReadListClock,
} from "./command"
import { Message } from "./message"
import { canManage, type Model } from "./model"
import { acceptGrants } from "../../kit/session-grants"

export type Return = PageReturn<Model, Message>

type ListRoute = Extract<AppRoute, { readonly _tag: "StatusPages" }>

export const DELETE_DIALOG_ID = "status-pages-delete"

const pagesKey = (context: PageContext) => requestKey(context.orgId, "statusPages.summaries", {})

const request = (model: Model, context: PageContext, mode: Keyed.ReadMode): Return =>
	Option.match(Keyed.requestFor(model.pages, pagesKey(context), mode), {
		onNone: () => ({ model }),
		onSome: (pages) => ({ model: { ...model, pages }, commands: [FetchStatusPages({ key: pages.key })] }),
	})

export const init = (_route: ListRoute, context: PageContext): Return => {
	const read = request(
		{
			pages: Keyed.idle(),
			nowMs: null,
			grants: [],
			rowMenus: {},
			deletingPageId: null,
			deleteDialog: Dialog.init(DELETE_DIALOG_ID, "alert-dialog"),
			isDeleting: false,
		},
		context,
		"Load",
	)
	return {
		model: read.model,
		commands: [ReadListClock(), FetchListSession({ orgId: context.orgId }), ...(read.commands ?? [])],
	}
}

export const rowMenuId = (pageId: StatusPageId): string => `status-pages-row-menu-${pageId}`

const summaryOf = (model: Model, pageId: StatusPageId): Option.Option<StatusPageSummary> =>
	Arr.findFirst(
		AsyncData.getOrElse(model.pages.data, () => []),
		(summary) => summary.page.id === pageId,
	)

const navigate = (model: Model, url: string): Return => ({
	model,
	outMessage: PageOutMessage.RequestedNavigation({ url, isReplace: false }),
})

/** A closed dialog forgets which page it asked about. */
const liftDeleteDialog = (model: Model, step: ReturnType<typeof Dialog.update>): Return => ({
	model: {
		...model,
		deleteDialog: step.model,
		deletingPageId: step.outMessage?._tag === "Closed" ? null : model.deletingPageId,
	},
	commands: FoldkitCommand.mapMessages(step.commands ?? [], (message) =>
		Message.GotDeleteDialogMessage({ message }),
	),
})

const pickedRowAction = (model: Model, context: PageContext, pageId: StatusPageId, value: string): Return =>
	Option.match(summaryOf(model, pageId), {
		onNone: () => ({ model }),
		onSome: (summary): Return => {
			switch (value) {
				case OPEN_PUBLIC_VALUE: {
					const page = summary.page
					const link = publicPageLink(
						page,
						publicUrl(STATUS_PAGE_BASE_URL, statusPageOrgKey(context.orgId), page.slug),
					)
					return link._tag === "Open"
						? { model, commands: [OpenPageInNewTab({ url: link.url })] }
						: { model }
				}
				case OPEN_PREVIEW_VALUE:
					return navigate(model, statusPageViewHref(pageId))
				case "edit":
					return navigate(model, statusPageHref(pageId))
				case "delete":
					return canManage(model)
						? liftDeleteDialog(
								{ ...model, deletingPageId: pageId },
								Dialog.open(model.deleteDialog),
							)
						: { model }
				default:
					return { model }
			}
		},
	})

const updateRowMenu = (
	model: Model,
	context: PageContext,
	pageId: StatusPageId,
	message: Menu.Message,
): Return => {
	const menuId = rowMenuId(pageId)
	const step = Menu.update(model.rowMenus[menuId] ?? Menu.init(menuId), message)
	const next = { ...model, rowMenus: { ...model.rowMenus, [menuId]: step.model } }
	const commands = FoldkitCommand.mapMessages(step.commands ?? [], (inner) =>
		Message.GotRowMenuMessage({ pageId, message: inner }),
	)
	if (step.outMessage?._tag !== "SelectedItem") return { model: next, commands }
	const after = pickedRowAction(next, context, pageId, step.outMessage.value)
	return { ...after, commands: [...commands, ...(after.commands ?? [])] }
}

const confirmDelete = (model: Model): Return =>
	model.deletingPageId === null || model.isDeleting || !canManage(model)
		? { model }
		: {
				model: { ...model, isDeleting: true },
				commands: [DeleteListedPage({ pageId: model.deletingPageId })],
			}

/** A deleted page leaves the list: the dialog closes and the pages are read again. */
const deleted = (model: Model, context: PageContext, result: Result.Result<void, LoadFailure>): Return => {
	const settled = { ...model, isDeleting: false }
	return Result.match(result, {
		onSuccess: (): Return => {
			const closed = liftDeleteDialog(settled, Dialog.close(settled.deleteDialog))
			const reread = request(closed.model, context, "Supersede")
			return {
				model: reread.model,
				commands: [...(closed.commands ?? []), ...(reread.commands ?? [])],
				outMessage: PageOutMessage.RequestedToast({
					type: "success",
					title: "Status page deleted",
					description: "",
				}),
			}
		},
		onFailure: (failure): Return => ({
			model: settled,
			outMessage: PageOutMessage.RequestedToast({
				type: "error",
				title: "Couldn't delete the status page",
				description: failure.message,
			}),
		}),
	})
}

export const update = (model: Model, message: Message, context: PageContext): Return =>
	Message.match<Return>(message, {
		ReadClock: ({ nowMs }) => ({ model: { ...model, nowMs } }),
		CompletedFetchSession: (answer) => ({ model: acceptGrants(model, context.orgId, answer) }),
		CompletedFetchPages: ({ key, result }) => ({
			model: { ...model, pages: Keyed.accept(model.pages, key, result) },
			commands: [ReadListClock()],
		}),
		ClickedRetry: () => request(model, context, "Supersede"),
		GotRowMenuMessage: ({ pageId, message: child }) => updateRowMenu(model, context, pageId, child),
		CompletedOpenPage: () => ({ model }),
		ClickedConfirmDelete: () => confirmDelete(model),
		CompletedDelete: ({ result }) => deleted(model, context, result),
		GotDeleteDialogMessage: ({ message: child }) =>
			model.isDeleting ? { model } : liftDeleteDialog(model, Dialog.update(model.deleteDialog, child)),
	})
