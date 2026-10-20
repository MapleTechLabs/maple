import { DashboardVariableSchema, DashboardWidgetSchema, TimeRangeSchema } from "@maple/domain/http"
import { Clock, Effect, Queue, Schema, Stream } from "effect"
import { Command, Mount } from "foldkit"
import { toLoadFailure } from "../../../data/load-failure"
import { TimeWindow } from "../../../data/time-range"
import { AutocompleteLookup, autocompleteLookup } from "../../kit/autocomplete-lookups"
import { errorMessageOf, mutateDashboard } from "../kit/store"
import { fetchVariableOptions } from "../kit/variables"
import { fetchWidgetData, toWidgetFailure } from "../kit/widget-data"
import { GeneratedIdPurpose, Message } from "./message"
import { fetchSuggestions, SuggestionLookup } from "./suggestions"

/** One `useFunnelSuggestions` lookup over the preview's window. */
export const FetchSuggestions = Command.define("FetchWidgetEditorSuggestions", {
	args: { key: Schema.String, lookup: SuggestionLookup, window: TimeWindow },
	messages: [Message.CompletedFetchSuggestions],
	execute: ({ key, lookup, window }) =>
		fetchSuggestions(lookup, window).pipe(
			Effect.mapError(toLoadFailure),
			Effect.result,
			Effect.map((result) => Message.CompletedFetchSuggestions({ key, lookup, result })),
		),
})

export const ReadClock = Command.define("ReadWidgetEditorClock", {
	messages: [Message.CompletedReadClock],
	execute: Effect.map(Clock.currentTimeMillis, (nowMs) => Message.CompletedReadClock({ nowMs })),
})

/** `useWidgetData` for the preview: one fetch per request key. */
export const FetchWidget = Command.define("FetchWidgetPreview", {
	args: {
		key: Schema.String,
		endpoint: Schema.String,
		params: Schema.Record(Schema.String, Schema.Unknown),
	},
	messages: [Message.CompletedFetchWidget],
	execute: ({ key, endpoint, params }) =>
		fetchWidgetData(endpoint, params).pipe(
			Effect.mapError(toWidgetFailure),
			Effect.result,
			Effect.map((result) => Message.CompletedFetchWidget({ key, result })),
		),
})

/** A query variable's option list over the board's window (`readVariableOptions`). */
export const FetchVariableOptions = Command.define("FetchWidgetEditorVariableOptions", {
	args: { name: Schema.String, key: Schema.String, variable: DashboardVariableSchema, window: TimeWindow },
	messages: [Message.CompletedFetchVariableOptions],
	execute: ({ name, key, variable, window }) =>
		fetchVariableOptions(variable, window).pipe(
			Effect.mapError(toWidgetFailure),
			Effect.result,
			Effect.map((result) => Message.CompletedFetchVariableOptions({ name, key, result })),
		),
})

/** `crypto.randomUUID()` for a new or cloned query, or a new formula. */
export const GenerateId = Command.define("GenerateWidgetEditorId", {
	args: { purpose: GeneratedIdPurpose, source: Schema.String },
	messages: [Message.GeneratedId],
	execute: ({ purpose, source }) =>
		Effect.map(
			Effect.sync(() => crypto.randomUUID()),
			(id) => Message.GeneratedId({ purpose, source, id }),
		),
})

const Target = { orgId: Schema.String, dashboardId: Schema.String }

/** `updateDashboardTimeRange` (`DashboardTimeRangeSync`): the picked range is the board's. */
export const SaveTimeRange = Command.define("SaveWidgetEditorTimeRange", {
	args: { ...Target, timeRange: TimeRangeSchema },
	messages: [Message.CompletedSaveTimeRange],
	execute: ({ orgId, dashboardId, timeRange }) =>
		mutateDashboard(orgId, dashboardId, (document, nowIso) => ({
			...document,
			timeRange,
			updatedAt: nowIso,
		})).pipe(
			Effect.match({
				onFailure: (error) => Message.CompletedSaveTimeRange({ error: errorMessageOf(error) }),
				onSuccess: () => Message.CompletedSaveTimeRange({ error: null }),
			}),
		),
})

/** `updateWidget`: the edited widget replaces the stored one; no override drops the key. */
export const SaveWidget = Command.define("SaveDashboardWidget", {
	args: { ...Target, widget: DashboardWidgetSchema },
	messages: [Message.CompletedSave],
	execute: ({ orgId, dashboardId, widget }) =>
		mutateDashboard(orgId, dashboardId, (document, nowIso) => ({
			...document,
			widgets: document.widgets.map((existing) => (existing.id === widget.id ? widget : existing)),
			updatedAt: nowIso,
		})).pipe(
			Effect.match({
				onFailure: (error) => Message.CompletedSave({ error: errorMessageOf(error) }),
				onSuccess: () => Message.CompletedSave({ error: null }),
			}),
		),
})

/** `useWidgetMaxDataPoints`: the preview pane's width in 100 px steps, now and on resize. */
export const MeasurePreview = Mount.defineStream("MeasureWidgetEditorPreview", {
	messages: [Message.MeasuredPreview],
	execute: ({ element }) =>
		Stream.callback<typeof Message.MeasuredPreview.Type>((queue) =>
			Effect.acquireRelease(
				Effect.sync(() => {
					const measure = (width: number) => {
						if (Number.isFinite(width) && width > 0)
							Queue.offerUnsafe(
								queue,
								Message.MeasuredPreview({
									widthPx: Math.max(100, Math.floor(width / 100) * 100),
								}),
							)
					}
					measure(element.getBoundingClientRect().width)
					const observer = new ResizeObserver((entries) =>
						entries.forEach((entry) => measure(entry.contentRect.width)),
					)
					observer.observe(element)
					return observer
				}),
				(observer) => Effect.sync(() => observer.disconnect()),
			).pipe(Effect.flatMap(() => Effect.never)),
		),
})

/** One `AutocompleteValuesProvider` lookup over the board's window. */
export const FetchAutocomplete = Command.define("FetchWidgetEditorAutocomplete", {
	args: { key: Schema.String, lookup: AutocompleteLookup, window: TimeWindow },
	messages: [Message.CompletedFetchAutocomplete],
	execute: ({ key, lookup, window }) =>
		autocompleteLookup(lookup, window).pipe(
			Effect.mapError(toLoadFailure),
			Effect.result,
			Effect.map((result) => Message.CompletedFetchAutocomplete({ key, lookup, result })),
		),
})
