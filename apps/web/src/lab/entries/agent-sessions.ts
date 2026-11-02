import { OrgId } from "@maple/domain"
import { Clock, Effect, Option, Schema } from "effect"
import { Command, Submodel } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { defineMessageUnion } from "foldkit/message"
import {
	pageContentStyles,
	pageScrollAreaStyles,
	pageStickyAreaStyles,
} from "@maple/ui/styles/ui/page-layout"
import { cn } from "@maple/ui/lib/utils"
import type { PageContext } from "../../page/contract"
import { detectLookup, missingDetection } from "../../page/agent-sessions/kit/detected-models"
import { agentSessionsTabs } from "../../page/agent-sessions/kit/tabs"
import { CompleteReloadSpin, DetectModels, VirtualizeSessions } from "../../page/agent-sessions/list/command"
import { type DisplayRow, sortOf, sortPatch } from "../../page/agent-sessions/list/derive"
import { Message as ListMessage } from "../../page/agent-sessions/list/message"
import { Model as ListModel } from "../../page/agent-sessions/list/model"
import { init as listInit } from "../../page/agent-sessions/list/update"
import { sessionsTable } from "../../page/agent-sessions/list/view-table"
import { toolbar } from "../../page/agent-sessions/list/view-toolbar"
import type { Resources } from "../../platform/resources"
import * as Toast from "../../ui/toast"
import { ViewerFlags, viewerFlags } from "../../ui/logs/viewer"
import { buildToolAnalyticsFixture, buildToolCells } from "../agent-tools-fixture"
import { defineLabWithFlags } from "../define"
import { foldLabToasts, initLabToasts, labRoot } from "../toasts"
import { buildRows } from "../agent-sessions-rows"

// `/lab/agent-sessions`: the list's tab strip, toolbar
// and table over rows chosen to break its lanes. No server: a header click only marks the order.

const WIDTHS = [
	{ label: "Full", value: null },
	{ label: "1300px", value: 1300 },
	{ label: "1000px", value: 1000 },
	{ label: "700px", value: 700 },
	{ label: "380px", value: 380 },
] as const

const Model = Schema.Struct({
	list: ListModel,
	width: Schema.NullOr(Schema.Number),
	timeZone: Schema.String,
	tabCounts: Schema.Struct({ sessions: Schema.Number, tools: Schema.Number }),
	toasts: Toast.Model,
})
type Model = typeof Model.Type

const Message = defineMessageUnion({
	GotListMessage: { message: ListMessage },
	ClickedWidth: { width: Schema.NullOr(Schema.Number) },
	GotToastMessage: { message: Toast.Message },
})
type Message = typeof Message.Type

type Return = Readonly<{ model: Model; commands?: ReadonlyArray<Command.Command<Message, never, Resources>> }>

const contextOf = (timeZone: string): PageContext => ({
	orgId: Schema.decodeSync(OrgId)("org_lab"),
	pinnedNamespace: null,
	timeZone,
})

const toLab = (message: ListMessage) => Message.GotListMessage({ message })

const rowsOf = (model: Model): ReadonlyArray<DisplayRow> =>
	buildRows(model.list.nowMs).map((row) => ({ ...row, hasDetails: false }))

/** The rows' model marks, as the page asks for them. */
const detect = (model: Model): Return =>
	Option.match(
		missingDetection(
			model.list.detections,
			rowsOf(model).flatMap((row) => row.models),
		),
		{
			onNone: () => ({ model }),
			onSome: (key) => ({
				model: {
					...model,
					list: { ...model.list, detections: { ...model.list.detections, [key]: null } },
				},
				commands: Command.mapMessages([DetectModels({ key })], toLab),
			}),
		},
	)

/** The list's controls over local state: the toolbar's search and switch, the sort, Reload's spin. */
const stepList = (model: Model, message: ListMessage): Return => {
	const { list } = model
	const set = (next: ListModel): Return => ({ model: { ...model, list: next } })
	switch (message._tag) {
		case "ChangedSearchInput":
			return set({ ...list, searchInput: message.value })
		case "ToggledErrorsOnly":
			return set({
				...list,
				search: { ...list.search, hasErrors: list.search.hasErrors === true ? undefined : true },
			})
		case "ClickedSort":
			return set({ ...list, search: { ...list.search, ...sortPatch(list.search, message.key) } })
		case "ClickedReload": {
			const version = list.refreshVersion + 1
			return {
				model: { ...model, list: { ...list, refreshVersion: version, isReloading: true } },
				commands: Command.mapMessages([CompleteReloadSpin({ version })], toLab),
			}
		}
		case "CompletedReloadSpin":
			return message.version === list.refreshVersion ? set({ ...list, isReloading: false }) : { model }
		case "CompletedDetectModels":
			return set({ ...list, detections: { ...list.detections, [message.key]: message.models } })
		case "ChangedListWindow":
			return set({ ...list, listWindow: message.window })
		default:
			return { model }
	}
}

const Flags = Schema.Struct({ ...ViewerFlags.fields, nowMs: Schema.Number })
type Flags = typeof Flags.Type

const foldToasts = foldLabToasts<Model, Message>((message) => Message.GotToastMessage({ message }))

const init = (flags: Flags): Return => {
	const list = listInit({ search: {} }, contextOf(flags.timeZone)).model
	const all = buildToolAnalyticsFixture({}, flags.nowMs, buildToolCells(flags.nowMs))
	return detect({
		list: { ...list, nowMs: flags.nowMs },
		width: null,
		timeZone: flags.timeZone,
		tabCounts: { sessions: all.allSessions, tools: all.tools.length },
		toasts: initLabToasts(),
	})
}

const update = (model: Model, message: Message): Return =>
	Message.match<Return>(message, {
		GotListMessage: ({ message: inner }) => stepList(model, inner),
		ClickedWidth: ({ width }) => ({ model: { ...model, width } }),
		GotToastMessage: ({ message: inner }) => foldToasts(model, inner),
	})

type ListInputs = Readonly<{
	timeZone: string
	tabCounts: Model["tabCounts"]
	rows: ReadonlyArray<DisplayRow>
}>

/** The route's own layout: the tabs and toolbar pinned, the table in the scroll area. */
const listPage = Submodel.defineView<ListModel, ListMessage, ListInputs>((list, inputs, h) =>
	h.div(
		[h.Class("flex min-h-0 flex-1 flex-col"), h.DataAttribute("slot", "page-layout")],
		[
			h.main(
				[h.Id("main-content"), h.DataAttribute("slot", "page-content"), h.Class(pageContentStyles)],
				[
					h.div(
						[
							h.DataAttribute("slot", "page-sticky-area"),
							h.Class(cn(pageStickyAreaStyles, "pb-3")),
						],
						[
							h.div(
								[h.Class("space-y-3")],
								[
									agentSessionsTabs(h, {
										active: "sessions",
										counts: inputs.tabCounts,
										isOnRoute: false,
									}),
									toolbar(h, list, {
										sessionCount: inputs.rows.length,
										totalCount: inputs.tabCounts.sessions,
										isWaiting: false,
									}),
								],
							),
						],
					),
					h.div(
						[
							h.DataAttribute("slot", "page-scroll-area"),
							h.Class(cn(pageScrollAreaStyles, "pt-0")),
						],
						[
							sessionsTable(h, {
								rows: inputs.rows,
								sort: sortOf(list.search),
								context: {
									nowMs: list.nowMs,
									timeZone: inputs.timeZone,
									detect: detectLookup(list.detections),
								},
								hasMore: false,
								isLoadingMore: false,
								isCapped: false,
								virtual: { window: list.listWindow, mount: h.OnMount(VirtualizeSessions()) },
							}),
						],
					),
				],
			),
		],
	),
)

const labButton = (h: HtmlBuilder<Message>, label: string, isActive: boolean, onClick: Message): Html =>
	h.button(
		[
			h.Class(
				isActive
					? "rounded-sm border border-border bg-accent px-2 py-1 text-xs"
					: "rounded-sm border border-border px-2 py-1 text-xs text-muted-foreground",
			),
			h.Type("button"),
			h.OnClick(onClick),
		],
		[label],
	)

const page = (model: Model, h: HtmlBuilder<Message>): Html =>
	h.div(
		[h.Class("flex h-svh flex-col gap-4 p-6")],
		[
			h.div(
				[h.Class("flex items-center gap-2")],
				WIDTHS.map((option) =>
					labButton(
						h,
						option.label,
						model.width === option.value,
						Message.ClickedWidth({ width: option.value }),
					),
				),
			),
			h.div(
				[
					h.Class("flex min-h-0 flex-1 flex-col"),
					...(model.width === null ? [] : [h.Style({ width: `${model.width}px` })]),
				],
				[
					h.submodel({
						slotId: "lab-agent-sessions-list",
						model: model.list,
						view: listPage,
						viewInputs: {
							timeZone: model.timeZone,
							tabCounts: model.tabCounts,
							rows: rowsOf(model),
						},
						toParentMessage: toLab,
					}),
				],
			),
		],
	)

const view = (model: Model, h: HtmlBuilder<Message>): Html =>
	labRoot(h, model.toasts, (message) => Message.GotToastMessage({ message }), page(model, h))

export const lab = defineLabWithFlags("Agent sessions list", {
	Model,
	Flags,
	flags: Effect.map(Effect.all([viewerFlags, Clock.currentTimeMillis]), ([viewer, nowMs]) => ({
		...viewer,
		nowMs,
	})),
	init,
	update,
	view,
})
