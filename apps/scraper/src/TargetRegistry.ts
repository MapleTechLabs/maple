import { type Array as Arr, Clock, Context, Effect, Layer, Option, Ref } from "effect"
import type { InternalScrapeTarget } from "@maple/domain/http"
import { ApiClient, type ApiRequestError } from "./ApiClient"

/** Sub-target identity: discovered sub-targets (PlanetScale branches) share one target id. */
export const targetKey = (target: InternalScrapeTarget): string => `${target.id}:${target.subTargetKey ?? ""}`

/** A parent target's sub-targets, one per `subTargetKey`. Plain targets have exactly one. */
export type TargetGroup = Arr.NonEmptyReadonlyArray<InternalScrapeTarget>

/** Group rows by parent target id, last row winning per sub-target key. */
export const groupTargets = (list: ReadonlyArray<InternalScrapeTarget>): ReadonlyMap<string, TargetGroup> => {
	const deduped = new Map(list.map((target) => [targetKey(target), target]))
	const groups = new Map<string, TargetGroup>()
	deduped.forEach((target) => {
		const existing = groups.get(target.id)
		groups.set(target.id, existing === undefined ? [target] : [...existing, target])
	})
	return groups
}

export interface TargetRegistryApi {
	/** Fetch the target list and make it current. A failure leaves the current list in place. */
	readonly refresh: Effect.Effect<ReadonlyMap<string, TargetGroup>, ApiRequestError>
	/** The latest sub-targets of a parent loop, or `none` once the target is gone. */
	readonly get: (id: string) => Effect.Effect<Option.Option<TargetGroup>>
	/** Epoch ms of the last successful refresh. */
	readonly lastRefreshAt: Effect.Effect<number | null>
}

/**
 * The one copy of the desired targets. Loops read their config here on every
 * cycle, so a rotated signed URL, credential, ingest key, interval or a new
 * discovered branch applies on the next cycle without restarting anything.
 */
export class TargetRegistry extends Context.Service<TargetRegistry, TargetRegistryApi>()(
	"@maple/scraper/TargetRegistry",
	{
		make: Effect.gen(function* () {
			const api = yield* ApiClient
			const targets = yield* Ref.make<ReadonlyMap<string, TargetGroup>>(new Map())
			const lastRefreshAt = yield* Ref.make<number | null>(null)

			const refresh = Effect.gen(function* () {
				const list = yield* api.listTargets()
				// Last row wins per sub-target: duplicate rows must never scrape twice.
				const groups = groupTargets(list)
				const distinct = Array.from(groups.values()).reduce((total, group) => total + group.length, 0)
				const duplicates = list.length - distinct
				yield* Ref.set(targets, groups)
				yield* Ref.set(lastRefreshAt, yield* Clock.currentTimeMillis)
				yield* Effect.annotateCurrentSpan("maple.scraper.duplicate_targets_dropped", duplicates)
				if (duplicates > 0) {
					yield* Effect.logWarning("Dropped duplicate scrape targets sharing one key").pipe(
						Effect.annotateLogs({
							duplicateTargetsDropped: duplicates,
							distinctTargets: distinct,
						}),
					)
				}
				return groups
			})

			const get = (id: string) =>
				Effect.map(Ref.get(targets), (current) => Option.fromNullishOr(current.get(id)))

			return { refresh, get, lastRefreshAt: Ref.get(lastRefreshAt) } satisfies TargetRegistryApi
		}),
	},
) {
	static readonly layer = Layer.effect(this, this.make)
}
