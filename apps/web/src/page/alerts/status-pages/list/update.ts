import { Option, Result } from "effect"
import { type Command, Command as FoldkitCommand } from "foldkit"
import * as Keyed from "../../../../data/keyed"
import { requestKey } from "../../../../data/request-key"
import type { Resources } from "../../../../platform/resources"
import * as Dialog from "../../../../ui/dialog"
import { type PageContext, PageOutMessage } from "../../../contract"
import { statusPageHref } from "../../shared/status-page-commands"
import { slugFromName, slugIssue } from "../slug"
import { CreateStatusPage, FetchStatusPages } from "./command"
import { Message } from "./message"
import type { Model } from "./model"

export const CREATE_DIALOG_ID = "status-pages-create"

export type Return = Readonly<{
	model: Model
	commands?: ReadonlyArray<Command.Command<Message, never, Resources>>
	outMessage?: PageOutMessage
}>

export const init = (): Model => ({
	pages: Keyed.idle(),
	createDialog: Dialog.init(CREATE_DIALOG_ID, "dialog"),
	name: "",
	slug: "",
	isSlugEdited: false,
	isCreating: false,
	createFailure: null,
})

const pagesKey = (context: PageContext) => requestKey(context.orgId, "statusPages.summaries", {})

/** Reads the pages under `mode`; the hub calls it when the tab opens. */
export const request = (model: Model, context: PageContext, mode: Keyed.ReadMode): Return =>
	Option.match(Keyed.requestFor(model.pages, pagesKey(context), mode), {
		onNone: () => ({ model }),
		onSome: (pages) => ({ model: { ...model, pages }, commands: [FetchStatusPages({ key: pages.key })] }),
	})

const liftDialog = (model: Model, step: ReturnType<typeof Dialog.update>): Return => ({
	model: { ...model, createDialog: step.model },
	commands: FoldkitCommand.mapMessages(step.commands ?? [], (message) =>
		Message.GotCreateDialogMessage({ message }),
	),
})

/** What stops the create: the name, then the address. */
export const createIssue = (model: Model): string | null =>
	model.name.trim() === "" ? "Add a name." : slugIssue(model.slug)

const create = (model: Model): Return =>
	model.isCreating || createIssue(model) !== null
		? { model }
		: {
				model: { ...model, isCreating: true, createFailure: null },
				commands: [CreateStatusPage({ payload: { name: model.name.trim(), slug: model.slug } })],
			}

export const update = (model: Model, message: Message, context: PageContext): Return =>
	Message.match<Return>(message, {
		CompletedFetchPages: ({ key, result }) => ({
			model: { ...model, pages: Keyed.accept(model.pages, key, result) },
		}),
		ClickedRetry: () => request(model, context, "Supersede"),
		ClickedNew: () =>
			liftDialog(
				{ ...model, name: "", slug: "", isSlugEdited: false, createFailure: null },
				Dialog.open(model.createDialog),
			),
		ChangedName: ({ value }) => ({
			model: { ...model, name: value, slug: model.isSlugEdited ? model.slug : slugFromName(value) },
		}),
		ChangedSlug: ({ value }) => {
			const slug = value.trim().toLowerCase()
			// Clearing the address (spaces included) hands it back to the name.
			return { model: { ...model, slug, isSlugEdited: slug !== "" } }
		},
		SubmittedCreate: () => create(model),
		CompletedCreate: ({ result }) =>
			Result.match(result, {
				onSuccess: (page): Return => ({
					...liftDialog({ ...model, isCreating: false }, Dialog.close(model.createDialog)),
					outMessage: PageOutMessage.RequestedNavigation({
						url: statusPageHref(page.id),
						isReplace: false,
						toast: { type: "success", title: "Status page created", description: "" },
					}),
				}),
				onFailure: (createFailure): Return => ({
					model: { ...model, isCreating: false, createFailure },
				}),
			}),
		// A create in flight keeps the dialog open.
		GotCreateDialogMessage: ({ message: child }) =>
			model.isCreating ? { model } : liftDialog(model, Dialog.update(model.createDialog, child)),
	})
