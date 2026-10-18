import type { Resources } from "../../platform/resources"
import { boundsForRange, type TimeBounds } from "@maple/local-ui/lib/time"
import { Array, Option } from "effect"
import { AsyncData, type Command } from "foldkit"
import { keyOf, request } from "../../data/slot"
import { queryOf } from "../../route"
import { type PageContext, rangeOf } from "../contract"
import { FetchLogs, FetchPatterns, FetchServices, FetchSeverities } from "./command"
import { filtersOf, modeOf } from "./filters"
import type { Message } from "./message"
import type { Model } from "./model"

export const boundsOf = (model: Model, context: PageContext): Option.Option<TimeBounds> =>
	Option.map(model.maybeAnchorMs, (anchorMs) => boundsForRange(rangeOf(context), anchorMs))

const boundsKey = (bounds: TimeBounds) => `${bounds.startTime}/${bounds.endTime}`

/**
 * What the filters, mode and window need: the facets, and the active mode's query only (each mode
 * is its own component in legacy, so only its query runs). `force` refetches as invalidation does.
 */
export const load = (
	model: Model,
	context: PageContext,
	force = false,
): Readonly<{ model: Model; commands?: ReadonlyArray<Command.Command<Message, never, Resources>> }> =>
	Option.match(boundsOf(model, context), {
		onNone: () => ({ model }),
		onSome: (bounds) => {
			const filters = filtersOf(queryOf(context.location))
			const isPatterns = modeOf(queryOf(context.location)) === "patterns"
			const args = { search: context.location.search, ...bounds, apiBase: context.env.apiBase }
			const window = boundsKey(bounds)
			const logsKey = keyOf("logs", { filters, window })
			const pageCount = Option.match(AsyncData.getData(model.logs.data), {
				onNone: () => 1,
				onSome: (data) => (force && model.logs.key === logsKey ? Math.max(1, data.pages.length) : 1),
			})
			const logs = isPatterns ? Option.none() : request(model.logs, logsKey, force)
			const patternsKey = keyOf("log-patterns", { filters, window })
			const patterns = isPatterns ? request(model.patterns, patternsKey, force) : Option.none()
			const servicesKey = keyOf("log-services", { severity: filters.severity ?? null, search: filters.search ?? null, window })
			const services = request(model.services, servicesKey, force)
			const severitiesKey = keyOf("log-severities", { service: filters.service ?? null, search: filters.search ?? null, window })
			const severities = request(model.severities, severitiesKey, force)
			return {
				model: {
					...model,
					logs: Option.getOrElse(logs, () => model.logs),
					patterns: Option.getOrElse(patterns, () => model.patterns),
					services: Option.getOrElse(services, () => model.services),
					severities: Option.getOrElse(severities, () => model.severities),
					isFetchingNextPage: Option.isSome(logs) ? false : model.isFetchingNextPage,
				},
				commands: Array.getSomes([
					Option.map(logs, () => FetchLogs({ key: logsKey, ...args, pageCount })),
					Option.map(patterns, () => FetchPatterns({ key: patternsKey, ...args })),
					Option.map(services, () => FetchServices({ key: servicesKey, ...args })),
					Option.map(severities, () => FetchSeverities({ key: severitiesKey, ...args })),
				]),
			}
		},
	})
