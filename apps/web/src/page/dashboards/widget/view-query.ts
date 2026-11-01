import { cn } from "@maple/ui/lib/utils"
import { badgeVariants } from "@maple/ui/styles/ui/badge"
import { eyebrowVariants } from "@maple/ui/styles/ui/eyebrow"
import { fieldErrorStyles } from "@maple/ui/styles/ui/field"
import type { Html, HtmlBuilder } from "foldkit/html"
import { button } from "../../../ui/button"
import * as Checkbox from "../../../ui/checkbox"
import { eyebrow } from "../../../ui/eyebrow"
import * as TabsView from "../../../ui/tabs-view"
import { textarea } from "../../../ui/textarea"
import { textInput } from "../../kit/query-builder/parts"
import { queryPanelView } from "../../kit/query-builder/view"
import type { FormulaDraft, QueryDraft } from "./editor-state"
import { toPanelType } from "../kit/chart-registry"
import type { EditorState } from "./editor-state"
import { isNote, isProductEventsFunnel, validationErrorOf } from "./lowering"
import { listPanel } from "./view-list"
import { funnelPanel, pathsPanel } from "./view-panels"
import { autoIntervalLabel, isSqlSource, showsSourceToggle } from "./update"
import { rawSqlEditor } from "./view-sql"
import { Message } from "./message"
import { baseValuesOf } from "./where-inputs"
import type { Model } from "./model"

// The widget editor's query side: the source toggle, one `QueryPanel` per query,
// `FormulaPanel`s, and the toolbar.

type H = HtmlBuilder<Message>

/** One `QueryPanel`, from the shared query builder. */
const queryPanel = (
	h: H,
	model: Model,
	query: QueryDraft,
	index: number,
	canRemove: boolean,
	intervalPlaceholder: string,
): Html =>
	h.submodel({
		slotId: `widget-editor-query-${query.id}`,
		model: model.queryPanels,
		view: queryPanelView,
		viewInputs: {
			query,
			index,
			canRemove,
			intervalPlaceholder,
			hasHeaderActions: true,
			hasVisibilityToggle: true,
			metricOptions: model.metricOptions?.options ?? [],
			metricSearch: model.metricSearch,
			metricBreakdownKeys:
				query.dataSource === "metrics"
					? (model.metricKeys[`${query.metricName}::${query.metricType}`] ?? [])
					: [],
			autocompleteValues: baseValuesOf(model, query),
		},
		toParentMessage: (message) => Message.GotQueryPanelMessage({ message }),
	})

/** `FormulaPanel`. */
const formulaPanel = (h: H, formula: FormulaDraft): Html =>
	h.div(
		[h.Class("border border-dashed border-l-2 border-l-chart-3 p-3 space-y-2")],
		[
			h.div(
				[h.Class("flex items-center justify-between gap-2")],
				[
					h.div(
						[h.Class("flex items-center gap-2")],
						[
							...Checkbox.view(h, {
								model: { isChecked: !formula.hidden },
								toParentMessage: () =>
									Message.ToggledFormulaVisible({ formulaId: formula.id }),
								id: `formula-visible-${formula.id}-root`,
								inputId: `formula-visible-${formula.id}`,
							}),
							h.span(
								[
									h.Class(
										cn(
											badgeVariants({
												variant: "outline",
												className:
													"font-mono text-xs bg-chart-3/10 border-chart-3/30",
											}),
										),
									),
									h.DataAttribute("slot", "badge"),
								],
								[formula.name],
							),
						],
					),
					button(
						h,
						{
							variant: "ghost",
							size: "xs",
							attributes: [h.OnClick(Message.ClickedRemoveFormula({ formulaId: formula.id }))],
						},
						["Remove"],
					),
				],
			),
			h.div(
				[h.Class("flex items-center gap-2")],
				[
					textInput(
						h,
						`formula-expression-${formula.id}`,
						formula.expression,
						"A / B, (A + B) / 2",
						"font-mono flex-1",
						(value) =>
							Message.ChangedFormulaText({ formulaId: formula.id, field: "expression", value }),
					),
					textInput(h, `formula-legend-${formula.id}`, formula.legend, "Legend", "w-48", (value) =>
						Message.ChangedFormulaText({ formulaId: formula.id, field: "legend", value }),
					),
				],
			),
		],
	)

const sourceToggle = (h: H, model: Model): Html =>
	h.div(
		[h.Class("flex items-center gap-3")],
		[
			eyebrow(h, {}, ["Source"]),
			h.submodel({
				slotId: "widget-editor-source",
				model: model.sourceTabs,
				view: TabsView.view,
				viewInputs: { labels: ["Query builder", "Raw SQL"], panel: () => undefined },
				toParentMessage: (message) => Message.GotSourceTabsMessage({ message }),
			}),
		],
	)

const MARKDOWN_PLACEHOLDER = "## Runbook\n\n- Check the error rate panel first\n- Escalate to #oncall"

/** `MarkdownEditorPanel`: the note's body; the preview follows as you type. */
const markdownEditor = (h: H, content: string): Html =>
	h.div(
		[h.Class("space-y-2")],
		[
			h.div(
				[h.Class("flex items-baseline justify-between")],
				[
					h.p([h.Class(eyebrowVariants({})), h.DataAttribute("slot", "eyebrow")], ["Content"]),
					h.p(
						[h.Class("text-2xs text-muted-foreground")],
						[
							"Markdown: ",
							h.code([], ["# heading"]),
							", ",
							h.code([], ["**bold**"]),
							", ",
							h.code([], ["- list"]),
							",",
							" ",
							h.code([], ["[link](url)"]),
						],
					),
				],
			),
			textarea(h, {
				id: "widget-editor-markdown",
				className: "min-h-56 font-mono text-xs leading-relaxed",
				defaultValue: content,
				attributes: [
					h.Placeholder(MARKDOWN_PLACEHOLDER),
					h.Spellcheck(true),
					h.OnInput((value) => Message.ChangedMarkdown({ value })),
				],
			}),
		],
	)

export const queryEditor = (h: H, model: Model, timeZone: string): Html => {
	const state = model.state
	if (state === null) return h.empty
	const error = validationErrorOf(state)
	// A note has neither a query nor SQL: its body editor replaces both.
	const isNoteEditor = isNote(state)
	const panel = toPanelType(state.visualization, state.chartId)
	return h.div(
		[h.Class("p-6 space-y-6"), h.OnFocusEnter(Message.FocusedQueryEditor())],
		[
			...(showsSourceToggle(state) ? [sourceToggle(h, model)] : []),
			...(isNoteEditor
				? [markdownEditor(h, state.markdownContent)]
				: isSqlSource(model) && model.rawSql !== null
					? rawSqlEditor(h, model, model.rawSql)
					: [
							...(error === null
								? []
								: [
										h.div(
											[
												h.Class(cn(fieldErrorStyles, "font-medium")),
												h.DataAttribute("slot", "field-error"),
											],
											[error],
										),
									]),
							...(panel === "list"
								? listPanel(h, model, state)
								: panel === "paths"
									? pathsPanel(h, model, state)
									: isProductEventsFunnel(state)
										? funnelPanel(h, model, state)
										: queryPanels(h, model, state, timeZone)),
						]),
		],
	)
}

/** The query panels, formula panels and the toolbar under them. */
const queryPanels = (h: H, model: Model, state: EditorState, timeZone: string): ReadonlyArray<Html> => {
	const error = validationErrorOf(state)
	return [
		h.div(
			[h.Class("space-y-3")],
			state.queries.map((query, index) =>
				queryPanel(
					h,
					model,
					query,
					index,
					state.queries.length > 1,
					autoIntervalLabel(model, timeZone),
				),
			),
		),
		...(state.formulas.length === 0
			? []
			: [
					h.div(
						[h.Class("space-y-3")],
						state.formulas.map((formula) => formulaPanel(h, formula)),
					),
				]),
		h.div(
			[h.Class("flex items-center gap-3")],
			[
				button(
					h,
					{
						variant: "outline",
						size: "sm",
						attributes: [h.OnClick(Message.ClickedAddQuery())],
					},
					["+ Query"],
				),
				button(
					h,
					{
						variant: "outline",
						size: "sm",
						attributes: [h.OnClick(Message.ClickedAddFormula())],
					},
					["+ Formula"],
				),
				button(
					h,
					{
						size: "sm",
						isDisabled: error !== null,
						attributes: [h.OnClick(Message.ClickedRunPreview())],
					},
					["Run preview"],
				),
				// Two text nodes once there are formulas.
				h.span(
					[h.Class("text-2xs text-muted-foreground ml-auto")],
					[
						state.queries.map((query) => query.name).join(", "),
						...(state.formulas.length === 0
							? []
							: [`, ${state.formulas.map((formula) => formula.name).join(", ")}`]),
					],
				),
			],
		),
	]
}
