import type { DashboardDocument } from "@maple/domain/http"
import type { V2DashboardTemplate } from "@maple/domain/http/v2"
import type { VariableValues } from "@maple/query-engine"
import { cn } from "@maple/ui/lib/utils"
import { fieldDescriptionStyles, fieldLabelStyles, fieldStyles } from "@maple/ui/styles/ui/field"
import { skeletonStyles } from "@maple/ui/styles/ui/skeleton"
import { CANONICAL_COLS, colsForWidth } from "../../../components/dashboard-builder/canvas/grid-breakpoints"
import { AsyncData } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import * as Chart from "../../../charts/chart"
import { button, linkButton } from "../../../ui/button"
import { empty, emptyDescription, emptyHeader, emptyMedia, emptyTitle } from "../../../ui/empty"
import { eyebrow } from "../../../ui/eyebrow"
import { icon } from "../../../ui/icon"
import { input } from "../../../ui/input"
import { dataStateOf } from "../kit/data-state"
import { widgetTile } from "../kit/tiles"
import { MeasurePreview } from "./command"
import { previewVariableValues } from "./derive"
import {
	CATEGORY_LABELS,
	compositionLabel,
	READINESS_WINDOW_LABEL,
	relativeAge,
	setupHref,
	type TemplateReadiness,
	templateIcon,
	widgetCountLabel,
} from "./derive"
import { Message } from "./message"
import type { Model } from "./model"
import { MAX_PREVIEW_WIDGETS } from "./update"

// `TemplateDetailPanel` and `TemplateLivePreview`: a template's details and live preview.

type H = HtmlBuilder<Message>

/** `PanelRestState`: nothing selected yet. */
export const panelRestState = (h: H): Html =>
	empty(
		h,
		[
			emptyHeader(h, [
				emptyMedia(h, { variant: "icon" }, [icon(h, "GridSquareCirclePlusIcon", { size: 18 })]),
				emptyTitle(h, ["Pick a template"]),
				emptyDescription(h, [
					"You'll see every widget it builds, whether your data can fill them, and anything you need to name first.",
				]),
			]),
		],
		"h-full",
	)

const ROW_HEIGHT = 32
const CARD_CHROME = 58
const MIN_HEIGHT = new Map([
	["stat", CARD_CHROME + 80],
	["gauge", CARD_CHROME + 108],
	["markdown", CARD_CHROME + 28],
])
const MIN_HEIGHT_DEFAULT = CARD_CHROME + 128 + 94

type PreviewWidget = DashboardDocument["widgets"][number]

const heightFor = (widget: PreviewWidget): number =>
	Math.max(widget.layout.h * ROW_HEIGHT, MIN_HEIGHT.get(widget.visualization) ?? MIN_HEIGHT_DEFAULT)

/** `PreviewSkeleton`: a row of stats over a pair of charts at their real heights. */
const previewSkeleton = (h: H): Html => {
	const statHeight = `${MIN_HEIGHT.get("stat") ?? 0}px`
	return h.div(
		[h.Class("grid gap-2"), h.Style({ "grid-template-columns": `repeat(${CANONICAL_COLS}, 1fr)` })],
		[
			...[0, 1, 2].map(() =>
				h.div([
					h.Class(cn(skeletonStyles, "col-span-4 rounded-md")),
					h.DataAttribute("slot", "skeleton"),
					h.Style({ height: statHeight }),
				]),
			),
			...[0, 1].map(() =>
				h.div([
					h.Class(cn(skeletonStyles, "col-span-6 rounded-md")),
					h.DataAttribute("slot", "skeleton"),
					h.Style({ height: `${MIN_HEIGHT_DEFAULT}px` }),
				]),
			),
		],
	)
}

/** `TemplateLivePreview`: the template's widgets drawn over the org's own data. */
const livePreview = (h: H, model: Model, timeZone: string): Html =>
	AsyncData.match(model.preview.data, {
		onIdle: () => previewSkeleton(h),
		onLoading: () => previewSkeleton(h),
		onFailure: () =>
			h.div(
				[
					h.Class(
						"text-muted-foreground flex items-center gap-2 rounded-md border border-border border-dashed p-4 text-xs",
					),
				],
				[
					icon(h, "CircleWarningIcon", { size: 14 }),
					"Couldn't build the preview. You can still create the dashboard.",
				],
			),
		onStale: ({ data }) => previewBody(h, model, timeZone, previewVariableValues(data.variables)),
		onRefreshing: (data) => previewBody(h, model, timeZone, previewVariableValues(data.variables)),
		onSuccess: (data) => previewBody(h, model, timeZone, previewVariableValues(data.variables)),
	})

const previewBody = (h: H, model: Model, timeZone: string, variables: VariableValues): Html => {
	const preview = { widgets: model.previewWidgets }
	if (preview.widgets.length === 0)
		return h.p(
			[h.Class("text-muted-foreground text-xs")],
			["This template starts you with an empty dashboard."],
		)
	const shown = preview.widgets.slice(0, MAX_PREVIEW_WIDGETS)
	const hidden = preview.widgets.length - shown.length
	const cols = model.previewWidth > 0 ? colsForWidth(model.previewWidth) : CANONICAL_COLS
	return h.div(
		[h.Class("flex flex-col gap-2")],
		[
			h.div(
				[
					h.Class("grid gap-2"),
					h.Style({ "grid-template-columns": `repeat(${cols}, 1fr)` }),
					h.OnMount(MeasurePreview()),
				],
				shown.map((widget) =>
					h.keyed("div")(
						widget.id,
						[
							h.Class("min-w-0"),
							h.Style({
								"grid-column": `span ${Math.min(widget.layout.w, cols)}`,
								height: `${heightFor(widget)}px`,
							}),
						],
						[
							widgetTile(
								h,
								{
									h,
									state: dataStateOf(
										model.requests,
										widget,
										model.gates[widget.id] ?? null,
									),
									isEdit: false,
									menu: null,
									isMenuOpen: false,
									hasGrip: false,
									configure: null,
									chart: model.charts[widget.id] ?? Chart.init(),
									themeColors: model.themeColors,
									chartRuntime: model.chartRuntime,
									nowMs: model.nowMs,
									timeZone,
									tableSort: model.tableSorts[widget.id] ?? { key: null, dir: "desc" },
									variables,
									onChart: (message) =>
										Message.GotChartMessage({ widgetId: widget.id, message }),
									onSort: (field, isText) =>
										Message.ClickedSortColumn({ widgetId: widget.id, field, isText }),
								},
								widget,
							),
						],
					),
				),
			),
			...(hidden > 0
				? [
						h.p(
							[h.Class("text-muted-foreground text-xs")],
							[`${hidden} more ${hidden === 1 ? "widget" : "widgets"} below the fold.`],
						),
					]
				: []),
		],
	)
}

/** `RequirementBlock`: what the org needs before the widgets fill in. */
const requirementBlock = (
	h: H,
	template: V2DashboardTemplate,
	readiness: TemplateReadiness | undefined,
	nowMs: number,
): ReadonlyArray<Html> => {
	const requirement = template.requirement
	if (requirement === null) return []
	const isReady = readiness?.ready !== false
	const age = relativeAge(readiness?.lastSeen ?? null, nowMs)
	return [
		h.div(
			[h.Class("flex flex-col gap-2.5")],
			[
				eyebrow(h, { variant: "label" }, ["What it needs"]),
				h.div(
					[h.Class("flex items-start gap-2.5")],
					[
						isReady
							? h.span(
									[
										h.Class(
											"bg-severity-info flex size-4 shrink-0 items-center justify-center rounded-[3px]",
										),
									],
									[icon(h, "CheckIcon", { size: 10, className: "text-background" })],
								)
							: h.span(
									[h.Class("border-input size-4 shrink-0 rounded-full border-[1.5px]")],
									[],
								),
						h.div(
							[h.Class("flex min-w-0 grow flex-col gap-1")],
							[
								h.div(
									[h.Class("flex flex-wrap items-baseline gap-2.5")],
									[
										...(readiness?.prefixLabel === null ||
										readiness?.prefixLabel === undefined
											? []
											: [
													h.span(
														[
															h.Class(
																cn(
																	"font-mono text-sm",
																	isReady
																		? "text-foreground"
																		: "text-muted-foreground",
																),
															),
														],
														[readiness.prefixLabel],
													),
												]),
										h.span(
											[
												h.Class(
													cn(
														"text-sm",
														isReady ? "text-foreground" : "text-muted-foreground",
													),
												),
											],
											[
												isReady
													? requirement.kind === "telemetry"
														? "trace data is arriving"
														: "metrics are arriving"
													: `no matching metrics in ${READINESS_WINDOW_LABEL}`,
											],
										),
										...(requirement.kind !== "telemetry" && readiness !== undefined
											? [
													h.span(
														[
															h.Class(
																"text-muted-foreground ml-auto shrink-0 font-mono text-2xs",
															),
														],
														[
															String(readiness.metricCount),
															" ",
															readiness.metricCount === 1
																? "metric"
																: "metrics",
															...(age === null ? [] : [` · last seen ${age}`]),
														],
													),
												]
											: []),
									],
								),
								h.p(
									[h.Class("text-muted-foreground text-2xs")],
									[
										isReady ? "Collected by" : "Emitted by",
										" ",
										requirement.collector,
										".",
										...(!isReady &&
										requirement.hint !== undefined &&
										requirement.hint !== null &&
										requirement.hint !== ""
											? [` ${requirement.hint}`]
											: []),
									],
								),
							],
						),
					],
				),
			],
		),
	]
}

/** The parameter form: one labelled input per template parameter. */
const parameterFields = (h: H, model: Model, template: V2DashboardTemplate): ReadonlyArray<Html> =>
	template.parameters.length === 0
		? []
		: [
				h.div(
					[h.Class("flex flex-col gap-2.5")],
					[
						eyebrow(h, { variant: "label" }, ["Parameters"]),
						h.div(
							[h.Class("flex max-w-95 flex-col gap-4")],
							template.parameters.map((parameter) =>
								h.keyed("div")(
									parameter.key,
									[
										h.Class(cn(fieldStyles, "items-stretch gap-1.75")),
										h.DataAttribute("slot", "field"),
									],
									[
										h.div(
											[h.Class("flex items-baseline gap-2")],
											[
												h.label(
													[
														h.Class(cn(fieldLabelStyles)),
														h.DataAttribute("slot", "field-label"),
														h.For(`template-param-${parameter.key}`),
													],
													[parameter.label],
												),
												h.span(
													[h.Class("text-muted-foreground text-2xs")],
													[parameter.required ? "required" : "optional"],
												),
											],
										),
										input(h, {
											id: `template-param-${parameter.key}`,
											attributes: [
												h.Value(model.parameters[parameter.key] ?? ""),
												...(parameter.placeholder === undefined ||
												parameter.placeholder === null
													? []
													: [h.Placeholder(parameter.placeholder)]),
												h.OnInput((value) =>
													Message.ChangedParameter({ key: parameter.key, value }),
												),
											],
										}),
										...(parameter.description === undefined ||
										parameter.description === null ||
										parameter.description === ""
											? []
											: [
													h.p(
														[
															h.Class(cn(fieldDescriptionStyles, "text-2xs")),
															h.DataAttribute("slot", "field-description"),
														],
														[parameter.description],
													),
												]),
									],
								),
							),
						),
					],
				),
			]

/** The sticky create row: Create, or Set up + Create it anyway for a gated template. */
const createRow = (h: H, model: Model, template: V2DashboardTemplate, isReady: boolean): Html => {
	const missing = template.parameters
		.filter((parameter) => parameter.required && (model.parameters[parameter.key] ?? "").trim() === "")
		.map((parameter) => parameter.label)
	const create = Message.ClickedCreate({ templateId: template.id })
	return h.div(
		[h.Class("sticky bottom-0 z-10 -mx-8 -mb-8 bg-[var(--panel-surface)] px-8 pt-3 pb-6")],
		[
			h.div([
				h.AriaHidden(true),
				h.Class(
					"pointer-events-none absolute inset-x-0 bottom-full h-12 bg-gradient-to-t from-[var(--panel-surface)] to-transparent",
				),
			]),
			h.div(
				[h.Class("flex flex-wrap items-center gap-x-3.5 gap-y-2")],
				[
					...(isReady
						? [
								button(
									h,
									{
										isDisabled: missing.length > 0,
										isLoading: model.isCreating,
										attributes: [h.OnClick(create)],
									},
									[
										"Create dashboard",
										icon(h, "ArrowRightIcon", {
											attributes: [h.DataAttribute("icon", "inline-end")],
										}),
									],
								),
							]
						: [
								linkButton(h, { href: setupHref(template) }, [
									`Set up ${template.requirement?.setupLabel ?? "the collector"}`,
									icon(h, "ExternalLinkIcon", {
										attributes: [h.DataAttribute("icon", "inline-end")],
									}),
								]),
								button(
									h,
									{
										variant: "outline",
										isDisabled: missing.length > 0,
										isLoading: model.isCreating,
										attributes: [h.OnClick(create)],
									},
									["Create it anyway"],
								),
							]),
					h.p(
						[h.Class("text-muted-foreground min-w-0 text-2xs")],
						[
							missing.length > 0
								? `Fill in ${missing.join(" and ")} first.`
								: isReady
									? "Creates a copy you own. Edit or delete it freely."
									: "Creating it now is fine. The widgets stay empty until the data shows up, then fill in on their own.",
						],
					),
				],
			),
		],
	)
}

/** `TemplateDetailPanel`. */
export const detailPanel = (
	h: H,
	model: Model,
	template: V2DashboardTemplate,
	readiness: TemplateReadiness | undefined,
	timeZone: string,
): Html => {
	const isReady = readiness?.ready !== false
	const composition = compositionLabel(template.preview)
	return h.keyed("div")(
		template.id,
		[h.Class("flex flex-col gap-6 bg-inherit p-8")],
		[
			h.div(
				[h.Class("flex flex-col gap-3")],
				[
					h.div(
						[h.Class("flex items-center gap-3")],
						[
							h.span(
								[
									h.Class(
										"border-border bg-card flex size-8.5 shrink-0 items-center justify-center rounded-lg border",
									),
								],
								[icon(h, templateIcon(template.id, template.category), { size: 17 })],
							),
							h.div(
								[h.Class("flex min-w-0 flex-col gap-1")],
								[
									h.h2([h.Class("text-lg font-semibold tracking-tight")], [template.name]),
									h.div(
										[h.Class("text-muted-foreground flex items-center gap-2 text-2xs")],
										[
											h.span(
												[],
												[CATEGORY_LABELS.get(template.category) ?? template.category],
											),
											h.span([h.Class("text-border")], ["/"]),
											h.span(
												[h.Class("font-mono")],
												[
													widgetCountLabel(template),
													...(composition === "" ? [] : [` · ${composition}`]),
												],
											),
										],
									),
								],
							),
						],
					),
					h.p(
						[h.Class("text-muted-foreground max-w-140 text-sm leading-relaxed")],
						[template.description],
					),
				],
			),
			h.div(
				[h.Class("flex flex-col gap-2")],
				[
					livePreview(h, model, timeZone),
					h.p(
						[h.Class("text-muted-foreground/80 text-2xs")],
						["That's the dashboard you'd get right now."],
					),
				],
			),
			...requirementBlock(h, template, readiness, model.nowMs ?? 0),
			...parameterFields(h, model, template),
			createRow(h, model, template, isReady),
		],
	)
}
