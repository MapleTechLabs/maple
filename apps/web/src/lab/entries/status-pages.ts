import { OrgId } from "@maple/domain"
import { StatusPagePublicId, V2StatusPage, V2StatusPageComponent } from "@maple/domain/http/v2"
import { Effect, Option, Result, Schema, Array as Arr, String as Str } from "effect"
import { AsyncData, Command, Subscription, type Update } from "foldkit"
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
import { FocusBuilderField } from "../../page/status-pages/builder/command"
import { Message as BuilderMessage } from "../../page/status-pages/builder/message"
import { Model as BuilderModel } from "../../page/status-pages/builder/model"
import { subscriptions as builderSubscriptions } from "../../page/status-pages/builder/subscription"
import { init as builderInit, update as builderUpdate } from "../../page/status-pages/builder/update"
import { view as builderView } from "../../page/status-pages/builder/view"
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
import * as Combobox from "@maple/views/ui/combobox"
import { groupPickerValue } from "../../page/status-pages/shared/group-picker"
import { monitorKey } from "../../page/status-pages/shared/picker"
import {
	component,
	componentId,
	incident,
	incidentId,
	statusPage,
} from "../../page/status-pages/shared/test-pages"
import { downMonitor, httpMonitor, monitorId } from "../../page/kit/uptime/test-monitors"
import type { Resources } from "../../platform/resources"
import { keepLocal } from "../local-commands"
import { defineShellLab } from "../shell-lab"
import { LAB_NOW_MS, LAB_ORG, LAB_PAGES } from "../status-pages-fixture"
import type { StatusPageSummary } from "../../page/status-pages/shared/derive"
import { labGrants, LabRole, readLabRole } from "../viewer-role"

// `/lab/status-pages`: the status pages list, the look picker and the form fields over fixture
// pages, the list with no page yet, a page's editor open on an incident, on Settings > Monitors
// with grouped components to drag (`monitors-group` with the Group dropdown open), on the Incidents
// or Maintenance tab with nothing posted (`incidents-empty`, `maintenance-empty`), the full-screen
// preview "Open page" opens, as a public, password or internal page (`preview&visibility=public|
// password|internal`), or the new page builder (`new`, `new-empty`, `new-add`, `new-group`,
// `new-domain`), as the viewer `?role=` names: an analyst reads the incident and gets no control
// that posts, edits or deletes one. The editor runs for real with no API: a reorder, a component's
// Save and an Access save land at once, every other read and write is dropped.

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
	"monitors-group",
	"incidents-empty",
	"maintenance-empty",
	"preview",
	"new",
	"new-empty",
	"new-add",
	"new-group",
	"new-domain",
] as const
const LabPage = Schema.Literals(PAGES)
type LabPage = typeof LabPage.Type
/** The list over the fixture pages, or over none for its empty state. */
const isListPage = (page: LabPage): boolean => page === "list" || page === "empty"
/** The new page builder, in one of its states. */
const isBuilderPage = (page: LabPage): boolean => Str.startsWith("new")(page)
const decodePage = Schema.decodeUnknownOption(LabPage)

const Model = Schema.Struct({
	page: LabPage,
	list: ListModel,
	editor: EditorModel,
	viewer: ViewerModel,
	builder: BuilderModel,
})
type Model = typeof Model.Type
const Message = defineMessageUnion({
	GotListMessage: { message: ListMessage },
	GotEditorMessage: { message: EditorMessage },
	GotBuilderMessage: { message: BuilderMessage },
	GotViewerMessage: { message: ViewerMessage },
	Ignored: {},
})
type Message = typeof Message.Type
const Flags = Schema.Struct({ page: LabPage, role: LabRole, visibility: StatusPageVisibility })
const decodeVisibility = Schema.decodeUnknownOption(StatusPageVisibility)
type Flags = typeof Flags.Type
type EditorPage = "editor" | "monitors" | "incidents-empty" | "maintenance-empty"

/** The editor state a lab page shows; pages that show no editor still build the plain one. */
const editorPageOf = (page: LabPage): EditorPage =>
	page === "monitors" || page === "monitors-group"
		? "monitors"
		: page === "incidents-empty" || page === "maintenance-empty"
			? page
			: "editor"

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
 * the first incident (opened in `init`), or on Settings > Monitors over grouped components. The empty pages post
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
		],
		entered,
		step,
	)
}

/** The builder over five monitors, all on the page from the start. */
const LAB_MONITORS = [
	httpMonitor(),
	downMonitor(),
	httpMonitor({ id: monitorId(3), name: "dashboard" }),
	httpMonitor({ id: monitorId(4), name: "webhooks" }),
	httpMonitor({ id: monitorId(5), name: "docs" }),
]

const groupOf = (message: Combobox.Message) => BuilderMessage.GotGroupPickerMessage({ message })

/** The steps after the monitors read that put the builder in `page`'s state. */
const builderSteps = (page: LabPage): ReadonlyArray<BuilderMessage> => {
	switch (page) {
		case "new-add":
			return [
				BuilderMessage.ClickedRemoveRow({ key: monitorKey(monitorId(4)) }),
				BuilderMessage.ClickedRemoveRow({ key: monitorKey(monitorId(5)) }),
				BuilderMessage.ClickedAddComponents(),
			]
		case "new-group":
			return [
				BuilderMessage.ClickedRow({ key: monitorKey(httpMonitor().id) }),
				groupOf(Combobox.Message.ClickedItem({ value: groupPickerValue.create("Core") })),
				BuilderMessage.ClickedRow({ key: monitorKey(downMonitor().id) }),
				groupOf(Combobox.Message.ClickedTriggerOf({ items: [] })),
				groupOf(Combobox.Message.ChangedInput({ value: "Pay" })),
			]
		case "new-domain":
			return [BuilderMessage.ChangedCustomDomain({ value: "status.acme.com" })]
		default:
			return []
	}
}

/**
 * The builder over five monitors, all on the page from the start (none with `new-empty`); `new-add`
 * opens Add components, `new-group` the Group dropdown with "Pay" typed, `new-domain` fills the custom domain.
 */
const builderModel = (
	role: LabRole,
	page: LabPage,
): Update.Return<BuilderModel, BuilderMessage, Resources> => {
	const entered = builderInit({ _tag: "StatusPageNew" }, context).model
	return Arr.reduce(
		[
			BuilderMessage.ReadClock({ nowMs: LAB_NOW_MS }),
			BuilderMessage.CompletedFetchSession({ orgId: LAB_ORG, grants: labGrants(role) }),
			BuilderMessage.CompletedFetchMonitors({
				key: entered.monitors.key ?? "",
				result: Result.succeed(page === "new-empty" ? [] : LAB_MONITORS),
			}),
			BuilderMessage.ChangedName({ value: "Acme Status" }),
			...builderSteps(page),
		],
		{ model: entered, commands: [] } as Update.Return<BuilderModel, BuilderMessage, Resources>,
		(current, message) => {
			const next = builderUpdate(current.model, message, context)
			return { model: next.model, commands: [...(current.commands ?? []), ...keepLocal(next.commands)] }
		},
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
		GotBuilderMessage: ({ message: child }) => {
			const next = builderUpdate(model.builder, child, context)
			return {
				model: { ...model, builder: next.model },
				commands: Command.mapMessages(
					[
						...keepLocal(next.commands),
						...Arr.filter(
							next.commands ?? [],
							(command) => command.name === FocusBuilderField.name,
						),
					],
					(inner) => Message.GotBuilderMessage({ message: inner }),
				),
			}
		},
		// The preview's switches only redraw it; its one read (Try again) is dropped.
		GotViewerMessage: ({ message: child }) => ({
			model: { ...model, viewer: viewerUpdate(model.viewer, child, context).model },
		}),
		// The row menu and delete dialog run for real; a confirmed delete drops the page from the fixture.
		GotListMessage: ({ message: child }) => {
			const next = listUpdate(model.list, child, context)
			const deleting = model.list.deletingPageId
			const deleted =
				deleting !== null &&
				Arr.some(next.commands ?? [], (command) => command.name === "DeleteListedStatusPage")
			if (!deleted)
				return {
					model: { ...model, list: next.model },
					commands: Command.mapMessages(keepLocal(next.commands), (inner) =>
						Message.GotListMessage({ message: inner }),
					),
				}
			const done = listUpdate(
				next.model,
				ListMessage.CompletedDelete({ result: Result.succeed(undefined) }),
				context,
			)
			const remaining = Arr.filter(
				AsyncData.getOrElse(model.list.pages.data, () => LAB_PAGES),
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
				model: { ...model, list: reread.model },
				commands: Command.mapMessages(keepLocal(done.commands), (inner) =>
					Message.GotListMessage({ message: inner }),
				),
			}
		},
		Ignored: () => ({ model }),
	})

/** The editor's own: Escape closes what is open, a grip drags its row. */
const editorSubscriptionsLifted = Subscription.lift(editorSubscriptions)<Model, Message>({
	read: (model) =>
		model.page === "editor" ||
		model.page === "monitors" ||
		model.page === "monitors-group" ||
		model.page === "incidents-empty" ||
		model.page === "maintenance-empty"
			? Option.some({ model: model.editor, context })
			: Option.none(),
	toParentMessage: (message) => Message.GotEditorMessage({ message }),
})

/** The builder's own: a grip drags its row. */
const builderSubscriptionsLifted = Subscription.lift(builderSubscriptions)<Model, Message>({
	read: (model) =>
		isBuilderPage(model.page) ? Option.some({ model: model.builder, context }) : Option.none(),
	toParentMessage: (message) => Message.GotBuilderMessage({ message }),
})

const view = (model: Model, h: HtmlBuilder<Message>): Html =>
	isBuilderPage(model.page)
		? h.submodel({
				slotId: "status-pages-lab-builder",
				model: model.builder,
				view: builderView,
				viewInputs: { context },
				toParentMessage: (message) => Message.GotBuilderMessage({ message }),
			})
		: model.page === "preview"
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
	init: (flags: Flags) => {
		const builder = builderModel(flags.role, flags.page)
		const editor = editorModel(flags.role, editorPageOf(flags.page))
		// `editor`: the first incident's sheet open; `monitors-group`: API open, its Group dropdown open.
		// Their commands run, or the sheet never leaves its starting style and covers the page unseen.
		const opening: ReadonlyArray<EditorMessage> =
			flags.page === "editor"
				? [EditorMessage.ClickedIncident({ incidentId: incidentId(1) })]
				: flags.page === "monitors-group"
					? [
							EditorMessage.ClickedComponent({ componentId: componentId(1) }),
							EditorMessage.GotGroupPickerMessage({
								message: Combobox.Message.ClickedTriggerOf({ items: [] }),
							}),
						]
					: []
		const opened =
			opening.length > 0
				? Arr.reduce(
						opening,
						{ model: editor, commands: [] } as Update.Return<
							EditorModel,
							EditorMessage,
							Resources
						>,
						(current, message) => {
							const next = editorUpdate(current.model, message, context)
							return {
								model: next.model,
								commands: [...(current.commands ?? []), ...keepLocal(next.commands)],
							}
						},
					)
				: { model: editor, commands: [] }
		return {
			model: {
				page: flags.page,
				list: listModel(flags.role, flags.page === "empty" ? [] : LAB_PAGES),
				editor: opened.model,
				viewer: viewerModel(flags.visibility),
				builder: builder.model,
			},
			commands: [
				...Command.mapMessages(builder.commands ?? [], (message) =>
					Message.GotBuilderMessage({ message }),
				),
				...Command.mapMessages(opened.commands ?? [], (message) =>
					Message.GotEditorMessage({ message }),
				),
			],
		}
	},
	update,
	subscriptions: { ...editorSubscriptionsLifted, ...builderSubscriptionsLifted },
	view,
	currentPath: "/lab/status-pages",
	breadcrumbs: [{ label: "Lab" }, { label: "Status pages" }],
})
