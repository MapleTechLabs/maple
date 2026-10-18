import type { Resources } from "../../platform/resources"
import { boundsForRange, resolveRange, type TimeBounds } from "@maple/local-ui/lib/time"
import { buildSourceGraph, type SourceGraph } from "@maple/web-foldkit/service-map/map/graph"
import { Option } from "effect"
import type { Command } from "foldkit"
import { keyOf, request } from "../../data/slot"
import { type PageContext, rangeOf } from "../contract"
import { FetchServiceMap } from "./command"
import type { LocalServiceMapData } from "./fetch"
import type { Message } from "./message"
import type { Model } from "./model"

/** The window's logical length: rates divide by it, not by the clock-skew pad on the bounds. */
export const durationSecondsOf = (context: PageContext): number => resolveRange(rangeOf(context)).minutes * 60

export const boundsOf = (model: Model, context: PageContext): Option.Option<TimeBounds> =>
	Option.map(model.maybeAnchorMs, (anchorMs) => boundsForRange(rangeOf(context), anchorMs))

/** `buildGraph`: the flow graph and its focusable services from the rows. */
export const sourceGraphOf = (data: LocalServiceMapData, durationSeconds: number): SourceGraph =>
	buildSourceGraph({
		edges: [...data.edges],
		dbEdges: [...data.dbEdges],
		serviceOverviews: [...data.overviews],
		durationSeconds,
		platforms: new Map(data.platforms),
		runtimes: new Map(data.runtimes),
	})

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
					commands: [FetchServiceMap({ key, ...bounds, durationSeconds, apiBase: context.env.apiBase })],
				}),
			})
		},
	})
