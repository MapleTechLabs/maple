import type { Resources } from "../../platform/resources"
import { boundsForRange, resolveRange, type TimeBounds } from "../../lib/time"
import { buildSourceGraph, type SourceGraph } from "@maple/web/service-map/map/graph"
import { Option } from "effect"
import type { Command } from "foldkit"
import { keyOf, request } from "../../data/slot"
import { type PageContext, rangeOf } from "../contract"
import { FetchServiceMap } from "./command"
import { graphRowsOf, type LocalServiceMapData } from "./data"
import type { Message } from "./message"
import type { Model } from "./model"

/** The window's logical length: rates divide by it, not by the clock-skew pad on the bounds. */
export const durationSecondsOf = (context: PageContext): number => resolveRange(rangeOf(context)).minutes * 60

export const boundsOf = (model: Model, context: PageContext): Option.Option<TimeBounds> =>
	Option.map(model.maybeAnchorMs, (anchorMs) => boundsForRange(rangeOf(context), anchorMs))

/** `buildGraph`: the flow graph and its focusable services from the rows. */
export const sourceGraphOf = (data: LocalServiceMapData, durationSeconds: number): SourceGraph =>
	buildSourceGraph({ ...graphRowsOf(data), durationSeconds })

/** Requests the map for the current window (`["local", "service-map", durationSeconds, boundsKey]`). */
export const load = (
	model: Model,
	context: PageContext,
	force = false,
): Readonly<{ model: Model; commands?: ReadonlyArray<Command.Command<Message, never, Resources>> }> =>
	Option.match(boundsOf(model, context), {
		onNone: () => ({ model }),
		onSome: (bounds) => {
			const durationSeconds = durationSecondsOf(context)
			const key = keyOf("service-map", { durationSeconds, bounds: `${bounds.startTime}/${bounds.endTime}` })
			return Option.match(request(model.data, key, force), {
				onNone: () => ({ model }),
				onSome: (data) => ({
					model: { ...model, data },
					// A new window reads the cache first; a refetch of the same one goes to the server.
					commands: [
						FetchServiceMap({ key, ...bounds, durationSeconds, apiBase: context.env.apiBase, readsCache: model.data.key !== key }),
					],
				}),
			})
		},
	})
