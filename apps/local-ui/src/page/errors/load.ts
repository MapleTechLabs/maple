import type { Resources } from "../../platform/resources"
import { boundsForRange, type TimeBounds } from "../../lib/time"
import { Array, Option, Record } from "effect"
import type { Command } from "foldkit"
import { idle, keyOf, request } from "../../data/slot"
import { queryOf } from "../../route"
import { type PageContext, rangeOf } from "../contract"
import { errorsFiltersOf, FetchByType, FetchFacets, FetchSummary, FetchTraces } from "./command"
import type { Message } from "./message"
import type { Card, Model } from "./model"

type Commands = ReadonlyArray<Command.Command<Message, never, Resources>>
type Step = Readonly<{ model: Model; commands?: Commands }>

export const boundsOf = (model: Model, context: PageContext): Option.Option<TimeBounds> =>
	Option.map(model.maybeAnchorMs, (anchorMs) => boundsForRange(rangeOf(context), anchorMs))

const boundsKey = (bounds: TimeBounds) => `${bounds.startTime}/${bounds.endTime}`

export const cardOf = (model: Model, fingerprintHash: string): Card =>
	Option.getOrElse(Record.get(model.cards, fingerprintHash), () => ({ isExpanded: false, traces: idle() }))

/** `useLocalErrorTraces` for one open card, under the view's filters and window. */
export const loadCard = (model: Model, context: PageContext, fingerprintHash: string, force = false): Step => {
	const card = cardOf(model, fingerprintHash)
	const maybeBounds = boundsOf(model, context)
	if (!card.isExpanded || Option.isNone(maybeBounds)) return { model }
	const bounds = maybeBounds.value
	const { rootOnly, service, env } = errorsFiltersOf(queryOf(context.location))
	const key = keyOf("error-traces", {
		fingerprintHash,
		rootOnly,
		service: service ?? null,
		env: env ?? null,
		bounds: boundsKey(bounds),
	})
	return Option.match(request(card.traces, key, force), {
		onNone: () => ({ model }),
		onSome: (traces) => ({
			model: { ...model, cards: Record.set(model.cards, fingerprintHash, { ...card, traces }) },
			commands: [
				FetchTraces({ key, fingerprintHash, search: context.location.search, ...bounds, apiBase: context.env.apiBase, readsCache: card.traces.key !== key }),
			],
		}),
	})
}

/** The summary, the error types and the facets, then every open card's traces. */
export const load = (model: Model, context: PageContext, force = false): Step =>
	Option.match(boundsOf(model, context), {
		onNone: () => ({ model }),
		onSome: (bounds) => {
			const filters = errorsFiltersOf(queryOf(context.location))
			const identity = { filters, bounds: boundsKey(bounds) }
			const args = { search: context.location.search, ...bounds, apiBase: context.env.apiBase }
			const summaryKey = keyOf("errors-summary", identity)
			const byTypeKey = keyOf("errors-by-type", identity)
			const facetsKey = keyOf("errors-facets", identity)
			const summary = request(model.summary, summaryKey, force)
			const byType = request(model.byType, byTypeKey, force)
			const facets = request(model.facets, facetsKey, force)
			const base: Step = {
				model: {
					...model,
					summary: Option.getOrElse(summary, () => model.summary),
					byType: Option.getOrElse(byType, () => model.byType),
					facets: Option.getOrElse(facets, () => model.facets),
				},
				commands: Array.getSomes([
					Option.map(summary, () => FetchSummary({ key: summaryKey, ...args, readsCache: model.summary.key !== summaryKey })),
					Option.map(byType, () => FetchByType({ key: byTypeKey, ...args, readsCache: model.byType.key !== byTypeKey })),
					Option.map(facets, () => FetchFacets({ key: facetsKey, ...args, readsCache: model.facets.key !== facetsKey })),
				]),
			}
			return Object.keys(model.cards).reduce<Step>((step, fingerprintHash) => {
				const card = loadCard(step.model, context, fingerprintHash, force)
				return { model: card.model, commands: [...(step.commands ?? []), ...(card.commands ?? [])] }
			}, base)
		},
	})
