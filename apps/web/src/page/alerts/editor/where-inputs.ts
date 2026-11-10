import type { WhereClauseAutocompleteValues } from "../../../lib/query-builder/where-clause-autocomplete"
import type { PageContext } from "../../contract"
import type { QueryDraft } from "../../kit/query-builder/draft"
import type { PanelInputs } from "../../kit/query-builder/panel"
import { autocompleteField, metricKeysOf, whereValuesOf } from "../../kit/query-builder/where-values"
import { traceFacetsOf } from "./derive-rows"
import type { Model } from "./model"

// `AlertQueryPanel`'s `autocompleteValues` (the provider is not lazy here): the where editor's
// suggestions per source, over the editor's 24h window.

type ValuesModel = Pick<Model, "traceFacets" | "autocomplete" | "metricKeys" | "metricOptions">

/** `autocompleteValues[query.dataSource]`, with a picked metric's own keys (`useMetricScopedAutocomplete`). */
export const baseValuesOf = (model: ValuesModel, query: QueryDraft): WhereClauseAutocompleteValues =>
	whereValuesOf(query.dataSource, {
		slots: model.autocomplete,
		traceFacets: () => traceFacetsOf(model),
		// The org-wide keys stand in until a picked metric's own keys arrive.
		metricAttributeKeys: () =>
			metricKeysOf(model.metricKeys, query)?.attributes ??
			autocompleteField(model.autocomplete, "metricAttributeKeys", "keys"),
		metricServices: model.metricOptions?.services ?? [],
	})

export const panelInputsOf = (model: Model, context: PageContext): PanelInputs => ({
	queryOf: (queryId) =>
		model.form?.queryBuilderDraft.id === queryId ? model.form.queryBuilderDraft : undefined,
	baseValuesOf: (query) => baseValuesOf(model, query),
	orgId: context.orgId,
	window: model.autocompleteWindow,
})
