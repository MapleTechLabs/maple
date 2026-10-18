import type { AlertDestinationDocument, AlertIncidentDocument } from "@maple/domain/http"
import {
	buildRuleStatesByRuleId,
	rowToAlertDestinationDocument,
	rowToAlertIncidentDocument,
	rowToAlertRuleDocument,
} from "@maple/web-data/collections/alerts"
import { normalizeTimestampInput } from "@maple/web-data/lib/timezone-format"
import { AsyncData } from "foldkit"
import { lookupField } from "../../kit/autocomplete-lookups"
import { isoMs } from "../shared/time"
import type { Model, TraceFacets } from "./model"

// The live rows as the documents the editor reads.

export const destinationsOf = (model: Model): ReadonlyArray<AlertDestinationDocument> =>
	(model.destinations ?? []).map(rowToAlertDestinationDocument)

/** Tags already in use across the org's rules, sorted (`tagSuggestions`). */
export const tagSuggestionsOf = (model: Model): ReadonlyArray<string> => {
	const states = buildRuleStatesByRuleId(model.states ?? [])
	const tags = (model.rules ?? []).flatMap((row) => rowToAlertRuleDocument(row, states).tags)
	return [...new Set(tags)].sort()
}

/** The edited rule's open incidents (`clearedIncidents` input). */
export const openIncidentsOf = (model: Model): ReadonlyArray<AlertIncidentDocument> =>
	model.editingRuleId === null
		? []
		: (model.incidents ?? [])
				.map(rowToAlertIncidentDocument)
				.filter((incident) => incident.ruleId === model.editingRuleId && incident.status === "open")

const NO_FACETS: TraceFacets = { services: [], environments: [], spanNames: [], httpMethods: [], httpStatusCodes: [] }

/** The traces facets once answered (`autocompleteValues.traces`). */
export const traceFacetsOf = (model: Model): TraceFacets =>
	AsyncData.match(model.traceFacets.data, {
		onIdle: () => NO_FACETS,
		onLoading: () => NO_FACETS,
		onRefreshing: (facets) => facets,
		onSuccess: (facets) => facets,
		onFailure: () => NO_FACETS,
		onStale: ({ data }) => data,
	})

/** The span attribute keys the split-by picker offers as `attr.*`. */
export const spanAttributeKeysOf = (model: Model): ReadonlyArray<string> => {
	const slot = model.autocomplete.spanAttributeKeys
	if (slot === undefined) return []
	return AsyncData.match(slot.data, {
		onIdle: () => [],
		onLoading: () => [],
		onRefreshing: (answer) => lookupField(answer, "keys"),
		onSuccess: (answer) => lookupField(answer, "keys"),
		onFailure: () => [],
		onStale: ({ data }) => lookupField(data, "keys"),
	})
}

/** The preview window in epoch ms: the chart's domain, so the axis follows the picker. */
export const windowMsOf = (model: Model): { min: number; max: number } =>
	model.previewWindow === null
		? { min: 0, max: 0 }
		: {
				min: isoMs(normalizeTimestampInput(model.previewWindow.startTime)),
				max: isoMs(normalizeTimestampInput(model.previewWindow.endTime)),
			}
