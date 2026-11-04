import type { Html, HtmlBuilder } from "foldkit/html"
import { alert, alertDescription, alertTitle } from "@maple/views/ui/alert"
import { button } from "@maple/views/ui/button"
import * as Checkbox from "@maple/views/ui/checkbox"
import { badge } from "@maple/views/ui/display"
import { eyebrow } from "@maple/views/ui/eyebrow"
import { fieldErrorText } from "@maple/views/ui/field"
import * as TabsView from "@maple/views/ui/tabs-view"
import { textarea } from "@maple/views/ui/textarea"
import { textInput } from "../../kit/query-builder/parts"
import { queryPanelView } from "../../kit/query-builder/view"
import type { FormulaDraft, QueryDraft } from "./editor-state"
import { toPanelType } from "../kit/chart-registry"
import type { EditorState } from "./editor-state"
import { isNote, isProductEventsFunnel, queryCapabilitiesOf, validationErrorOf } from "./lowering"
import { listPanel } from "./view-list"
import { funnelPanel, pathsPanel } from "./view-panels"
import { autoIntervalLabel, isSqlSource, showsSourceToggle } from "./update"
import { rawSqlEditor } from "./view-sql"
import { Message } from "./message"
import { baseValuesOf } from "./where-inputs"
import type { Model } from "./model"
import { typography } from "@maple/views/ui/typography"
import { hstack } from "@maple/views/ui/stack"
import { Array as Arr } from "effect"

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
			hstack(h, { gap: "2", justify: "between" }, [
				hstack(h, { gap: "2" }, [
					...Checkbox.view(h, {
						model: { isChecked: !formula.hidden },
						toParentMessage: () => Message.ToggledFormulaVisible({ formulaId: formula.id }),
						id: `formula-visible-${formula.id}-root`,
						inputId: `formula-visible-${formula.id}`,
					}),
					badge(
						h,
						{
							variant: "outline",
							className: "font-mono text-xs bg-chart-3/10 border-chart-3/30",
						},
						[formula.name],
					),
				]),
				button(
					h,
					{
						variant: "ghost",
						size: "xs",
						attributes: [h.OnClick(Message.ClickedRemoveFormula({ formulaId: formula.id }))],
					},
					["Remove"],
				),
			]),
			hstack(h, { gap: "2" }, [
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
			]),
		],
	)

const sourceToggle = (h: H, model: Model): Html =>
	hstack(h, { gap: "3" }, [
		eyebrow(h, {}, ["Source"]),
		h.submodel({
			slotId: "widget-editor-source",
			model: model.sourceTabs,
			view: TabsView.view,
			viewInputs: { labels: ["Query builder", "Raw SQL"], panel: () => undefined },
			toParentMessage: (message) => Message.GotSourceTabsMessage({ message }),
		}),
	])

const MARKDOWN_PLACEHOLDER = "## Runbook\n\n- Check the error rate panel first\n- Escalate to #oncall"

/** `MarkdownEditorPanel`: the note's body; the preview follows as you type. */
const markdownEditor = (h: H, content: string): Html =>
	h.div(
		[h.Class("space-y-2")],
		[
			h.div(
				[h.Class("flex items-baseline justify-between")],
				[
					eyebrow(h, { as: "p" }, ["Content"]),
					typography(h, { size: "2xs", tone: "muted", as: "p" }, [
						"Markdown: ",
						h.code([], ["# heading"]),
						", ",
						h.code([], ["**bold**"]),
						", ",
						h.code([], ["- list"]),
						",",
						" ",
						h.code([], ["[link](url)"]),
					]),
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
								: [fieldErrorText(h, { className: "font-medium" }, error)]),
							...(panel === "list"
								? listPanel(h, model, state)
								: panel === "paths"
									? pathsPanel(h, model, state)
									: isProductEventsFunnel(state)
										? funnelPanel(h, model, state)
										: state.queryFixed
											? [fixedQueryNote(h), runPreviewButton(h, false)]
											: queryPanels(h, model, state, timeZone)),
						]),
		],
	)
}

/** Applies the staged query and display edits (row limit, aggregate) to the preview. */
const runPreviewButton = (h: H, isDisabled: boolean): Html =>
	button(h, { size: "sm", isDisabled, attributes: [h.OnClick(Message.ClickedRunPreview())] }, [
		"Run preview",
	])

/** A preset whose query has no builder equivalent: it stays as stored, only its display edits. */
const fixedQueryNote = (h: H): Html =>
	alert(h, { variant: "info", size: "sm", role: "status" }, [
		alertTitle(h, ["This preset's query can't be edited"]),
		alertDescription(h, [
			"Change its display options here, or recreate it from the query builder or Raw SQL.",
		]),
	])

/** The query panels, formula panels and the toolbar under them. */
const queryPanels = (h: H, model: Model, state: EditorState, timeZone: string): ReadonlyArray<Html> => {
	const error = validationErrorOf(state)
	return [
		h.div(
			[h.Class("space-y-3")],
			Arr.map(state.queries, (query, index) =>
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
						Arr.map(state.formulas, (formula) => formulaPanel(h, formula)),
					),
				]),
		hstack(h, { gap: "3" }, [
			button(
				h,
				{
					variant: "outline",
					size: "sm",
					attributes: [h.OnClick(Message.ClickedAddQuery())],
				},
				["+ Query"],
			),
			// Breakdown rows, grouped tables and histograms drop formulas, so none is offered there.
			...(queryCapabilitiesOf(state).formulas
				? [
						button(
							h,
							{
								variant: "outline",
								size: "sm",
								attributes: [h.OnClick(Message.ClickedAddFormula())],
							},
							["+ Formula"],
						),
					]
				: []),
			runPreviewButton(h, error !== null),
			// Two text nodes once there are formulas.
			typography(h, { size: "2xs", tone: "muted", className: "ml-auto" }, [
				Arr.join(
					Arr.map(state.queries, (query) => query.name),
					", ",
				),
				...(state.formulas.length === 0
					? []
					: [
							`, ${Arr.join(
								Arr.map(state.formulas, (formula) => formula.name),
								", ",
							)}`,
						]),
			]),
		]),
	]
}
