import { boundsForRange, type TimeBounds } from "../../lib/time"
import { Array, Option } from "effect"
import { AsyncData } from "foldkit"
import { keyOf, request } from "../../data/slot"
import { type PageContext, rangeOf } from "../contract"
import { queryOf } from "../../route"
import { FetchFacets, FetchTraces, type TracesCommand } from "./command"
import { filtersOf } from "./filters"
import type { Model } from "./model"

/** The window the list, facets and refresh share: the range resolved at the anchor. */
export const boundsOf = (model: Model, context: PageContext): Option.Option<TimeBounds> =>
	Option.map(model.maybeAnchorMs, (anchorMs) => boundsForRange(rangeOf(context), anchorMs))

/** The cache key: `["local", name, filters, boundsKey(bounds)]`. */
const keyFor = (name: string, context: PageContext, bounds: TimeBounds): string =>
	keyOf(name, { filters: filtersOf(queryOf(context.location)), bounds: `${bounds.startTime}/${bounds.endTime}` })

/** A cached result is on screen: fetch the real one (`readsCache: false`), unless it is fresh. */
export const fetchAfterCache = (
	model: Model,
	context: PageContext,
	which: "traces" | "facets",
	isFresh: boolean,
): ReadonlyArray<TracesCommand> =>
	isFresh
		? []
		: Option.match(boundsOf(model, context), {
				onNone: () => [],
				onSome: (bounds) => {
					const args = { search: context.location.search, ...bounds, apiBase: context.env.apiBase, readsCache: false }
					const key = model[which].key ?? ""
					return [which === "traces" ? FetchTraces({ key, ...args, pageCount: 1 }) : FetchFacets({ key, ...args })]
				},
			})

/**
 * Requests whatever the current filters and window need: the list (and the facets, root scope
 * only). `force` refetches keys already held, as `invalidateQueries` does.
 */
export const load = (
	model: Model,
	context: PageContext,
	force = false,
): Readonly<{ model: Model; commands?: ReadonlyArray<TracesCommand> }> =>
	Option.match(boundsOf(model, context), {
		onNone: () => ({ model }),
		onSome: (bounds) => {
			const args = { search: context.location.search, ...bounds, apiBase: context.env.apiBase }
			const spanScope = filtersOf(queryOf(context.location)).scope === "spans"
			const tracesKey = keyFor("traces", context, bounds)
			const pageCount = Option.match(AsyncData.getData(model.traces.data), {
				onNone: () => 1,
				onSome: (data) => (force && model.traces.key === tracesKey ? Math.max(1, data.pages.length) : 1),
			})
			const traces = request(model.traces, tracesKey, force)
			const facetsKey = keyFor("trace-facets", context, bounds)
			const facets = spanScope ? Option.none() : request(model.facets, facetsKey, force)
			return {
				model: {
					...model,
					traces: Option.getOrElse(traces, () => model.traces),
					facets: Option.getOrElse(facets, () => model.facets),
					isFetchingNextPage: Option.isSome(traces) ? false : model.isFetchingNextPage,
					pageGeneration: Option.isSome(traces) ? model.pageGeneration + 1 : model.pageGeneration,
				},
				commands: Array.getSomes([
					Option.map(traces, () => FetchTraces({ key: tracesKey, ...args, pageCount, readsCache: model.traces.key !== tracesKey })),
					Option.map(facets, () => FetchFacets({ key: facetsKey, ...args, readsCache: model.facets.key !== facetsKey })),
				]),
			}
		},
	})
