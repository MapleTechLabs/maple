import { OrgId } from "@maple/domain"
import { Effect, Result, Schema } from "effect"
import type { Html, HtmlBuilder } from "foldkit/html"
import { defineMessageUnion } from "foldkit/message"
import { NOW, ORG } from "../../page/alerts/shared/test-rows"
import type { PageContext } from "../../page/contract"
import { selectField, textField } from "../../page/status-pages/shared/fields"
import { PRESETS, presetCards } from "../../page/status-pages/shared/look"
import { pageId, statusPage } from "../../page/status-pages/shared/test-pages"
import { Message as ListMessage } from "../../page/status-pages/list/message"
import { Model as ListModel } from "../../page/status-pages/list/model"
import { init as listInit, update as listUpdate } from "../../page/status-pages/list/update"
import { view as listView } from "../../page/status-pages/list/view"
import { defineShellLab } from "../shell-lab"

// `/lab/status-pages`: the status pages list, the look picker and the form fields over fixture pages.

const context: PageContext = { orgId: Schema.decodeSync(OrgId)(ORG), pinnedNamespace: null, timeZone: "UTC" }

const Model = Schema.Struct({ list: ListModel })
type Model = typeof Model.Type
const Message = defineMessageUnion({ GotListMessage: { message: ListMessage }, Ignored: {} })
type Message = typeof Message.Type
const Flags = Schema.Struct({})

const listModel = (): ListModel => {
	const step = (model: ListModel, message: ListMessage) => listUpdate(model, message, context).model
	const entered = [
		ListMessage.ReadClock({ nowMs: NOW }),
		ListMessage.CompletedFetchSession({ orgId: ORG, isAdmin: true }),
	].reduce(step, listInit({ _tag: "StatusPages" }, context).model)
	const pages = [
		{ page: statusPage(), overall: "operational" as const, componentCount: 4, openIncidents: 0 },
		{
			page: statusPage({
				id: pageId(2),
				name: "Internal tools",
				slug: "acme-internal",
				last_publish_error: "The custom domain did not verify",
			}),
			overall: "partial_outage" as const,
			componentCount: 2,
			openIncidents: 1,
		},
	]
	return step(entered, ListMessage.CompletedFetchPages({ key: entered.pages.key ?? "", result: Result.succeed(pages) }))
}

const section = (h: HtmlBuilder<Message>, title: string, children: ReadonlyArray<Html>): Html =>
	h.section(
		[h.Class("flex flex-col gap-3")],
		[h.h2([h.Class("text-xs text-muted-foreground")], [title]), ...children],
	)

const view = (model: Model, h: HtmlBuilder<Message>): Html =>
	h.div(
		[h.Class("flex flex-col gap-8 pb-8")],
		[
			h.submodel({
				slotId: "status-pages-lab-list",
				model: model.list,
				view: listView,
				viewInputs: { context },
				toParentMessage: (message) => Message.GotListMessage({ message }),
			}),
			h.div(
				[h.Id("status-pages-lab-parts"), h.Class("mx-auto flex w-full max-w-3xl flex-col gap-8 px-4")],
				[
					section(h, "Look", [
						presetCards(h, {
							selected: PRESETS[0]?.value ?? "default",
							isDisabled: false,
							onPick: () => Message.Ignored(),
						}),
					]),
					section(h, "Fields", [
						textField(h, {
							id: "lab-name",
							label: "Name",
							value: "Acme Status",
							hint: "Shown in the page header and the browser tab.",
							onInput: () => Message.Ignored(),
						}),
						textField(h, {
							id: "lab-slug",
							label: "Address",
							value: "acme status",
							isMono: true,
							error: "Use lowercase letters, numbers and dashes.",
							onInput: () => Message.Ignored(),
						}),
						selectField(h, {
							id: "lab-appearance",
							label: "Appearance",
							value: "system",
							entries: [
								{ value: "system", label: "Follow the visitor" },
								{ value: "light", label: "Light" },
							],
							onInput: () => Message.Ignored(),
						}),
					]),
				],
			),
		],
	)

export const lab = defineShellLab("Status pages", {
	Model,
	Message,
	Flags,
	flags: Effect.succeed({}),
	init: () => ({ model: { list: listModel() } }),
	update: (model) => ({ model }),
	view,
	currentPath: "/lab/status-pages",
	breadcrumbs: [{ label: "Lab" }, { label: "Status pages" }],
})
