import { boundsForRange, type TimeBounds } from "../../lib/time"
import { Array, Option } from "effect"
import { AsyncData } from "foldkit"
import { keyOf, request, type Slot } from "../../data/slot"
import { queryOf } from "../../route"
import { type PageContext, rangeOf } from "../contract"
import { FetchCatalog, type ServicesCommand } from "./command"
import { activeFilterCount, filtersOf } from "./derive"
import type { Catalog, Model } from "./model"

export const boundsOf = (model: Model, context: PageContext): Option.Option<TimeBounds> =>
	Option.map(model.maybeAnchorMs, (anchorMs) => boundsForRange(rangeOf(context), anchorMs))

/** `["local", "services", "catalog", env, ns, boundsKey(bounds)]`. */
const catalogKey = (env: string | undefined, ns: string | undefined, bounds: TimeBounds): string =>
	keyOf("services-catalog", { env: env ?? null, ns: ns ?? null, bounds: `${bounds.startTime}/${bounds.endTime}` })

type Step = Readonly<{ slot: Slot<Catalog>; fetch: boolean; readsCache: boolean }>

/**
 * One slot onto `key`: unchanged when it holds it, served from the result cache when the
 * other slot already has that key's rows, else a fetch (or a forced refetch).
 */
const stepSlot = (slot: Slot<Catalog>, key: string, cache: ReadonlyArray<Slot<Catalog>>, force: boolean): Step => {
	const cached = cache.find((other) => other.key === key && Option.isSome(AsyncData.getData(other.data)))
	if (!force && slot.key !== key && cached !== undefined) return { slot: cached, fetch: false, readsCache: false }
	return Option.match(request(slot, key, force), {
		onNone: () => ({ slot, fetch: false, readsCache: false }),
		onSome: (next) => ({ slot: next, fetch: true, readsCache: slot.key !== key }),
	})
}

export const load = (
	model: Model,
	context: PageContext,
	force = false,
): Readonly<{ model: Model; commands?: ReadonlyArray<ServicesCommand> }> =>
	Option.match(boundsOf(model, context), {
		onNone: () => ({ model }),
		onSome: (bounds) => {
			const filters = filtersOf(queryOf(context.location))
			const args = { ...bounds, apiBase: context.env.apiBase }
			const cache = [model.catalog, model.unfiltered]
			const filteredKey = catalogKey(filters.env, filters.ns, bounds)
			const rows = stepSlot(model.catalog, filteredKey, cache, force)
			// With no filter both hooks read one key: the rows slot serves the facets.
			const isFiltered = activeFilterCount(filters) > 0
			const unfilteredKey = catalogKey(undefined, undefined, bounds)
			const facets = isFiltered ? stepSlot(model.unfiltered, unfilteredKey, cache, force) : { slot: model.unfiltered, fetch: false, readsCache: false }
			return {
				model: { ...model, catalog: rows.slot, unfiltered: facets.slot },
				commands: Array.getSomes([
					rows.fetch
						? Option.some(FetchCatalog({ key: filteredKey, env: filters.env ?? null, ns: filters.ns ?? null, ...args, readsCache: rows.readsCache }))
						: Option.none(),
					facets.fetch ? Option.some(FetchCatalog({ key: unfilteredKey, env: null, ns: null, ...args, readsCache: facets.readsCache })) : Option.none(),
				]),
			}
		},
	})
