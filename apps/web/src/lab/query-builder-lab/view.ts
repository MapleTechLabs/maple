import type { Html, HtmlBuilder } from "foldkit/html"
import { dashboardPage } from "../../page/kit/dashboard-page"
import { textInput } from "../../page/kit/query-builder/parts"
import { timeControls } from "../../page/kit/time-controls"
import * as TimeRangePicker from "../../page/kit/time-range-picker"
import { button } from "../../ui/button"
import { card, cardDescription, cardFooter, cardHeader, cardPanel, cardTitle } from "../../ui/card"
import { separator } from "../../ui/display"
import { icon } from "../../ui/icon"
import { scrollArea } from "../../ui/scroll-area"
import { MeasureScrollArea } from "./command"
import { scrollOverflowOf } from "./derive"
import { type FormulaDraft, Message, type Model } from "./model"
import { DEFAULT_PRESET } from "./update"
import { fieldEyebrow } from "./view-controls"
import { queryRow } from "./view-query"
import { resultsContent } from "./view-results"

// `QueryBuilderLabPage` inside `DashboardLayout`: the header time controls and the lab card.

type H = HtmlBuilder<Message>

const META = "text-2xs text-muted-foreground"

const timeHeader = (h: H, model: Model): Html =>
	timeControls(h, {
		search: model.search,
		defaultPreset: DEFAULT_PRESET,
		window: model.window,
		onReset: Message.ClickedResetTimeRange(),
		onReload: Message.ClickedReload(),
		isReloading: model.isReloading,
		trigger: (label) =>
			h.submodel({
				slotId: "query-builder-lab-time-range",
				model: model.picker,
				view: TimeRangePicker.view,
				toParentMessage: (message) => Message.GotPickerMessage({ message }),
				viewInputs: {
					label,
					selectedPreset:
						model.search.timePreset ??
						(model.search.startTime === undefined ? DEFAULT_PRESET : undefined),
					presets: TimeRangePicker.PRESET_VALUES,
					timeZone: model.timeZone,
				},
			}),
	})

const footer = (h: H, model: Model): Html =>
	cardFooter(
		h,
		[
			h.div(
				[h.Class("flex flex-wrap items-center gap-2")],
				[
					button(
						h,
						{
							variant: "outline",
							size: "sm",
							attributes: [h.OnClick(Message.ClickedAddQuery())],
						},
						[icon(h, "PlusIcon"), "Add query"],
					),
					button(
						h,
						{
							variant: "outline",
							size: "sm",
							attributes: [h.OnClick(Message.ClickedAddFormula())],
						},
						[icon(h, "PlusIcon"), "Add formula"],
					),
				],
			),
			h.div(
				[h.Class("flex items-center gap-2")],
				[
					// The window Run query will use, beside the button that runs it.
					h.span([h.Class(META)], [model.window.startTime, " → ", model.window.endTime]),
					...(model.lastRunAt === null
						? []
						: [h.span([h.Class(META)], ["last run: ", model.lastRunAt])]),
					button(h, { size: "sm", attributes: [h.OnClick(Message.ClickedRun())] }, [
						icon(h, "MediaPlayIcon"),
						"Run query",
					]),
				],
			),
		],
		"flex flex-wrap items-center justify-between gap-2 border-b border-t bg-card",
	)

const formulaRow = (h: H, formula: FormulaDraft): Html => {
	const text = (field: "expression" | "legend") => (value: string) =>
		Message.ChangedFormulaText({ formulaId: formula.id, field, value })
	return h.div(
		[h.Key(formula.id)],
		[
			card(
				h,
				[
					cardHeader(
						h,
						[
							h.div(
								[h.Class("flex items-center justify-between gap-2")],
								[
									h.span(
										[h.Class("text-xs text-muted-foreground")],
										["Formula ", formula.name, " (executed after query runs)"],
									),
									button(
										h,
										{
											variant: "ghost",
											size: "xs",
											attributes: [
												h.OnClick(
													Message.ClickedRemoveFormula({ formulaId: formula.id }),
												),
											],
										},
										[icon(h, "XmarkIcon"), "Remove"],
									),
								],
							),
						],
						"pb-2",
					),
					cardPanel(h, [
						h.div(
							[h.Class("grid gap-2 md:grid-cols-[1.3fr_1fr]")],
							[
								textInput(
									h,
									`formula-expression-${formula.id}`,
									formula.expression,
									"A / B, (A + B) / 2, F1 * 100",
									"font-mono",
									text("expression"),
								),
								textInput(
									h,
									`formula-legend-${formula.id}`,
									formula.legend,
									"Legend",
									"",
									text("legend"),
								),
							],
						),
					]),
				],
				"border-dashed",
			),
		],
	)
}

/** `UI State Preview`: the lab's state as JSON. */
const statePreview = (h: H, model: Model): Html =>
	h.div(
		[],
		[
			fieldEyebrow(h, "UI State Preview", "mb-2"),
			h.pre(
				[
					h.Class(
						"max-h-72 overflow-auto rounded-none border bg-muted/30 p-2 font-mono text-2xs leading-relaxed",
					),
				],
				[
					JSON.stringify(
						{
							startTime: model.window.startTime,
							endTime: model.window.endTime,
							queries: model.queries,
							formulas: model.formulas,
							submittedInput: model.submitted,
						},
						null,
						2,
					),
				],
			),
		],
	)

const resultsCard = (h: H, model: Model): Html =>
	card(
		h,
		[
			cardHeader(h, [cardTitle(h, ["Execution results"], "text-xs")], "pb-1"),
			cardPanel(h, [resultsContent(h, model)], "space-y-2"),
		],
		"gap-2",
	)

export const view = (model: Model, h: H): Html =>
	dashboardPage(h, { actions: timeHeader(h, model) }, [
		card(
			h,
			[
				cardHeader(
					h,
					[
						cardTitle(
							h,
							[icon(h, "PulseIcon", { size: 16 }), "Query builder"],
							"flex items-center gap-2 text-sm",
						),
						cardDescription(h, ["Runs enabled queries against Maple and returns timeseries."]),
					],
					"border-b py-3",
				),
				footer(h, model),
				scrollArea(
					h,
					{
						className: "h-[min(72vh,52rem)]",
						idPrefix: "query-builder-lab-scroll",
						overflowY: scrollOverflowOf(model.scroll),
					},
					[
						cardPanel(
							h,
							[
								// Inputs first: the results answer them, so they follow.
								h.div(
									[h.Class("space-y-2")],
									[
										...model.queries.map((query) => queryRow(h, model, query)),
										...model.formulas.map((formula) => formulaRow(h, formula)),
									],
								),
								resultsCard(h, model),
								separator(h, "horizontal", undefined),
								statePreview(h, model),
							],
							"space-y-3 p-3",
							[h.OnMount(MeasureScrollArea())],
						),
					],
				),
			],
			"py-0",
		),
	])
