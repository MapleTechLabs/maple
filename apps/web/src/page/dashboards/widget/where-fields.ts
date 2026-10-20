import type { FunnelPopulationFilterField } from "@maple/query-model"
import type { WhereClauseAutocompleteValues } from "../../../lib/query-builder/where-clause-autocomplete"
import { Option } from "effect"
import { AsyncData } from "foldkit"
import type { TimeWindow } from "../../../data/time-range"
import type { PageContext } from "../../contract"
import type { WhereEditorAutocomplete } from "../../kit/query-builder/where-editor"
import type { WhereFieldSpec, WhereFieldsInputs } from "../../kit/where-field-update"
import type { ListDataSource } from "./editor-state"
import { Message } from "./message"
import type { Model } from "./model"
import { ProductEdit, type StepScope } from "./product-edit"
import { autocompleteWindowOf } from "./update"
import { providerValuesOf } from "./where-inputs"

// The list filter, the population filters and the funnel steps' filters as `WhereFields`
// (`ListConfigPanel`, `FunnelQueryPanel`, `PathsQueryPanel`, `FunnelStepBuilder`).

export const LIST_FILTER_ID = "widget-list-filter"
export const populationFilterId = (scope: StepScope): string => `widget-${scope}-population`
export const stepFilterId = (scope: StepScope, index: number): string => `widget-step-${scope}-${index}-filter`

/** A field on screen: its spec, and the edit its applied text makes. */
export type WhereField = Readonly<{ spec: WhereFieldSpec; edit: (expression: string) => ProductEdit }>

const noValues = () => null

/** `useFunnelSuggestions().facets`: each facet's names under its population field. */
const facetsOf = (model: Model): WhereClauseAutocompleteValues["productEventFacets"] => {
	const rows = Option.getOrElse(AsyncData.getData(model.suggestions.facets?.data ?? AsyncData.Idle()), () => [])
	return rows.reduce<Partial<Record<FunnelPopulationFilterField, Array<string>>>>((facets, row) => {
		const field = row.field
		return field === null ? facets : { ...facets, [field]: [...(facets[field] ?? []), row.name] }
	}, {})
}

/** The list filter completes from the provider's values for its source, keys over its window. */
export const listField = (
	model: Model,
	window: TimeWindow | null,
	expression: string,
	source: ListDataSource,
): WhereField => ({
	spec: {
		expression,
		textareaId: LIST_FILTER_ID,
		dataSource: source,
		values: providerValuesOf(model, source),
		requestOf: (kind, attributeKey) =>
			window === null ? null : { _tag: kind === "attr" ? "Span" : "Resource", ...window, attributeKey },
	},
	edit: (value) => ProductEdit.ChangedListWhere({ value }),
})

/** A population filter: the session dimensions, their values from the facets. */
export const populationField =(model: Model, scope: StepScope, expression: string): WhereField => ({
	spec: {
		expression,
		textareaId: populationFilterId(scope),
		dataSource: "traces",
		scope: "product_events",
		values: { productEventFacets: facetsOf(model) },
		requestOf: noValues,
	},
	edit: (value) => ProductEdit.ChangedPopulationFilter({ scope, value }),
})

/** A funnel event step's attribute filter: the customer's own keys, so `=` and conjunctions only. */
export const stepField = (scope: StepScope, index: number, expression: string): WhereField => ({
	spec: {
		expression,
		textareaId: stepFilterId(scope, index),
		dataSource: "traces",
		scope: "product_event_attributes",
		values: {},
		requestOf: noValues,
	},
	edit: (value) => ProductEdit.ChangedStepText({ scope, index, field: "filterClause", value }),
})

/**
 * Every where field the editor's state has, by field id. `window` is the provider's, which the
 * active keys' values are read over; the view passes none, it reads no values.
 */
export const whereFieldsOf = (model: Model, window: TimeWindow | null): ReadonlyMap<string, WhereField> => {
	const state = model.state
	if (state === null) return new Map()
	const steps = state.funnel.steps.flatMap((step, index): ReadonlyArray<readonly [string, WhereField]> =>
		step.kind === "event" ? [[stepFilterId("funnel", index), stepField("funnel", index, step.filterClause ?? "")]] : [],
	)
	return new Map<string, WhereField>([
		[LIST_FILTER_ID, listField(model, window, state.listWhereClause, state.listDataSource)],
		[populationFilterId("funnel"), populationField(model, "funnel", state.funnel.filterClause)],
		[populationFilterId("paths"), populationField(model, "paths", state.paths.filterClause)],
		...steps,
	])
}

/** The editor's `autocomplete` option for a field; its textarea id is its field id. */
export const autocompleteFor = (model: Model, field: WhereField): WhereEditorAutocomplete<Message> => ({
	fields: model.whereFields,
	fieldId: field.spec.textareaId,
	spec: field.spec,
	toMessage: (message) => Message.GotWhereFieldMessage({ message }),
})

export const whereFieldsInputsOf =(model: Model, context: PageContext): WhereFieldsInputs => {
	const fields = whereFieldsOf(model, autocompleteWindowOf(model, context))
	return { specOf: (fieldId) => fields.get(fieldId)?.spec, orgId: context.orgId }
}
