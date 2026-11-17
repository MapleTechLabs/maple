import { OrgId } from "@maple/domain"
import { StatusPagePublicId, V2StatusPage, V2StatusPageComponent } from "@maple/domain/http/v2"
import { Effect, Option, Result, Schema, Array as Arr } from "effect"
import { Command, Subscription, type Update } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { defineMessageUnion } from "foldkit/message"
import type { PageContext } from "../../page/contract"
import { selectField, textField } from "../../page/status-pages/shared/fields"
import { PRESETS, presetCards } from "../../page/status-pages/shared/look"
import { Message as ListMessage } from "../../page/status-pages/list/message"
import { Model as ListModel } from "../../page/status-pages/list/model"
import { init as listInit, update as listUpdate } from "../../page/status-pages/list/update"
import { view as listView } from "../../page/status-pages/list/view"
import {
	FocusEditorElement,
	RemovePassword,
	ReorderComponents,
	SaveComponent,
	SaveVisibility,
} from "../../page/status-pages/editor/command"
import { Message as EditorMessage } from "../../page/status-pages/editor/message"
import { AccessAction, Model as EditorModel } from "../../page/status-pages/editor/model"
import { componentsOf, listedComponentsOf, pageOf } from "../../page/status-pages/editor/reads"
import { subscriptions as editorSubscriptions } from "../../page/status-pages/editor/subscription"
import { init as editorInit, update as editorUpdate } from "../../page/status-pages/editor/update"
import { view as editorView } from "../../page/status-pages/editor/view"
import { Message as ViewerMessage } from "../../page/status-pages/viewer/message"
import { Model as ViewerModel } from "../../page/status-pages/viewer/model"
import { init as viewerInit, update as viewerUpdate } from "../../page/status-pages/viewer/update"
import { view as viewerView } from "../../page/status-pages/viewer/view"
import { StatusPageVisibility } from "@maple/domain"
import { makeSnapshot } from "@maple/status-page/fixtures"
import { componentPayload } from "../../page/status-pages/shared/form"
import { component, incident, incidentId, statusPage } from "../../page/status-pages/shared/test-pages"
import { downMonitor, httpMonitor } from "../../page/kit/uptime/test-monitors"
import type { Resources } from "../../platform/resources"
import { keepLocal } from "../local-commands"
import { defineShellLab } from "../shell-lab"
import { LAB_NOW_MS, LAB_ORG, LAB_PAGES } from "../status-pages-fixture"
import type { StatusPageSummary } from "../../page/status-pages/shared/derive"
import { labGrants, LabRole, readLabRole } from "../viewer-role"

// `/lab/status-pages`: the status pages list, the look picker and the form fields over fixture
// pages, the list with no page yet, a page's editor open on an incident, on Settings > Monitors
// with grouped components to drag, on the Incidents or Maintenance tab with nothing posted, or
// the full-screen preview "Open page" opens, as a public, password or internal page
// (`?page=list|empty|editor|monitors|incidents-empty|maintenance-empty|preview&visibility=public|password|internal`),
// as the viewer `?role=` names: an analyst reads the incident and gets no control that posts,
// edits or deletes one. The editor runs for real with no API: a reorder, a component's Save and
// an Access save land at once, every other read and write is dropped.

const context: PageContext = {
	orgId: Schema.decodeSync(OrgId)(LAB_ORG),
	pinnedNamespace: null,
	timeZone: "UTC",
}

const PAGES = [
	"list",
	"empty",
	"editor",
	"monitors",
	"incidents-empty",
	"maintenance-empty",
	"preview",
] as const
const LabPage = Schema.Literals(PAGES)
type LabPage = typeof LabPage.Type
/** The list over the fixture pages, or over none for its empty state. */
const isListPage = (page: LabPage): boolean => page === "list" || page === "empty"
const decodePage = Schema.decodeUnknownOption(LabPage)

const Model = Schema.Struct({ page: LabPage, list: ListModel, editor: EditorModel, viewer: ViewerModel })
type Model = typeof Model.Type
const Message = defineMessageUnion({
	GotListMessage: { message: ListMessage },
	GotEditorMessage: { message: EditorMessage },
	GotViewerMessage: { message: ViewerMessage },
	Ignored: {},
})
type Message = typeof Message.Type
const Flags = Schema.Struct({ page: LabPage, role: LabRole, visibility: StatusPageVisibility })
const decodeVisibility = Schema.decodeUnknownOption(StatusPageVisibility)
type Flags = typeof Flags.Type
type EditorPage = Exclude<LabPage, "list" | "empty" | "preview">

/** The URL search each editor page opens on. */
const editorSearch = (page: EditorPage) => {
	switch (page) {
		case "editor":
			return {}
		case "monitors":
			// `&section=basic|appearance|…` opens another Settings section beside Monitors' fixtures.
			return {
				view: "settings",
				section: new URLSearchParams(globalThis.location.search).get("section") ?? "monitors",
			}
		case "incidents-empty":
			return { view: "incidents" }
		case "maintenance-empty":
			return { view: "maintenance" }
	}
}

const listModel = (role: LabRole, pages: ReadonlyArray<StatusPageSummary>): ListModel => {
	const step = (model: ListModel, message: ListMessage) => listUpdate(model, message, context).model
	const entered = Arr.reduce(
		[
			ListMessage.ReadClock({ nowMs: LAB_NOW_MS }),
			ListMessage.CompletedFetchSession({ orgId: LAB_ORG, grants: labGrants(role) }),
		],
		listInit({ _tag: "StatusPages" }, context).model,
		step,
	)
	return step(
		entered,
		ListMessage.CompletedFetchPages({ key: entered.pages.key ?? "", result: Result.succeed(pages) }),
	)
}

/** The full-screen preview over the fixture snapshot, read back as the page's `visibility`. */
const viewerModel = (visibility: StatusPageVisibility): ViewerModel => {
	const entered = viewerInit(
		{ _tag: "StatusPageView", pageId: Schema.encodeSync(StatusPagePublicId)(statusPage().id) },
		context,
	).model
	const snapshot = makeSnapshot()
	return viewerUpdate(
		entered,
		ViewerMessage.CompletedFetchView({
			key: entered.snapshot.key ?? "",
			result: Result.succeed({ ...snapshot, page: { ...snapshot.page, visibility } }),
		}),
		context,
	).model
}

/** Settings > Monitors: three groups, the ungrouped last, one component driven by a down monitor. */
const MONITOR_COMPONENTS = [
	component(1, { name: "API", group: "Core", monitor_id: httpMonitor().id }),
	component(2, { name: "Dashboard", group: "Core" }),
	component(3, { name: "Webhooks", group: "Core", monitor_id: downMonitor().id }),
	component(4, { name: "CDN", group: "Edge" }),
	component(5, { name: "DNS", group: "Edge" }),
	component(6, { name: "Docs" }),
	component(7, { name: "Status API" }),
]

/**
 * The editor over a live page with an open incident, a draft maintenance and one resolved: open on
 * the first incident, or on Settings > Monitors over grouped components. The empty pages post
 * nothing, so their tab shows its empty state.
 */
const editorModel = (role: LabRole, page: EditorPage): EditorModel => {
	const step = (model: EditorModel, message: EditorMessage) => editorUpdate(model, message, context).model
	const entered = editorInit(
		{
			_tag: "StatusPage",
			pageId: Schema.encodeSync(StatusPagePublicId)(statusPage().id),
			search: editorSearch(page),
		},
		context,
	).model
	return Arr.reduce(
		[
			EditorMessage.ReadClock({ nowMs: LAB_NOW_MS }),
			EditorMessage.CompletedFetchSession({ orgId: LAB_ORG, grants: labGrants(role) }),
			EditorMessage.CompletedFetchPage({
				key: entered.page.key ?? "",
				result: Result.succeed(statusPage()),
			}),
			EditorMessage.CompletedFetchComponents({
				key: entered.components.key ?? "",
				result: Result.succeed(
					page === "monitors"
						? MONITOR_COMPONENTS
						: [
								component(1, { name: "API" }),
								component(2, { name: "Dashboard" }),
								component(3, { name: "Ingest" }),
							],
				),
			}),
			EditorMessage.CompletedFetchIncidents({
				key: entered.incidents.key ?? "",
				result: Result.succeed(
					page === "incidents-empty" || page === "maintenance-empty"
						? []
						: [
								incident(1, { title: "Elevated API errors" }),
								incident(2, {
									kind: "maintenance",
									title: "Database upgrade",
									published: false,
								}),
								incident(3, { title: "Delayed ingest", status: "resolved" }),
							],
				),
			}),
			EditorMessage.CompletedFetchMonitors({
				key: entered.monitors.key ?? "",
				result: Result.succeed([httpMonitor(), downMonitor()]),
			}),
			...(page === "editor" ? [EditorMessage.ClickedIncident({ incidentId: incidentId(1) })] : []),
		],
		entered,
		step,
	)
}

const section = (h: HtmlBuilder<Message>, title: string, children: ReadonlyArray<Html>): Html =>
	h.section(
		[h.Class("flex flex-col gap-3")],
		[h.h2([h.Class("text-xs text-muted-foreground")], [title]), ...children],
	)

type Return = Update.Return<Model, Message, Resources>
type EditorCommands = ReadonlyArray<Command.Command<EditorMessage, never, Resources>>

/** The lab's API for a reorder: saved at once, as sent. */
const AnswerReorder = Command.define("AnswerLabStatusPageReorder", {
	args: { components: Schema.Array(V2StatusPageComponent) },
	messages: [EditorMessage.CompletedReorder],
	execute: ({ components }) =>
		Effect.succeed(EditorMessage.CompletedReorder({ result: Result.succeed(components) })),
})

/** The lab's API for a component's Save: the component as sent. */
const AnswerSave = Command.define("AnswerLabStatusPageComponentSave", {
	args: { component: V2StatusPageComponent },
	messages: [EditorMessage.CompletedSaveComponent],
	execute: ({ component }) =>
		Effect.succeed(EditorMessage.CompletedSaveComponent({ result: Result.succeed(component) })),
})

/** The component the save in flight sends: its listed row with the form over it. */
const savedOf = (model: EditorModel): ReadonlyArray<V2StatusPageComponent> =>
	Arr.findFirst(componentsOf(model), (row) => row.id === model.componentForm.editingId).pipe(
		Option.map((row) => ({ ...row, ...componentPayload(model.componentForm) })),
		Option.toArray,
	)

/** The lab's API for each part of an Access save: the page with that part saved. */
const AnswerAccess = Command.define("AnswerLabStatusPageAccess", {
	args: { action: AccessAction, page: V2StatusPage },
	messages: [EditorMessage.CompletedAccessChange],
	execute: ({ action, page }) =>
		Effect.succeed(EditorMessage.CompletedAccessChange({ action, result: Result.succeed(page) })),
})

/** The commands of an Access save; the password's is built by hand, so it is named here. */
const ACCESS_COMMANDS = ["SetStatusPagePassword", SaveVisibility.name, RemovePassword.name]

/** The page once the Access part in flight is saved. */
const accessAnswers = (model: EditorModel): EditorCommands => {
	const action = model.accessAction
	if (action === null) return []
	return Arr.map(Option.toArray(pageOf(model)), (page) =>
		AnswerAccess({
			action,
			page:
				action === "password"
					? { ...page, has_password: true }
					: action === "visibility"
						? { ...page, visibility: model.visibilityDraft ?? page.visibility }
						: { ...page, has_password: false },
		}),
	)
}

const sends = (commands: EditorCommands | undefined, name: string): boolean =>
	Arr.some(commands ?? [], (command) => command.name === name)

/** The kit's commands and the editor's focus moves run; a reorder and the Saves are answered; the rest is dropped. */
const kept = (model: EditorModel, commands: EditorCommands | undefined): EditorCommands => [
	...keepLocal(commands),
	...Arr.filter(commands ?? [], (command) => command.name === FocusEditorElement.name),
	...(sends(commands, ReorderComponents.name)
		? [AnswerReorder({ components: listedComponentsOf(model) })]
		: []),
	...(sends(commands, SaveComponent.name)
		? Arr.map(savedOf(model), (saved) => AnswerSave({ component: saved }))
		: []),
	...(Arr.some(ACCESS_COMMANDS, (name) => sends(commands, name)) ? accessAnswers(model) : []),
]

const update = (model: Model, message: Message): Return =>
	Message.match<Return>(message, {
		GotEditorMessage: ({ message: child }) => {
			const next = editorUpdate(model.editor, child, context)
			return {
				model: { ...model, editor: next.model },
				commands: Command.mapMessages(kept(next.model, next.commands), (inner) =>
					Message.GotEditorMessage({ message: inner }),
				),
			}
		},
		// The preview's switches only redraw it; its one read (Try again) is dropped.
		GotViewerMessage: ({ message: child }) => ({
			model: { ...model, viewer: viewerUpdate(model.viewer, child, context).model },
		}),
		GotListMessage: () => ({ model }),
		Ignored: () => ({ model }),
	})

/** The editor's own: Escape closes what is open, a grip drags its row. */
const subscriptions = Subscription.lift(editorSubscriptions)<Model, Message>({
	read: (model) =>
		isListPage(model.page) || model.page === "preview"
			? Option.none()
			: Option.some({ model: model.editor, context }),
	toParentMessage: (message) => Message.GotEditorMessage({ message }),
})

const view = (model: Model, h: HtmlBuilder<Message>): Html =>
	model.page === "preview"
		? h.submodel({
				slotId: "status-pages-lab-viewer",
				model: model.viewer,
				view: viewerView,
				viewInputs: { context },
				toParentMessage: (message) => Message.GotViewerMessage({ message }),
			})
		: !isListPage(model.page)
			? h.submodel({
					slotId: "status-pages-lab-editor",
					model: model.editor,
					view: editorView,
					viewInputs: { context },
					toParentMessage: (message) => Message.GotEditorMessage({ message }),
				})
			: listPage(model, h)

const listPage = (model: Model, h: HtmlBuilder<Message>): Html =>
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
	flags: Effect.map(readLabRole, (role): Flags => ({
		page: Option.getOrElse(
			decodePage(new URLSearchParams(globalThis.location.search).get("page")),
			(): LabPage => "list",
		),
		role,
		visibility: Option.getOrElse(
			decodeVisibility(new URLSearchParams(globalThis.location.search).get("visibility")),
			(): StatusPageVisibility => "public",
		),
	})),
	init: (flags: Flags) => ({
		model: {
			page: flags.page,
			list: listModel(flags.role, flags.page === "empty" ? [] : LAB_PAGES),
			editor: editorModel(
				flags.role,
				flags.page === "list" || flags.page === "empty" || flags.page === "preview"
					? "editor"
					: flags.page,
			),
			viewer: viewerModel(flags.visibility),
		},
	}),
	update,
	subscriptions,
	view,
	currentPath: "/lab/status-pages",
	breadcrumbs: [{ label: "Lab" }, { label: "Status pages" }],
})
