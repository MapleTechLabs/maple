import type { Resources } from "../../platform/resources"
import { boundsForRange, type TimeBounds } from "../../lib/time"
import { Array, Option } from "effect"
import { AsyncData, type Command } from "foldkit"
import { keyOf, request } from "../../data/slot"
import { queryOf } from "../../route"
import { type PageContext, rangeOf } from "../contract"
import { FetchList, FetchSparklines, FetchSummary } from "./command"
import { sparklineGroups, sparklineWindow } from "./derive"
import type { Message } from "./message"
import type { Model } from "./model"

type Step = Readonly<{ model: Model; commands?: ReadonlyArray<Command.Command<Message, never, Resources>> }>

export const boundsOf = (model: Model, context: PageContext): Option.Option<TimeBounds> =>
	Option.map(model.maybeAnchorMs, (anchorMs) => boundsForRange(rangeOf(context), anchorMs))

const boundsKey = (bounds: TimeBounds) => `${bounds.startTime}/${bounds.endTime}`

/** The view's filters: service (client-side), type and the search (server-side). */
export const metricsFilters = (context: PageContext) => {
	const query = queryOf(context.location)
	return {
		service: query.get("service") || undefined,
		type: query.get("type") || undefined,
		search: query.get("q") || undefined,
	}
}

/**
 * `useLocalMetricsSparklines`: keyed by the listed metrics (the placeholder's while a new list
 * loads), the chart bucket and the window; nothing to ask for an empty list.
 */
export const loadSparklines = (model: Model, context: PageContext, force = false): Step =>
	Option.match(
		Option.zipWith(boundsOf(model, context), AsyncData.getData(model.list.data), (bounds, data) => ({
			bounds,
			data,
		})),
		{
			onNone: () => ({ model }),
			onSome: ({ bounds, data }) => {
				const groups = sparklineGroups(data.entries)
				if (groups.length === 0) return { model }
				const { bucketSeconds } = sparklineWindow(data.entries, bounds, model.nowMs)
				const key = keyOf("metrics-sparklines", { groups, bucketSeconds, bounds: boundsKey(bounds) })
				return Option.match(request(model.sparklines, key, force), {
					onNone: () => ({ model }),
					onSome: (sparklines) => ({
						model: { ...model, sparklines },
						commands: [
							FetchSparklines({
								key,
								groups,
								bucketSeconds,
								...bounds,
								apiBase: context.env.apiBase,
								readsCache: model.sparklines.key !== key,
							}),
						],
					}),
				})
			},
		},
	)

/** The list and the summary for the current filters and window, then the sparklines. */
export const load = (model: Model, context: PageContext, force = false): Step =>
	Option.match(boundsOf(model, context), {
		onNone: () => ({ model }),
		onSome: (bounds) => {
			const { service, type, search } = metricsFilters(context)
			const apiBase = context.env.apiBase
			const listKey = keyOf("metrics-list", {
				type: type ?? null,
				search: search ?? null,
				bounds: boundsKey(bounds),
			})
			const summaryKey = keyOf("metrics-summary", {
				service: service ?? null,
				bounds: boundsKey(bounds),
			})
			const list = request(model.list, listKey, force)
			const summary = request(model.summary, summaryKey, force)
			const next = {
				...model,
				list: Option.getOrElse(list, () => model.list),
				summary: Option.getOrElse(summary, () => model.summary),
			}
			const sparklines = loadSparklines(next, context, force)
			return {
				model: sparklines.model,
				commands: [
					...Array.getSomes([
						Option.map(list, () =>
							FetchList({
								key: listKey,
								type,
								search,
								...bounds,
								apiBase,
								readsCache: model.list.key !== listKey,
							}),
						),
						Option.map(summary, () =>
							FetchSummary({
								key: summaryKey,
								service,
								...bounds,
								apiBase,
								readsCache: model.summary.key !== summaryKey,
							}),
						),
					]),
					...(sparklines.commands ?? []),
				],
			}
		},
	})
