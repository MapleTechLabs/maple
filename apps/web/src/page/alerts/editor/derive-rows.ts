import type { AlertQueryTiming } from "@maple/domain/http"
import type { AlertDestinationDocument, AlertIncidentDocument } from "@maple/domain/http"
import type { AlertRuleRow } from "@maple/web-data/collections/alerts"
import {
	buildRuleStatesByRuleId,
	rowsToAlertDestinationDocuments,
	rowToAlertIncidentDocument,
	rowToAlertRuleDocument,
} from "@maple/web-data/collections/alerts"
import { normalizeTimestampInput } from "@maple/web-data/lib/timezone-format"
import { AsyncData } from "foldkit"
import { lookupField } from "../../kit/autocomplete-lookups"
import { previewIssue, previewPayload, previewStateOf, type PreviewState } from "../shared/preview"
import { isoMs } from "../shared/time"
import type { RuleForm } from "./form"
import type { Model, TraceFacets } from "./model"

// The live rows as the documents the editor reads.

export const destinationsOf = (model: Pick<Model, "destinations">): ReadonlyArray<AlertDestinationDocument> =>
	rowsToAlertDestinationDocuments(model.destinations ?? [])

const NO_STATES = buildRuleStatesByRuleId([])

/** Tags already in use across the org's rules, sorted (`tagSuggestions`); the previous list while equal. */
export const tagSuggestionsOf = (
	rows: ReadonlyArray<AlertRuleRow>,
	previous: ReadonlyArray<string>,
): ReadonlyArray<string> => {
	const tags = [...new Set(rows.flatMap((row) => rowToAlertRuleDocument(row, NO_STATES).tags))].sort()
	return tags.length === previous.length && tags.every((tag, index) => tag === previous[index])
		? previous
		: tags
}

/** The edited rule's open incidents (`clearedIncidents` input). */
export const openIncidentsOf = (
	model: Pick<Model, "incidents" | "editingRuleId">,
): ReadonlyArray<AlertIncidentDocument> =>
	model.editingRuleId === null
		? []
		: (model.incidents ?? [])
				.map(rowToAlertIncidentDocument)
				.filter((incident) => incident.ruleId === model.editingRuleId && incident.status === "open")

const NO_FACETS: TraceFacets = {
	services: [],
	environments: [],
	spanNames: [],
	httpMethods: [],
	httpStatusCodes: [],
}

/** The traces facets once answered (`autocompleteValues.traces`). */
export const traceFacetsOf = (model: Pick<Model, "traceFacets">): TraceFacets =>
	AsyncData.match(model.traceFacets.data, {
		onIdle: () => NO_FACETS,
		onLoading: () => NO_FACETS,
		onRefreshing: (facets) => facets,
		onSuccess: (facets) => facets,
		onFailure: () => NO_FACETS,
		onStale: ({ data }) => data,
	})

/** The span attribute keys the split-by picker offers as `attr.*`. */
export const spanAttributeKeysOf = (model: Pick<Model, "autocomplete">): ReadonlyArray<string> => {
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
export const windowMsOf = (model: Pick<Model, "previewWindow">): { min: number; max: number } =>
	model.previewWindow === null
		? { min: 0, max: 0 }
		: {
				min: isoMs(normalizeTimestampInput(model.previewWindow.startTime)),
				max: isoMs(normalizeTimestampInput(model.previewWindow.endTime)),
			}

const hasPayload = (model: Pick<Model, "previewWindow">, form: RuleForm): boolean =>
	model.previewWindow !== null && previewPayload(form, model.previewWindow)._tag === "Some"

/** The timing of the draft's own preview: none while a new one loads, so nothing gates on an older query. */
export const draftTimingOf = (
	model: Pick<Model, "preview" | "previewWindow">,
	form: RuleForm,
): AlertQueryTiming | null =>
	hasPayload(model, form)
		? AsyncData.match(model.preview.data, {
				onIdle: () => null,
				onLoading: () => null,
				onRefreshing: () => null,
				onSuccess: (preview) => preview.queryTiming ?? null,
				onFailure: () => null,
				onStale: () => null,
			})
		: null

/** The draft's preview as `useAlertRulePreview` reads it. */
export const draftPreviewOf = (
	model: Pick<Model, "preview" | "previewWindow">,
	form: RuleForm,
): PreviewState => previewStateOf(model.preview, hasPayload(model, form), previewIssue(form))
