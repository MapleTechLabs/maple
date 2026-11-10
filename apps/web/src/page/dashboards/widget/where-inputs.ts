import type { WhereClauseAutocompleteValues } from "../../../lib/query-builder/where-clause-autocomplete"
import { Option, Array as Arr } from "effect"
import type { PageContext } from "../../contract"
import type { QueryDraft } from "../../kit/query-builder/draft"
import type { PanelInputs } from "../../kit/query-builder/panel"
import {
	autocompleteField,
	lookupTraceFacets,
	metricKeysOf,
	type WhereValueSources,
	whereValuesOf,
} from "../../kit/query-builder/where-values"
import type { Model } from "./model"
import { autocompleteWindowOf } from "./update"

// The provider's lookups per source, the metric list's services, and the board's variable names, for
// the query panels' where editors.

const sourcesOf = (model: Model, query: QueryDraft | undefined): WhereValueSources => ({
	slots: model.autocomplete,
	traceFacets: () => lookupTraceFacets(model.autocomplete),
	// A picked metric suggests only its own keys, none until they arrive.
	metricAttributeKeys: () =>
		query?.dataSource === "metrics" && query.metricName !== ""
			? (metricKeysOf(model.metricKeys, query)?.attributes ?? [])
			: autocompleteField(model.autocomplete, "metricAttributeKeys", "keys"),
	metricServices: model.metricOptions?.services ?? [],
})

/** The provider's values for a source the list widget reads (no variables). */
export const providerValuesOf = (
	model: Model,
	dataSource: "traces" | "logs" | "product_events",
): WhereClauseAutocompleteValues => whereValuesOf(dataSource, sourcesOf(model, undefined))

/** The source's values, with a picked metric's own keys. */
export const baseValuesOf = (model: Model, query: QueryDraft): WhereClauseAutocompleteValues => ({
	...whereValuesOf(query.dataSource, sourcesOf(model, query)),
	variables: Arr.map(model.document?.variables ?? [], (variable) => variable.name),
})

export const panelInputsOf = (model: Model, context: PageContext): PanelInputs => ({
	queryOf: (queryId) =>
		Option.getOrUndefined(Arr.findFirst(model.state?.queries ?? [], (query) => query.id === queryId)),
	baseValuesOf: (query) => baseValuesOf(model, query),
	orgId: context.orgId,
	window: autocompleteWindowOf(model, context),
})
