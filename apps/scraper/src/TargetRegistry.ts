import { Clock, Context, Effect, Layer, Option, Ref } from "effect"
import type { InternalScrapeTarget } from "@maple/domain/http"
import { ApiClient, type ApiRequestError } from "./ApiClient"

/** Loop identity: discovered sub-targets (PlanetScale branches) share one target id. */
export const targetKey = (target: InternalScrapeTarget): string => `${target.id}:${target.subTargetKey ?? ""}`

export interface TargetRegistryApi {
	/** Fetch the target list and make it current. A failure leaves the current list in place. */
	readonly refresh: Effect.Effect<ReadonlyMap<string, InternalScrapeTarget>, ApiRequestError>
	/** The latest config for a loop, or `none` once the target is gone. */
	readonly get: (key: string) => Effect.Effect<Option.Option<InternalScrapeTarget>>
	/** Epoch ms of the last successful refresh. */
	readonly lastRefreshAt: Effect.Effect<number | null>
}

/**
 * The one copy of the desired targets. Loops read their config here on every
 * scrape, so a rotated signed URL, credential, ingest key or interval applies
 * on the next scrape without restarting anything.
 */
export class TargetRegistry extends Context.Service<TargetRegistry, TargetRegistryApi>()(
	"@maple/scraper/TargetRegistry",
	{
		make: Effect.gen(function* () {
			const api = yield* ApiClient
			const targets = yield* Ref.make<ReadonlyMap<string, InternalScrapeTarget>>(new Map())
			const lastRefreshAt = yield* Ref.make<number | null>(null)

			const refresh = Effect.gen(function* () {
				const list = yield* api.listTargets()
				// Last row wins per key: duplicate rows must never become two loops.
				const deduped = new Map(list.map((target) => [targetKey(target), target]))
				const duplicates = list.length - deduped.size
				yield* Ref.set(targets, deduped)
				yield* Ref.set(lastRefreshAt, yield* Clock.currentTimeMillis)
				yield* Effect.annotateCurrentSpan("maple.scraper.duplicate_targets_dropped", duplicates)
				if (duplicates > 0) {
					yield* Effect.logWarning("Dropped duplicate scrape targets sharing one key").pipe(
						Effect.annotateLogs({
							duplicateTargetsDropped: duplicates,
							distinctTargets: deduped.size,
						}),
					)
				}
				return deduped
			})

			const get = (key: string) =>
				Effect.map(Ref.get(targets), (current) => Option.fromNullishOr(current.get(key)))

			return { refresh, get, lastRefreshAt: Ref.get(lastRefreshAt) } satisfies TargetRegistryApi
		}),
	},
) {
	static readonly layer = Layer.effect(this, this.make)
}
