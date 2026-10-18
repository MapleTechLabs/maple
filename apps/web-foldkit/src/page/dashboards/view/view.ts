import { TONE_TEXT } from "@maple/ui/lib/tone"
import { cn } from "@maple/ui/lib/utils"
import { Option } from "effect"
import { Submodel } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { WIDGET_CHART_TOKENS } from "../kit/chart-tokens"
import { ResolveThemeColors } from "../../../charts/theme-colors"
import { AppRoute, hrefOf } from "../../../route"
import { alert, alertDescription } from "../../../ui/alert"
import { button, linkButton } from "../../../ui/button"
import { chartSkeleton } from "../../../ui/chart-skeleton"
import { empty, emptyContent, emptyDescription, emptyHeader, emptyMedia, emptyTitle } from "../../../ui/empty"
import { icon } from "../../../ui/icon"
import { inlineCode } from "../../../ui/inline-code"
import { skeleton } from "../../../ui/skeleton"
import type { PageViewInputs } from "../../contract"
import { dashboardPage } from "../../kit/dashboard-page"
import { docsLink } from "../../kit/signal-empty-state"
import { Message } from "./message"
import type { Model } from "./model"
import { isEditing } from "./update"
import { dashboardSections } from "./view-grid"
import * as TagEditor from "../kit/tag-editor"
import { widgetPicker } from "./picker"
import { toolbar } from "./view-toolbar"
import { sectionDialogs } from "./view-sections"

// `DashboardViewPage` (apps/web/src/routes/dashboards/$dashboardId.tsx).

type H = HtmlBuilder<Message>

/** `InlineEditableTitle`: the heading, or its input while renaming. */
const title = (h: H, model: Model, name: string): Html => {
	const isReadOnly = model.persistenceError !== null
	if (model.titleDraft !== null && !isReadOnly)
		return h.form(
			[h.OnSubmit(Message.SubmittedTitle())],
			[
				h.input([
					h.Value(model.titleDraft),
					h.OnInput((value) => Message.ChangedTitleDraft({ value })),
					h.OnBlur(Message.SubmittedTitle()),
					h.OnKeyDownPreventDefault((key) =>
						key === "Escape" ? Option.some(Message.CancelledTitle()) : Option.none(),
					),
					h.Autofocus(true),
					h.Class(
						"font-display text-2xl font-semibold tracking-tight leading-[1.1] bg-transparent border-b border-foreground/20 outline-none focus:border-foreground/50 w-full",
					),
				]),
			],
		)
	const isBlank = name.trim() === ""
	return h.h1(
		[
			h.Role("button"),
			h.Tabindex(0),
			h.OnClick(Message.ClickedTitle()),
			h.OnKeyDownPreventDefault((key) =>
				key === "Enter" || key === " " ? Option.some(Message.ClickedTitle()) : Option.none(),
			),
			h.AriaDisabled(isReadOnly),
			h.Class(
				cn(
					"font-display text-2xl font-semibold tracking-tight truncate leading-[1.1]",
					!isReadOnly && "cursor-pointer hover:text-foreground/80",
					isBlank && "text-muted-foreground",
				),
			),
		],
		[isBlank ? "Untitled dashboard" : name],
	)
}

/** `DashboardViewSkeleton`. TODO(skeleton): ghost tiles use the line ghost for every variant. */
const viewSkeleton = (h: H): Html => {
	const ghost = (index: number, className: string) =>
		h.div(
			[
				h.Class(
					`flex flex-col overflow-hidden rounded-md ring-1 ring-border bg-card animate-tile-in motion-reduce:animate-none ${className}`,
				),
				h.Style({ "animation-delay": `${index * 40}ms` }),
			],
			[
				h.div([h.Class("flex items-center px-3 pt-3 pb-2")], [skeleton(h, "h-3 w-24")]),
				h.div([h.Class("min-h-0 flex-1 p-2 pt-0")], [chartSkeleton(h, "line")]),
			],
		)
	return h.div(
		[h.Role("status"), h.AriaLabel("Loading dashboard")],
		[
			h.span([h.Class("sr-only")], ["Loading dashboard"]),
			h.div(
				[h.Class("flex flex-col gap-4"), h.AriaHidden(true)],
				[
					h.div(
						[h.Class("grid grid-cols-2 gap-4 lg:grid-cols-4")],
						[0, 1, 2, 3].map((index) => ghost(index, "h-28")),
					),
					h.div(
						[h.Class("grid grid-cols-1 gap-4 lg:grid-cols-2")],
						[ghost(4, "h-64"), ghost(5, "h-64")],
					),
					ghost(6, "h-64"),
				],
			),
		],
	)
}

/** `ResourceNotFound`: the id resolved to nothing. */
const notFound = (h: H, dashboardId: string): Html =>
	empty(
		h,
		[
			emptyHeader(h, [
				emptyMedia(h, { variant: "icon" }, [icon(h, "CircleWarningIcon", { size: 18 })]),
				emptyTitle(h, ["Dashboard not found"]),
				emptyDescription(h, [
					"No dashboard with id ",
					inlineCode(h, { className: "break-all px-1.5 py-0.5" }, [dashboardId]),
				]),
			]),
			linkButton(
				h,
				{ variant: "outline", size: "sm", href: hrefOf(AppRoute.Dashboards({ search: {} })) },
				["Back to all dashboards"],
			),
		],
		cn("md:py-12", "py-24"),
	)

const GRID_PREVIEW = [
	{ glyph: "ChartBarTrendUpIcon", className: "h-16 grow" },
	{ glyph: "ChartBarIcon", className: "h-16 w-16" },
	{ glyph: "TextWrapIcon", className: "h-16 w-10" },
] as const

/** `BlankDashboardEmpty`: the board exists and holds nothing. */
const blankDashboard = (h: H, isReadOnly: boolean): Html =>
	empty(
		h,
		[
			emptyMedia(h, {}, [
				h.div(
					[h.AriaHidden(true), h.Class("flex w-64 gap-2")],
					GRID_PREVIEW.map(({ glyph, className }) =>
						h.div(
							[
								h.Class(
									`${className} flex items-center justify-center rounded-md border border-dashed border-border bg-card/40`,
								),
							],
							[icon(h, glyph, { size: 16, className: "text-muted-foreground/50" })],
						),
					),
				),
			]),
			emptyHeader(h, [
				emptyTitle(h, ["Nothing on this board yet"]),
				emptyDescription(h, [
					"Widgets read from the traces, logs, metrics and errors you already send: charts, single stats, tables and markdown notes.",
				]),
			]),
			emptyContent(
				h,
				[
					h.div(
						[h.Class("flex flex-wrap items-center justify-center gap-2")],
						[
							button(
								h,
								{
									size: "sm",
									isDisabled: isReadOnly,
									attributes: [h.OnClick(Message.ClickedAddWidget())],
								},
								[icon(h, "PlusIcon"), "Add your first widget"],
							),
							linkButton(
								h,
								{
									size: "sm",
									variant: "outline",
									href: hrefOf(AppRoute.DashboardsTemplates({ search: {} })),
								},
								["Start from a template"],
							),
							docsLink(h, "dashboards"),
						],
					),
					h.p(
						[h.Class("text-muted-foreground font-mono text-2xs")],
						[
							isReadOnly
								? "Read-only. You can’t add widgets to this dashboard."
								: "Templates create a new dashboard from this org’s data.",
						],
					),
				],
				"max-w-none",
			),
		],
		"py-16",
	)

const persistenceBanner = (h: H, error: string): Html =>
	alert(h, { variant: "crit", size: "sm", className: "mb-4" }, [
		alertDescription(h, [error, ". Dashboard editing is temporarily disabled."], TONE_TEXT.crit),
	])

const body = (h: H, model: Model, timeZone: string): ReadonlyArray<Html> => {
	if (model.status === "Loading") return [viewSkeleton(h)]
	if (model.status === "Missing" || model.document === null) return [notFound(h, model.dashboardId)]
	const document = model.document
	const isBlank = document.widgets.length === 0 && (document.sections?.length ?? 0) === 0
	return [
		...(model.persistenceError === null ? [] : [persistenceBanner(h, model.persistenceError)]),
		isBlank
			? blankDashboard(h, model.persistenceError !== null)
			: dashboardSections(h, { model, timeZone }, document),
	]
}

export const view = Submodel.defineView<Model, Message, PageViewInputs>((model, inputs, h) =>
	h.div(
		[h.Class("contents"), h.OnMount(ResolveThemeColors({ tokens: WIDGET_CHART_TOKENS }))],
		[
			dashboardPage(
				h,
				model.document === null
					? {}
					: {
							titleContent: title(h, model, model.document.name),
							actions: toolbar(h, model, inputs.context.timeZone),
						},
				body(h, model, inputs.context.timeZone),
			),
			widgetPicker(h, model),
			h.submodel({
				slotId: "dashboard-view-tag-editor",
				model: model.tagEditor,
				view: TagEditor.view,
				viewInputs: { allTags: model.orgTags },
				toParentMessage: (message) => Message.GotTagEditorMessage({ message }),
			}),
			...sectionDialogs(h, model),
		],
	),
)

export { isEditing }
