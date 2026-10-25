import { createFormulaDraft, createQueryDraft } from "@maple/query-engine/query-builder"
import { listMetrics } from "@maple/web-data/warehouse/metrics"
import { getQueryBuilderTimeseries } from "@maple/web-data/warehouse/query-builder-timeseries"
import { Clock, Duration, Effect, Option, Queue, Schema, Stream } from "effect"
import { Command, Mount } from "foldkit"
import { toLoadFailure } from "../../data/load-failure"
import { currentWindow, TimeWindow } from "../../data/time-range"
import { AutocompleteLookup, autocompleteLookup } from "../../page/kit/autocomplete-lookups"
import { MapleAuthApi, readSessionToken } from "../../platform/auth-api"
import { debugWarnings, toRunPoints } from "./derive"
import { Message, RequestMode, SubmittedInput, TimeSearch } from "./model"

/** The lab boots without the app root, so it resolves its own org from the stored session. */
export const CheckSession = Command.define("CheckQueryBuilderLabSession", {
	messages: [Message.SucceededCheckSession, Message.FailedCheckSession],
	execute: Effect.gen(function* () {
		const maybeToken = yield* readSessionToken
		if (Option.isNone(maybeToken)) return Message.FailedCheckSession({ session: "SignedOut" })
		const auth = yield* MapleAuthApi
		const tenant = yield* auth.session(maybeToken.value)
		return Message.SucceededCheckSession({ orgId: tenant.orgId })
	}).pipe(
		Effect.catchTag("@maple/web/SessionCheckError", (error) =>
			Effect.succeed(
				Message.FailedCheckSession({
					session: error.reason === "Rejected" ? "SignedOut" : "Unreachable",
				}),
			),
		),
	),
})

/** `useEffectiveTimeRange(search, preset)`: snapped on entry, unsnapped after Reload. */
export const ResolveWindow = Command.define("ResolveQueryBuilderLabWindow", {
	args: { search: TimeSearch, preset: Schema.String, timeZone: Schema.String, mode: RequestMode },
	messages: [Message.CompletedResolveWindow],
	execute: ({ search, preset, timeZone, mode }) =>
		Effect.map(currentWindow({ ...search, preset, timeZone, snap: mode === "Load" }), (window) =>
			Message.CompletedResolveWindow({ window, mode }),
		),
})

/** One `AutocompleteValuesProvider` lookup over the page's window. */
export const FetchAutocomplete = Command.define("FetchQueryBuilderLabAutocomplete", {
	args: { key: Schema.String, lookup: AutocompleteLookup, window: TimeWindow },
	messages: [Message.CompletedFetchAutocomplete],
	execute: ({ key, lookup, window }) =>
		autocompleteLookup(lookup, window).pipe(
			Effect.mapError(toLoadFailure),
			Effect.result,
			Effect.map((result) => Message.CompletedFetchAutocomplete({ key, lookup, result })),
		),
})

/** `listMetricsResultAtom({ data: { limit: 300 } })`. */
export const FetchMetrics = Command.define("FetchQueryBuilderLabMetrics", {
	args: { key: Schema.String },
	messages: [Message.CompletedFetchMetrics],
	execute: ({ key }) =>
		listMetrics({ data: { limit: 300 } }).pipe(
			Effect.map((response) =>
				response.data.map((row) => ({ metricName: row.metricName, metricType: row.metricType })),
			),
			Effect.mapError(toLoadFailure),
			Effect.result,
			Effect.map((result) => Message.CompletedFetchMetrics({ key, result })),
		),
})

/** `getQueryBuilderTimeseriesResultAtom({ data: submittedInput })`. */
export const FetchTimeseries = Command.define("FetchQueryBuilderLabTimeseries", {
	args: { key: Schema.String, input: SubmittedInput },
	messages: [Message.CompletedFetchTimeseries],
	execute: ({ key, input }) =>
		getQueryBuilderTimeseries({
			data: {
				startTime: input.startTime,
				endTime: input.endTime,
				queries: input.queries.map((query) => ({ ...query })),
				formulas: input.formulas.map((formula) => ({ ...formula })),
			},
		}).pipe(
			Effect.map((response) => ({
				points: toRunPoints(response.data),
				warnings: debugWarnings(response.diagnostics),
			})),
			Effect.mapError(toLoadFailure),
			Effect.result,
			Effect.map((result) => Message.CompletedFetchTimeseries({ key, result })),
		),
})

/** `PageRefreshProvider`'s Reload spin. */
export const CompleteReloadSpin = Command.define("CompleteQueryBuilderLabReloadSpin", {
	args: { version: Schema.Number },
	messages: [Message.CompletedReloadSpin],
	execute: ({ version }) =>
		Effect.as(Effect.sleep(Duration.millis(600)), Message.CompletedReloadSpin({ version })),
})

/** `createQueryDraft` draws a random id, so it runs here. */
export const CreateQuery = Command.define("CreateQueryBuilderLabQuery", {
	args: { index: Schema.Number },
	messages: [Message.CreatedQuery],
	execute: ({ index }) => Effect.sync(() => Message.CreatedQuery({ query: createQueryDraft(index) })),
})

export const CreateFormula = Command.define("CreateQueryBuilderLabFormula", {
	args: { index: Schema.Number, queryNames: Schema.Array(Schema.String) },
	messages: [Message.CreatedFormula],
	execute: ({ index, queryNames }) =>
		Effect.sync(() => Message.CreatedFormula({ formula: createFormulaDraft(index, [...queryNames]) })),
})

/** `cloneQuery`'s `crypto.randomUUID()`. */
export const CreateCloneId = Command.define("CreateQueryBuilderLabCloneId", {
	args: { queryId: Schema.String },
	messages: [Message.CreatedCloneId],
	execute: ({ queryId }) => Effect.sync(() => Message.CreatedCloneId({ queryId, id: crypto.randomUUID() })),
})

/** `setLastRunAt(new Date().toLocaleTimeString())`. */
export const StampRun = Command.define("StampQueryBuilderLabRun", {
	messages: [Message.StampedRun],
	execute: Effect.map(Clock.currentTimeMillis, (nowMs) =>
		Message.StampedRun({ at: new Date(nowMs).toLocaleTimeString() }),
	),
})

const viewportOf = (content: Element): Option.Option<HTMLElement> =>
	Option.fromNullishOr(content.closest<HTMLElement>("[data-slot=scroll-area-viewport]"))

/**
 * Base UI's `ScrollArea` measures its viewport on mount and whenever it or its content resizes.
 * Mounted on the content, the viewport's only child.
 */
export const MeasureScrollArea = Mount.defineStream("MeasureQueryBuilderLabScrollArea", {
	messages: [Message.MeasuredScroll],
	execute: ({ element }) =>
		Stream.callback<typeof Message.MeasuredScroll.Type>((queue) =>
			Effect.acquireRelease(
				Effect.sync(() => {
					const viewport = viewportOf(element)
					const observer = new ResizeObserver(() =>
						Option.map(viewport, (node) =>
							Queue.offerUnsafe(
								queue,
								Message.MeasuredScroll({
									metrics: {
										clientHeight: node.clientHeight,
										scrollHeight: node.scrollHeight,
									},
								}),
							),
						),
					)
					Option.map(viewport, (node) => observer.observe(node))
					observer.observe(element)
					return observer
				}),
				(observer) => Effect.sync(() => observer.disconnect()),
			).pipe(Effect.andThen(Effect.never)),
		),
})
