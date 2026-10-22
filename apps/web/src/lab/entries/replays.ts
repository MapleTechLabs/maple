import { SessionTag } from "@maple/domain/query-engine"
import { cn } from "@maple/ui/lib/utils"
import {
	pageContentStyles,
	pageLayoutStyles,
	pageScrollAreaStyles,
	pageStickyAreaStyles,
} from "@maple/ui/styles/ui/page-layout"
import { Clock, Effect, Schema, Stream } from "effect"
import { Mount } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { defineMessageUnion } from "foldkit/message"
import { replaysToolbar } from "../../page/replays/kit/replays-toolbar"
import { sessionListItems, type SessionRow } from "../../page/replays/kit/session-row"
import { sessionsList } from "../../page/replays/kit/sessions-list"
import { emptyWindow, VirtualWindow, virtualizeSessions } from "../../page/replays/kit/virtualize"
import { viewerFlags } from "../../ui/logs/viewer"
import { defineLabWithFlags } from "../define"
import { foldLabToasts, initLabToasts, labRoot } from "../toasts"
import * as Toast from "../../ui/toast"
import { labSessions } from "../replays/fixture"

// `/lab/replays`: the `/replays` list over a day of mostly
// bots, bounces and idle tabs, without a warehouse behind it.

const WIDTHS = [
	{ label: "Full", value: null },
	{ label: "1000px", value: 1000 },
	{ label: "700px", value: 700 },
	{ label: "380px", value: 380 },
] as const

const Model = Schema.Struct({
	nowMs: Schema.Number,
	timeZone: Schema.String,
	width: Schema.NullOr(Schema.Number),
	isErrorsOnly: Schema.Boolean,
	isEngagedOnly: Schema.Boolean,
	tag: Schema.NullOr(SessionTag),
	group: Schema.NullOr(Schema.String),
	expanded: Schema.Array(Schema.String),
	/** `ToolbarSearch`'s own input state; the lab's `onSearch` does nothing with it. */
	query: Schema.String,
	virtualWindow: VirtualWindow,
	toasts: Toast.Model,
})
type Model = typeof Model.Type

const Message = defineMessageUnion({
	ClickedWidth: { width: Schema.NullOr(Schema.Number) },
	ClickedClear: {},
	ToggledErrorsOnly: {},
	ToggledEngagedOnly: {},
	ClickedTag: { tag: SessionTag },
	ClickedGroup: { group: Schema.String },
	ToggledRun: { key: Schema.String },
	ClickedSession: { sessionId: Schema.String },
	ChangedSearch: { value: Schema.String },
	GotToastMessage: { message: Toast.Message },
	ChangedVirtualWindow: { window: VirtualWindow },
})
type Message = typeof Message.Type

const foldToasts = foldLabToasts<Model, Message>((message) => Message.GotToastMessage({ message }))

const update = (model: Model, message: Message) =>
	message._tag === "GotToastMessage"
		? foldToasts(model, message.message)
		: { model: updateState(model, message), commands: [] }

const updateState = (model: Model, message: Message): Model =>
	Message.match<Model>(message, {
		ClickedWidth: ({ width }) => ({ ...model, width }),
		ClickedClear: () => ({ ...model, tag: null, group: null }),
		ToggledErrorsOnly: () => ({ ...model, isErrorsOnly: !model.isErrorsOnly }),
		ToggledEngagedOnly: () => ({ ...model, isEngagedOnly: !model.isEngagedOnly }),
		ClickedTag: ({ tag }) => ({ ...model, tag }),
		ClickedGroup: ({ group }) => ({ ...model, group }),
		ToggledRun: ({ key }) => ({
			...model,
			expanded: model.expanded.includes(key)
				? model.expanded.filter((other) => other !== key)
				: [...model.expanded, key],
		}),
		// TODO(lab-navigation): navigate to `/replays/$sessionId`; the lab has no router.
		ClickedSession: () => model,
		ChangedSearch: ({ value }) => ({ ...model, query: value }),
		GotToastMessage: () => model,
		ChangedVirtualWindow: ({ window }) => ({ ...model, virtualWindow: window }),
	})

const visibleRows = (model: Model, rows: ReadonlyArray<SessionRow>) =>
	rows.filter(
		(row) =>
			(!model.isErrorsOnly || row.errorCount > 0) &&
			(!model.isEngagedOnly || row.tags.includes("engaged")) &&
			(model.tag === null || row.tags.includes(model.tag)) &&
			(model.group === null || row.groupName === model.group),
	)

const widthButton = (h: HtmlBuilder<Message>, model: Model, option: (typeof WIDTHS)[number]): Html =>
	h.button(
		[
			h.Type("button"),
			h.OnClick(Message.ClickedWidth({ width: option.value })),
			h.Class(
				model.width === option.value
					? "rounded border border-border bg-accent px-2 py-1 text-xs"
					: "rounded border border-border px-2 py-1 text-xs text-muted-foreground",
			),
		],
		[option.label],
	)

const clearLabel = (model: Model) => [model.tag, model.group].filter((value) => value !== null).join(" + ")

const page = (model: Model, h: HtmlBuilder<Message>): Html => {
	const rows = labSessions(model.nowMs)
	const visible = visibleRows(model, rows)
	return h.div(
		[h.Class("flex h-svh flex-col gap-4 p-6")],
		[
			h.div(
				[h.Class("flex items-center gap-2")],
				[
					...(model.tag !== null || model.group !== null
						? [
								h.button(
									[
										h.Type("button"),
										h.OnClick(Message.ClickedClear()),
										h.Class("rounded border border-border px-2 py-1 text-xs"),
									],
									["Clear ", clearLabel(model)],
								),
							]
						: []),
					...WIDTHS.map((option) => widthButton(h, model, option)),
				],
			),
			h.div(
				[
					h.Class("flex min-h-0 flex-1 flex-col"),
					...(model.width === null ? [] : [h.Style({ width: `${model.width}px` })]),
				],
				[
					h.div(
						[h.DataAttribute("slot", "page-layout"), h.Class(pageLayoutStyles)],
						[
							h.main(
								[
									h.Id("main-content"),
									h.DataAttribute("slot", "page-content"),
									h.Class(pageContentStyles),
								],
								[
									h.div(
										[
											h.DataAttribute("slot", "page-sticky-area"),
											h.Class(cn(pageStickyAreaStyles, "pb-3")),
										],
										[
											replaysToolbar(h, {
												query: model.query,
												onInput: (value) => Message.ChangedSearch({ value }),
												onClear: Message.ChangedSearch({ value: "" }),
												errorSessions: rows.filter((row) => row.errorCount > 0)
													.length,
												isErrorsOnly: model.isErrorsOnly,
												onToggleErrorsOnly: Message.ToggledErrorsOnly(),
												engagedSessions: rows.filter((row) =>
													row.tags.includes("engaged"),
												).length,
												isEngagedOnly: model.isEngagedOnly,
												onToggleEngagedOnly: Message.ToggledEngagedOnly(),
											}),
										],
									),
									h.div(
										[
											h.DataAttribute("slot", "page-scroll-area"),
											h.Class(cn(pageScrollAreaStyles, "pt-0")),
										],
										[
											sessionsList(
												h,
												{
													items: sessionListItems(visible, {
														collapse: !model.isEngagedOnly && model.tag === null,
														expanded: model.expanded,
														nowMs: model.nowMs,
													}),
													nowMs: model.nowMs,
													timeZone: model.timeZone,
													durationP95: 1_200_000,
													onOpen: (session) =>
														Message.ClickedSession({
															sessionId: session.sessionId,
														}),
													onToggleRun: (key) => Message.ToggledRun({ key }),
													onFilterTag: (tag) => Message.ClickedTag({ tag }),
													onFilterGroup: (group) => Message.ClickedGroup({ group }),
												},
												{
													window: model.virtualWindow,
													mount: h.OnMount(VirtualizeList()),
												},
											),
										],
									),
								],
							),
						],
					),
				],
			),
		],
	)
}

const VirtualizeList = Mount.defineStream("VirtualizeLabReplaysList", {
	messages: [Message.ChangedVirtualWindow],
	execute: ({ element }) =>
		element instanceof HTMLElement
			? virtualizeSessions(element, (window) => Message.ChangedVirtualWindow({ window }))
			: Stream.never,
})

const view = (model: Model, h: HtmlBuilder<Message>): Html =>
	labRoot(h, model.toasts, (message) => Message.GotToastMessage({ message }), page(model, h))

const Flags = Schema.Struct({ nowMs: Schema.Number, timeZone: Schema.String })

export const lab = defineLabWithFlags("Session replays list", {
	Model,
	Flags,
	flags: Effect.all({
		nowMs: Clock.currentTimeMillis,
		timeZone: Effect.map(viewerFlags, (flags) => flags.timeZone),
	}),
	init: ({ nowMs, timeZone }) => ({
		model: {
			nowMs,
			timeZone,
			width: null,
			isErrorsOnly: false,
			isEngagedOnly: false,
			tag: null,
			group: null,
			expanded: [],
			query: "",
			virtualWindow: emptyWindow,
			toasts: initLabToasts(),
		},
	}),
	update,
	view,
})
