import { parseFunnelStepFilter } from "./funnel-filters"
import type { Html, HtmlBuilder } from "foldkit/html"
import {
	stepBuilder as kitStepBuilder,
	StepEdit,
	stepFilterLine,
	type StepDraft,
} from "../../kit/funnel-steps"
import { autocompleteFor, stepField, stepFilterId } from "./where-fields"
import { Message } from "./message"
import type { Model } from "./model"
import type { StepScope } from "../../kit/funnel-steps"
import { ProductEdit } from "./product-edit"
import type { Suggestion } from "./suggestions"

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

/** The event step's attribute filter line, with the editor's suggestions. */
const filterLine = (
	h: H,
	model: Model,
	scope: StepScope,
	step: StepDraft & { kind: "event" },
	index: number,
): Html => {
	const filterClause = step.filterClause ?? ""
	const parsed = parseFunnelStepFilter(filterClause)
	return stepFilterLine(h, {
		id: stepFilterId(scope, index),
		index,
		value: filterClause,
		error: parsed.ok ? undefined : parsed.error,
		onInput: (value) =>
			Message.ChangedProduct({
				edit: ProductEdit.Step({
					scope,
					edit: StepEdit.ChangedText({ index, field: "filterClause", value }),
				}),
			}),
		submit: { autocomplete: autocompleteFor(model, stepField(scope, index, filterClause)) },
	})
}

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
