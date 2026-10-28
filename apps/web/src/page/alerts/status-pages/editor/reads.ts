import { Option } from "effect"
import { AsyncData, Command as FoldkitCommand } from "foldkit"
import * as Keyed from "../../../../data/keyed"
import type { LoadFailure } from "../../../../data/load-failure"
import { requestKey } from "../../../../data/request-key"
import * as Dialog from "../../../../ui/dialog"
import { type PageContext, PageOutMessage, type PageReturn } from "../../../contract"
import { UPTIME_LIST_LIMIT } from "../../shared/uptime-commands"
import { FetchComponents, FetchEditorMonitors, FetchIncidents, FetchPage } from "./command"
import { Message } from "./message"
import type { Model } from "./model"

// The editor's reads, the re-reads after a write, and the small helpers every update file shares.

export type Return = PageReturn<Model, Message>

const pageKey = (context: PageContext, pageId: string) =>
	requestKey(context.orgId, "statusPages.retrieve", { pageId })
const componentsKey = (context: PageContext, pageId: string) =>
	requestKey(context.orgId, "statusPages.listComponents", { pageId })
const incidentsKey = (context: PageContext, pageId: string) =>
	requestKey(context.orgId, "statusPageIncidents.list", { pageId })
const monitorsKey = (context: PageContext) =>
	requestKey(context.orgId, "uptimeMonitors.list", { query: { limit: UPTIME_LIST_LIMIT } })

/** Joins steps left to right: each one's Model feeds the next, Commands add up. */
export const chain = (model: Model, ...steps: ReadonlyArray<(model: Model) => Return>): Return =>
	steps.reduce<Return>(
		(previous, step) => {
			const next = step(previous.model)
			return {
				model: next.model,
				commands: [...(previous.commands ?? []), ...(next.commands ?? [])],
				outMessage: next.outMessage ?? previous.outMessage,
			}
		},
		{ model },
	)

export const readPage =
	(context: PageContext, mode: Keyed.ReadMode) =>
	(model: Model): Return => {
		const id = model.pageId
		if (id === null) return { model }
		return Option.match(Keyed.requestFor(model.page, pageKey(context, id), mode), {
			onNone: () => ({ model }),
			onSome: (page) => ({
				model: { ...model, page },
				commands: [FetchPage({ key: page.key, pageId: id })],
			}),
		})
	}

export const readComponents =
	(context: PageContext, mode: Keyed.ReadMode) =>
	(model: Model): Return => {
		const id = model.pageId
		if (id === null) return { model }
		return Option.match(Keyed.requestFor(model.components, componentsKey(context, id), mode), {
			onNone: () => ({ model }),
			onSome: (components) => ({
				model: { ...model, components },
				commands: [FetchComponents({ key: components.key, pageId: id })],
			}),
		})
	}

export const readIncidents =
	(context: PageContext, mode: Keyed.ReadMode) =>
	(model: Model): Return => {
		const id = model.pageId
		if (id === null) return { model }
		return Option.match(Keyed.requestFor(model.incidents, incidentsKey(context, id), mode), {
			onNone: () => ({ model }),
			onSome: (incidents) => ({
				model: { ...model, incidents },
				commands: [FetchIncidents({ key: incidents.key, pageId: id })],
			}),
		})
	}

export const readMonitors =
	(context: PageContext, mode: Keyed.ReadMode) =>
	(model: Model): Return =>
		model.pageId === null
			? { model }
			: Option.match(Keyed.requestFor(model.monitors, monitorsKey(context), mode), {
					onNone: () => ({ model }),
					onSome: (monitors) => ({
						model: { ...model, monitors },
						commands: [FetchEditorMonitors({ key: monitors.key })],
					}),
				})

export const pageOf = (model: Model) => AsyncData.getData(model.page.data)
export const componentsOf = (model: Model) => AsyncData.getOrElse(model.components.data, () => [])
export const incidentsOf = (model: Model) => AsyncData.getOrElse(model.incidents.data, () => [])
export const monitorsOf = (model: Model) => AsyncData.getOrElse(model.monitors.data, () => [])

export const toast = (type: "success" | "error", title: string, description = ""): PageOutMessage =>
	PageOutMessage.RequestedToast({ type, title, description })

export const errorToast = (title: string, failure: LoadFailure): PageOutMessage =>
	toast("error", title, failure.message)

/** A dialog's step lifted into the page: its Model written back, its Commands wrapped. */
export const liftDialog = (
	model: Model,
	step: ReturnType<typeof Dialog.update>,
	write: (model: Model, dialog: Dialog.Model) => Model,
	wrap: (message: Dialog.Message) => Message,
): Return => ({
	model: write(model, step.model),
	commands: FoldkitCommand.mapMessages(step.commands ?? [], wrap),
})
