import type { AlertQueryTiming } from "@maple/domain/http"
import type { AlertDestinationDocument, AlertIncidentDocument } from "@maple/domain/http"
import type { AlertRuleRow } from "@maple/web-data/collections/alerts"
import {
	buildRuleStatesByRuleId,
	rowsToAlertDestinationDocuments,
	rowsToAlertIncidentDocuments,
	rowsToAlertRuleDocuments,
} from "@maple/web-data/collections/alerts"
import { normalizeTimestampInput } from "@maple/ui/lib/timezone-format"
import { AsyncData } from "foldkit"
import { lookupField } from "../../kit/autocomplete-lookups"
import { previewIssue, previewPayload, previewStateOf, type PreviewState } from "../shared/preview"
import { isProtectedDefault, saveIssues } from "./derive"
import type { RuleForm } from "./form"
import { revealedInvalidFields } from "./summary"
import type { Model, TraceFacets } from "./model"
import { Array as Arr } from "effect"
import { toEpochMs } from "@maple/ui/lib/time-format"

export const destinationsOf = (model: Pick<Model, "destinations">): ReadonlyArray<AlertDestinationDocument> =>
	rowsToAlertDestinationDocuments(model.destinations ?? [])

const NO_STATES = buildRuleStatesByRuleId([])

/** Tags already in use across the org's rules, sorted (`tagSuggestions`); the previous list while equal. */
export const tagSuggestionsOf = (
	rows: ReadonlyArray<AlertRuleRow>,
	previous: ReadonlyArray<string>,
): ReadonlyArray<string> => {
	const tags = [
		...new Set(Arr.flatMap(rowsToAlertRuleDocuments(rows, NO_STATES), (rule) => rule.tags)),
	].sort()
	return tags.length === previous.length && Arr.every(tags, (tag, index) => tag === previous[index])
		? previous
		: tags
}

/** The edited rule's open incidents. */
export const openIncidentsOf = (
	model: Pick<Model, "incidents" | "editingRuleId">,
): ReadonlyArray<AlertIncidentDocument> =>
	model.editingRuleId === null
		? []
		: Arr.filter(
				rowsToAlertIncidentDocuments(model.incidents ?? []),
				(incident) => incident.ruleId === model.editingRuleId && incident.status === "open",
			)

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
				min: toEpochMs(normalizeTimestampInput(model.previewWindow.startTime)),
				max: toEpochMs(normalizeTimestampInput(model.previewWindow.endTime)),
			}

/** Whether the draft can be previewed at all: a window, and a query the preview can run. */
export const hasPreviewPayload = (model: Pick<Model, "previewWindow">, form: RuleForm): boolean =>
	model.previewWindow !== null && previewPayload(form, model.previewWindow)._tag === "Some"
const hasPayload = hasPreviewPayload

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

/** The draft's preview state. */
export const draftPreviewOf = (
	model: Pick<Model, "preview" | "previewWindow">,
	form: RuleForm,
): PreviewState => previewStateOf(model.preview, hasPayload(model, form), previewIssue(form))

/**
 * The fields that show their error (by element id), as one string: a `createLazy` slot compares it
 * by value. Empty on a pristine form.
 */
export const invalidFieldsOf = (
	model: Pick<
		Model,
		"preview" | "previewWindow" | "touchedFields" | "hasAttemptedSave" | "editingRuleId" | "savedForm"
	>,
	form: RuleForm,
): string =>
	Arr.join(
		revealedInvalidFields(
			saveIssues(form, draftTimingOf(model, form), isProtectedDefault(model)),
			model.touchedFields,
			model.hasAttemptedSave,
		),
		",",
	)
