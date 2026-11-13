import * as Policy from "@maple/domain/policy"
import { OrgId } from "@maple/domain"
import { DashboardDocument } from "@maple/domain/http"
import { Effect, Option, Result, Schema, Array as Arr } from "effect"
import { Command } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { defineMessageUnion } from "foldkit/message"
import { button } from "@maple/views/ui/button"
import * as Menu from "@maple/views/ui/menu"
import type { PageContext } from "../../page/contract"
import { Message as ListMessage } from "../../page/dashboards/list/message"
import { type ListDashboard, Model as ListModel } from "../../page/dashboards/list/model"
import { init as listInit, update as listUpdate } from "../../page/dashboards/list/update"
import { view as listView } from "../../page/dashboards/list/view"
import { Message as BoardMessage } from "../../page/dashboards/view/message"
import { Model as BoardModel } from "../../page/dashboards/view/model"
import { init as boardInit, update as boardUpdate } from "../../page/dashboards/view/update"
import { view as boardView } from "../../page/dashboards/view/view"
import type { Resources } from "../../platform/resources"
import { defineShellLab } from "../shell-lab"

// `/lab/dashboards`: the dashboards list and one board as a member or an observer, who reads
// dashboards but cannot change or share them (`?page=list|detail&role=member|observer&mode=edit`).

const PAGES = ["list", "detail"] as const
const ROLES = ["member", "observer"] as const
type LabPage = (typeof PAGES)[number]
type LabRole = (typeof ROLES)[number]

const NOW = Date.UTC(2026, 10, 6, 12)
const context: PageContext = {
	orgId: Schema.decodeSync(OrgId)("org_lab_dashboards"),
	pinnedNamespace: null,
	timeZone: "UTC",
}
const BOARD_ID = "dash_platform"

const row = (fields: Partial<ListDashboard>): ListDashboard => ({
	id: BOARD_ID,
	name: "Platform overview",
	description: "Errors and latency across the platform services.",
	tags: ["platform"],
	widgetCount: 3,
	readsShort: "Errors",
	readsFull: "Errors",
	glyph: "CircleWarningIcon",
	createdAt: "2026-09-19T12:00:00.000Z",
	updatedAt: "2026-11-06T09:00:00.000Z",
	...fields,
})

const ROWS: ReadonlyArray<ListDashboard> = [
	row({}),
	row({
		id: "dash_checkout",
		name: "Checkout health",
		description: "Payment and cart traces.",
		tags: ["checkout"],
		widgetCount: 8,
		readsShort: "Traces · Errors",
		readsFull: "Traces · Errors",
		glyph: "PulseIcon",
		updatedAt: "2026-11-04T15:30:00.000Z",
	}),
	row({
		id: "dash_empty",
		name: "Queue workers",
		description: null,
		tags: [],
		widgetCount: 0,
		readsShort: "",
		readsFull: "",
		glyph: "GridIcon",
		updatedAt: "2026-10-21T08:00:00.000Z",
	}),
]

const stat = (id: string, title: string, field: string, x: number) => ({
	id,
	visualization: "stat",
	dataSource: {
		kind: "route",
		endpoint: "errors_summary",
		transform: { reduceToValue: { field, aggregate: "first" } },
	},
	display: { title, unit: "number" },
	layout: { x, y: 0, w: 3, h: 2 },
})

const BOARD = Schema.decodeUnknownSync(DashboardDocument)({
	id: BOARD_ID,
	name: "Platform overview",
	timeRange: { type: "relative", value: "6h" },
	widgets: [
		stat("total-errors", "Total errors", "totalErrors", 0),
		stat("affected-services", "Affected services", "affectedServices", 3),
		{
			id: "notes",
			visualization: "markdown",
			dataSource: { kind: "static" },
			display: {
				title: "Runbook",
				markdown: {
					content: "Error budget review is every Monday. Page the platform on-call first.",
				},
			},
			layout: { x: 6, y: 0, w: 6, h: 2 },
		},
	],
	createdAt: "2026-09-19T12:00:00.000Z",
	updatedAt: "2026-11-06T09:00:00.000Z",
	schemaVersion: 3,
})

/** What every stat tile's fetch answers in the lab. */
const SUMMARY = { data: [{ totalErrors: 1284, affectedServices: 7 }] }

const grantsOf = (role: LabRole): ReadonlyArray<Policy.Permission> => Policy.grantsOf([`org:${role}`])

const listModel = (role: LabRole): ListModel =>
	Arr.reduce(
		[
			ListMessage.CompletedReadClock({ nowMs: NOW, locale: "en-US" }),
			ListMessage.CompletedLoadPreferences({ favorites: [BOARD_ID], sort: "updated" }),
			ListMessage.CompletedFetchSession({ orgId: context.orgId, grants: grantsOf(role) }),
			ListMessage.UpdatedDashboards({ orgId: context.orgId, dashboards: ROWS }),
		],
		listInit({ search: {} }, context).model,
		(model, message) => listUpdate(model, message, context).model,
	)

const WidgetFetch = Schema.Struct({ key: Schema.String })
const decodeWidgetFetch = Schema.decodeUnknownOption(WidgetFetch)

// Reads and writes that would reach the API; the lab has none.
const REMOTE =
	/^(Fetch|Save|Create|Duplicate|Export|Import|Delete|Restore|Rename|Remove|Clone|Update|Add|AutoLayout|Edit|Write|Reload)/

type BoardStep = Readonly<{
	model: BoardModel
	commands: ReadonlyArray<Command.Command<BoardMessage, never, Resources>>
}>

/** One board step; a tile's fetch is answered from the fixture, other remote commands are dropped. */
const boardStep = (model: BoardModel, message: BoardMessage): BoardStep => {
	const next = boardUpdate(model, message, context)
	const commands = next.commands ?? []
	const fetched = Arr.flatMap(commands, (command) =>
		command.name === "FetchDashboardWidget" ? Option.toArray(decodeWidgetFetch(command.args)) : [],
	)
	const local = Arr.filter(commands, (command) => !REMOTE.test(command.name))
	return Arr.reduce(fetched, { model: next.model, commands: local }, (step, { key }): BoardStep => {
		const answered = boardStep(
			step.model,
			BoardMessage.CompletedFetchWidget({ key, result: Result.succeed(SUMMARY) }),
		)
		return { model: answered.model, commands: [...step.commands, ...answered.commands] }
	})
}

const boardModel = (role: LabRole, isEdit: boolean): BoardModel =>
	Arr.reduce(
		[
			BoardMessage.CompletedReadClock({ nowMs: NOW }),
			BoardMessage.CompletedFetchSession({ orgId: context.orgId, grants: grantsOf(role) }),
			BoardMessage.UpdatedDashboard({ orgId: context.orgId, maybeDocument: Option.some(BOARD) }),
		],
		boardInit({ dashboardId: BOARD_ID, search: isEdit ? { mode: "edit" } : {} }, context).model,
		(model, message) => boardStep(model, message).model,
	)

const Model = Schema.Struct({
	page: Schema.Literals(PAGES),
	role: Schema.Literals(ROLES),
	/** The board was opened at `?mode=edit`: an observer still gets the read view. */
	isEdit: Schema.Boolean,
	list: ListModel,
	board: BoardModel,
})
type Model = typeof Model.Type

const Message = defineMessageUnion({
	ClickedPage: { page: Schema.Literals(PAGES) },
	ClickedRole: { role: Schema.Literals(ROLES) },
	/** The list's row menus open here; its other messages would write, so they are dropped. */
	GotRowMenuMessage: { rowId: Schema.String, message: Menu.Message },
	Ignored: {},
	GotBoardMessage: { message: BoardMessage },
})
type Message = typeof Message.Type

const Flags = Schema.Struct({
	page: Schema.Literals(PAGES),
	role: Schema.Literals(ROLES),
	isEdit: Schema.Boolean,
})
type Flags = typeof Flags.Type

const decodePage = Schema.decodeUnknownOption(Schema.Literals(PAGES))
const decodeRole = Schema.decodeUnknownOption(Schema.Literals(ROLES))

const build = (page: LabPage, role: LabRole, isEdit: boolean): Model => ({
	page,
	role,
	isEdit,
	list: listModel(role),
	board: boardModel(role, isEdit),
})

const toListMessage = (message: ListMessage): Message =>
	message._tag === "GotRowMenuMessage"
		? Message.GotRowMenuMessage({ rowId: message.rowId, message: message.message })
		: Message.Ignored()

const update = (model: Model, message: Message) =>
	Message.match(message, {
		ClickedPage: ({ page }) => ({ model: { ...model, page }, commands: [] }),
		ClickedRole: ({ role }) => ({ model: build(model.page, role, model.isEdit), commands: [] }),
		GotRowMenuMessage: (rowMenu) => {
			const next = listUpdate(model.list, ListMessage.GotRowMenuMessage(rowMenu), context)
			return {
				model: { ...model, list: next.model },
				commands: Command.mapMessages(
					Arr.filter(next.commands ?? [], (command) => !REMOTE.test(command.name)),
					toListMessage,
				),
			}
		},
		Ignored: () => ({ model, commands: [] }),
		GotBoardMessage: ({ message: inner }) => {
			const next = boardStep(model.board, inner)
			return {
				model: { ...model, board: next.model },
				commands: Command.mapMessages(next.commands, (boardMessage) =>
					Message.GotBoardMessage({ message: boardMessage }),
				),
			}
		},
	})

const view = (model: Model, h: HtmlBuilder<Message>): Html =>
	model.page === "list"
		? h.submodel({
				slotId: "dashboards-lab-list",
				model: model.list,
				view: listView,
				viewInputs: { context },
				toParentMessage: toListMessage,
			})
		: h.submodel({
				slotId: "dashboards-lab-board",
				model: model.board,
				view: boardView,
				viewInputs: { context },
				toParentMessage: (message) => Message.GotBoardMessage({ message }),
			})

/** The page and role switcher, fixed at the bottom like the other shell labs'. */
const switcher = (model: Model, h: HtmlBuilder<Message>): Html =>
	h.div(
		[
			h.Class(
				"bg-background fixed bottom-3 left-1/2 z-50 flex -translate-x-1/2 gap-1 rounded-lg border p-1",
			),
		],
		[
			...Arr.map(PAGES, (page) =>
				button(
					h,
					{
						size: "xs",
						variant: model.page === page ? "secondary" : "ghost",
						attributes: [h.OnClick(Message.ClickedPage({ page }))],
					},
					[page],
				),
			),
			...Arr.map(ROLES, (role) =>
				button(
					h,
					{
						size: "xs",
						variant: model.role === role ? "secondary" : "ghost",
						attributes: [h.OnClick(Message.ClickedRole({ role }))],
					},
					[role],
				),
			),
		],
	)

export const lab = defineShellLab("Dashboards", {
	Model,
	Message,
	Flags,
	flags: Effect.sync(() => {
		const params = new URLSearchParams(window.location.search)
		return {
			page: Option.getOrElse(decodePage(params.get("page")), (): LabPage => "list"),
			role: Option.getOrElse(decodeRole(params.get("role")), (): LabRole => "member"),
			isEdit: params.get("mode") === "edit",
		}
	}),
	init: (flags: Flags) => ({ model: build(flags.page, flags.role, flags.isEdit) }),
	update,
	view,
	before: switcher,
	currentPath: "/dashboards",
	breadcrumbs: (model) =>
		model.page === "list"
			? [{ label: "Dashboards", isPageHeading: true }]
			: [{ label: "Dashboards" }, { label: BOARD.name }],
})
