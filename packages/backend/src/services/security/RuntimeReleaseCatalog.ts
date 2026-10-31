import { EdgeCacheService } from "@maple/cache"
import { RUNTIME_PRODUCTS, type RuntimeProduct, type RuntimeRelease } from "@maple/domain/runtime-posture"
import { Context, Effect, Layer, Option, Schema } from "effect"
import { FetchHttpClient, HttpClient, HttpClientResponse } from "effect/http"

// Release cycles for the Security Center's Runtimes tab, read from endoflife.date. One read per
// runtime a day; a runtime whose read fails is left out, so the tab says "unavailable" for it.

const CACHE_BUCKET = "runtime-releases"
const CACHE_TTL_SECONDS = 24 * 60 * 60
const CACHE_READ_TIMEOUT_MS = 150
const REQUEST_TIMEOUT = "5 seconds"

const EndoflifeProduct = Schema.Struct({
	result: Schema.Struct({
		releases: Schema.Array(
			Schema.Struct({
				name: Schema.String,
				isEol: Schema.NullOr(Schema.Boolean),
				eolFrom: Schema.NullOr(Schema.String),
				latest: Schema.NullOr(Schema.Struct({ name: Schema.String })),
			}),
		),
	}),
})

const CachedReleases = Schema.Array(
	Schema.Struct({
		cycle: Schema.String,
		isEol: Schema.Boolean,
		eolFrom: Schema.NullOr(Schema.String),
		latest: Schema.NullOr(Schema.String),
	}),
)

export class RuntimeReleaseCatalogError extends Schema.TaggedError<RuntimeReleaseCatalogError>()(
	"@maple/security/RuntimeReleaseCatalogError",
	{ message: Schema.String, product: Schema.String, cause: Schema.Defect() },
) {}

export interface RuntimeReleaseCatalogApi {
	/** Release cycles per product. A product whose read failed is absent. */
	readonly releases: (
		products: ReadonlyArray<RuntimeProduct>,
	) => Effect.Effect<Partial<Record<RuntimeProduct, ReadonlyArray<RuntimeRelease>>>>
}

export class RuntimeReleaseCatalog extends Context.Service<RuntimeReleaseCatalog, RuntimeReleaseCatalogApi>()(
	"@maple/backend/services/security/RuntimeReleaseCatalog",
	{
		make: Effect.gen(function* () {
			const edgeCache = yield* EdgeCacheService
			const httpClient = (yield* HttpClient.HttpClient).pipe(HttpClient.filterStatusOk)

			const fetchReleases = (product: RuntimeProduct) =>
				httpClient
					.get(`https://endoflife.date/api/v1/products/${RUNTIME_PRODUCTS[product].endoflifeSlug}`)
					.pipe(
						Effect.flatMap(HttpClientResponse.schemaBodyJson(EndoflifeProduct)),
						Effect.timeout(REQUEST_TIMEOUT),
						Effect.map((body): ReadonlyArray<RuntimeRelease> =>
							body.result.releases.map((release) => ({
								cycle: release.name,
								isEol: release.isEol === true,
								eolFrom: release.eolFrom,
								latest: release.latest?.name ?? null,
							})),
						),
						Effect.mapError(
							(cause) =>
								new RuntimeReleaseCatalogError({
									message: `endoflife.date read failed for ${product}`,
									product,
									cause,
								}),
						),
					)

			const releasesFor = (product: RuntimeProduct) =>
				edgeCache
					.getOrCompute(
						{
							bucket: CACHE_BUCKET,
							key: product,
							ttlSeconds: CACHE_TTL_SECONDS,
							schema: CachedReleases,
							readTimeoutMs: CACHE_READ_TIMEOUT_MS,
						},
						fetchReleases(product),
					)
					.pipe(
						Effect.map((result) => Option.some([product, result.value] as const)),
						Effect.tapError((error) =>
							Effect.logWarning("runtime release catalog read failed", error),
						),
						Effect.orElseSucceed(() => Option.none()),
					)

			const releases = Effect.fn("RuntimeReleaseCatalog.releases")(function* (
				products: ReadonlyArray<RuntimeProduct>,
			) {
				const read = yield* Effect.forEach(new Set(products), releasesFor, { concurrency: 4 })
				return Object.fromEntries(read.flatMap(Option.toArray))
			})

			return { releases } satisfies RuntimeReleaseCatalogApi
		}),
	},
) {
	static readonly layer = Layer.effect(this, this.make).pipe(Layer.provide(FetchHttpClient.layer))
}
