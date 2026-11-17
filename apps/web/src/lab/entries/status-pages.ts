import * as Policy from "@maple/domain/policy"
import { OrgId } from "@maple/domain"
import { Effect, Result, Schema, Array as Arr } from "effect"
import { AsyncData, Command } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { defineMessageUnion } from "foldkit/message"
import type { PageContext } from "../../page/contract"
import { selectField, textField } from "../../page/status-pages/shared/fields"
import { PRESETS, presetCards } from "../../page/status-pages/shared/look"
import { Message as ListMessage } from "../../page/status-pages/list/message"
import { Model as ListModel } from "../../page/status-pages/list/model"
import { init as listInit, update as listUpdate } from "../../page/status-pages/list/update"
import { view as listView } from "../../page/status-pages/list/view"
import type { Resources } from "../../platform/resources"
import { defineShellLab } from "../shell-lab"
import { LAB_NOW_MS, LAB_ORG, LAB_PAGES } from "../status-pages-fixture"

// `/lab/status-pages`: the status pages list, the look picker and the form fields over fixture pages.

const context: PageContext = {
	orgId: Schema.decodeSync(OrgId)(LAB_ORG),
	pinnedNamespace: null,
	timeZone: "UTC",
}

const Model = Schema.Struct({ list: ListModel })
type Model = typeof Model.Type
const Message = defineMessageUnion({ GotListMessage: { message: ListMessage }, Ignored: {} })
type Message = typeof Message.Type
const Flags = Schema.Struct({})

const listModel = (): ListModel => {
	const step = (model: ListModel, message: ListMessage) => listUpdate(model, message, context).model
	const entered = Arr.reduce(
		[
			ListMessage.ReadClock({ nowMs: LAB_NOW_MS }),
			ListMessage.CompletedFetchSession({ orgId: LAB_ORG, grants: Policy.allPermissions }),
		],
		listInit({ _tag: "StatusPages" }, context).model,
		step,
	)
	return step(
		entered,
		ListMessage.CompletedFetchPages({ key: entered.pages.key ?? "", result: Result.succeed(LAB_PAGES) }),
	)
}

type ListCommand = Command.Command<ListMessage, never, Resources>

/** A delete is answered from the fixture: the page leaves the list as it would after the API's answer. */
const answerLocally = (
	model: ListModel,
	commands: ReadonlyArray<ListCommand>,
): { model: ListModel; commands: ReadonlyArray<ListCommand> } => {
	const deleting = model.deletingPageId
	if (deleting === null || !Arr.some(commands, (command) => command.name === "DeleteListedStatusPage"))
		return { model, commands: Arr.filter(commands, (command) => !/^(Fetch|Read)/.test(command.name)) }
	const done = listUpdate(
		model,
		ListMessage.CompletedDelete({ result: Result.succeed(undefined) }),
		context,
	)
	const remaining = Arr.filter(
		AsyncData.getOrElse(model.pages.data, () => LAB_PAGES),
		(row) => row.page.id !== deleting,
	)
	const reread = listUpdate(
		done.model,
		ListMessage.CompletedFetchPages({
			key: done.model.pages.key ?? "",
			result: Result.succeed(remaining),
		}),
		context,
	)
	return {
		model: reread.model,
		commands: Arr.filter(done.commands ?? [], (command) => !/^(Fetch|Read)/.test(command.name)),
	}
}

const update = (
	model: Model,
	message: Message,
): { model: Model; commands?: ReadonlyArray<Command.Command<Message, never, Resources>> } =>
	Message.match(message, {
		GotListMessage: ({ message: child }) => {
			const step = listUpdate(model.list, child, context)
			const local = answerLocally(step.model, step.commands ?? [])
			return {
				model: { ...model, list: local.model },
				commands: Command.mapMessages(local.commands, (inner) =>
					Message.GotListMessage({ message: inner }),
				),
			}
		},
		Ignored: () => ({ model }),
	})

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
				[
					h.Id("status-pages-lab-parts"),
					h.Class("mx-auto flex w-full max-w-3xl flex-col gap-8 px-4"),
				],
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
	update,
	view,
	currentPath: "/lab/status-pages",
	breadcrumbs: [{ label: "Lab" }, { label: "Status pages" }],
})
