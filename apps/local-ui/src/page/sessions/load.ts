import type { Resources } from "../../platform/resources"
import { boundsForRange, type TimeBounds } from "../../lib/time"
import { Array, Option } from "effect"
import { AsyncData, type Command } from "foldkit"
import { keyOf, request } from "../../data/slot"
import { type PageContext, rangeOf } from "../contract"
import { queryOf } from "../../route"
import { FetchFacets, FetchSessions } from "./command"
import { filtersOf } from "./fetch"
import type { Message } from "./message"
import type { Model } from "./model"

/** The window the list, facets and refresh share: the range resolved at the anchor. */
export const boundsOf = (model: Model, context: PageContext): Option.Option<TimeBounds> =>
	Option.map(model.maybeAnchorMs, (anchorMs) => boundsForRange(rangeOf(context), anchorMs))

/** The cache key: `["local", name, filters, boundsKey(bounds)]`. */
const keyFor = (name: string, context: PageContext, bounds: TimeBounds): string =>
	keyOf(name, {
		filters: filtersOf(queryOf(context.location)),
		bounds: `${bounds.startTime}/${bounds.endTime}`,
	})

/** Requests what the current filters and window need; `force` refetches held keys (`invalidateQueries`). */
export const load = (
	model: Model,
	context: PageContext,
	force = false,
): Readonly<{ model: Model; commands?: ReadonlyArray<Command.Command<Message, never, Resources>> }> =>
	Option.match(boundsOf(model, context), {
		onNone: () => ({ model }),
		onSome: (bounds) => {
			const args = { search: context.location.search, ...bounds, apiBase: context.env.apiBase }
			const sessionsKey = keyFor("sessions", context, bounds)
			const pageCount = Option.match(AsyncData.getData(model.sessions.data), {
				onNone: () => 1,
				onSome: (data) =>
					force && model.sessions.key === sessionsKey ? Math.max(1, data.pages.length) : 1,
			})
			const sessions = request(model.sessions, sessionsKey, force)
			const facetsKey = keyFor("session-facets", context, bounds)
			const facets = request(model.facets, facetsKey, force)
			return {
				model: {
					...model,
					sessions: Option.getOrElse(sessions, () => model.sessions),
					facets: Option.getOrElse(facets, () => model.facets),
					isFetchingNextPage: Option.isSome(sessions) ? false : model.isFetchingNextPage,
					pageGeneration: Option.isSome(sessions) ? model.pageGeneration + 1 : model.pageGeneration,
				},
				commands: Array.getSomes([
					Option.map(sessions, () =>
						FetchSessions({
							key: sessionsKey,
							...args,
							pageCount,
							readsCache: model.sessions.key !== sessionsKey,
						}),
					),
					Option.map(facets, () =>
						FetchFacets({ key: facetsKey, ...args, readsCache: model.facets.key !== facetsKey }),
					),
				]),
			}
		},
	})

/** A cached result is on screen: fetch the real one (`readsCache: false`), unless it is fresh. */
export const fetchAfterCache = (
	model: Model,
	context: PageContext,
	which: "sessions" | "facets",
	isFresh: boolean,
): ReadonlyArray<Command.Command<Message, never, Resources>> =>
	isFresh
		? []
		: Option.match(boundsOf(model, context), {
				onNone: () => [],
				onSome: (bounds) => {
					const args = {
						key: model[which].key ?? "",
						search: context.location.search,
						...bounds,
						apiBase: context.env.apiBase,
						readsCache: false,
					}
					return [
						which === "sessions" ? FetchSessions({ ...args, pageCount: 1 }) : FetchFacets(args),
					]
				},
			})
