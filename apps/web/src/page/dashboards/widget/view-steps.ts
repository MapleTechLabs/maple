import { parseFunnelStepFilter } from "../../../lib/query-builder/funnel-filters"
import type { Html, HtmlBuilder } from "foldkit/html"
import { eyebrow } from "@maple/views/ui/eyebrow"
import { stepBuilder as kitStepBuilder, StepEdit, type StepDraft } from "../../kit/funnel-steps"
import { whereEditor } from "../../kit/query-builder/where-editor"
import { autocompleteFor, stepField, stepFilterId } from "./where-fields"
import { Message } from "./message"
import type { Model } from "./model"
import type { StepScope } from "../../kit/funnel-steps"
import { ProductEdit } from "./product-edit"
import type { Suggestion } from "./suggestions"
import { hstack } from "@maple/views/ui/stack"

// The widget editor's funnel step builder: the kit's, with an attribute filter under event steps.

type H = HtmlBuilder<Message>

export type StepBuilderOptions = Readonly<{
	scope: StepScope
	steps: ReadonlyArray<StepDraft>
	eventNames: ReadonlyArray<Suggestion>
	pagePaths: ReadonlyArray<Suggestion>
	eventStepFilter: boolean
	maxSteps: number
}>

/** The event step's attribute filter line, its parse error under it. */
const filterLine = (
	h: H,
	model: Model,
	scope: StepScope,
	step: StepDraft & { kind: "event" },
	index: number,
): Html => {
	const filterClause = step.filterClause ?? ""
	const parsed = parseFunnelStepFilter(filterClause)
	return h.div(
		[h.Class("flex flex-col gap-0.5 pl-6")],
		[
			hstack(h, { gap: "1.5" }, [
				eyebrow(h, { className: "shrink-0" }, ["where"]),
				whereEditor(h, {
					id: stepFilterId(scope, index),
					value: filterClause,
					ariaLabel: `Step ${index + 1} attribute filter`,
					placeholder: 'plan = "pro" AND source = "cli"',
					rows: 1,
					className: "min-w-0 flex-1",
					textareaClassName: "min-h-[28px] resize-none text-xs",
					onInput: (value) =>
						Message.ChangedProduct({
							edit: ProductEdit.Step({
								scope,
								edit: StepEdit.ChangedText({ index, field: "filterClause", value }),
							}),
						}),
					autocomplete: autocompleteFor(model, stepField(scope, index, filterClause)),
				}),
			]),
			...(parsed.ok ? [] : [h.p([h.Class("text-2xs text-severity-error")], [parsed.error])]),
		],
	)
}

/** `FunnelStepBuilder compact`. */
export const stepBuilder = (h: H, model: Model, options: StepBuilderOptions): Html =>
	kitStepBuilder(h, {
		scope: options.scope,
		slotPrefix: "widget-editor",
		steps: options.steps,
		eventNames: options.eventNames,
		pagePaths: options.pagePaths,
		maxSteps: options.maxSteps,
		combos: model.stepCombos,
		selects: model.selects,
		onCombo: (id, message) => Message.GotStepComboMessage({ id, message }),
		onSelect: (id, message) => Message.GotSelectMessage({ id, message }),
		onEdit: (edit) => Message.ChangedProduct({ edit: ProductEdit.Step({ scope: options.scope, edit }) }),
		eventStepExtra: options.eventStepFilter
			? (step, index) => filterLine(h, model, options.scope, step, index)
			: undefined,
	})
