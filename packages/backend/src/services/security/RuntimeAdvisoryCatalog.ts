import { EdgeCacheService } from "@maple/cache"
import { RuntimeAdvisoryRow } from "@maple/domain/http"
import {
	type AdvisoryTarget,
	advisoryKey,
	fixedVersionFor,
	lowestVersion,
	OSV_RUNTIME_ECOSYSTEM,
	OSV_RUNTIME_PACKAGES,
	type RuntimeAdvisory,
	severityOf,
	sortAdvisories,
} from "@maple/domain/runtime-advisories"
import { Context, Effect, Layer, Option, Schema } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http"

// Known vulnerabilities per runtime version for the Security Center's Runtimes tab, read from
// OSV.dev. One read per runtime version a day; a version whose read fails is left out.

const CACHE_BUCKET = "runtime-advisories"
const CACHE_TTL_SECONDS = 24 * 60 * 60
/** A failed read is remembered briefly, so an outage costs one timeout per version, not one per request. */
const FAILURE_TTL_SECONDS = 10 * 60
const CACHE_READ_TIMEOUT_MS = 150
const REQUEST_TIMEOUT = "3 seconds"
const SUMMARY_MAX_LENGTH = 160
/** Distinct versions read per request, so a cold cache costs at most three rounds of reads. */
const MAX_TARGETS = 24
const CONCURRENCY = 8

const OsvEvent = Schema.Struct({
	introduced: Schema.optionalKey(Schema.String),
	fixed: Schema.optionalKey(Schema.String),
})

const OsvQueryResponse = Schema.Struct({
	vulns: Schema.optionalKey(
		Schema.Array(
			Schema.Struct({
				id: Schema.String,
				aliases: Schema.optionalKey(Schema.Array(Schema.String)),
				summary: Schema.optionalKey(Schema.String),
				details: Schema.optionalKey(Schema.String),
				published: Schema.optionalKey(Schema.String),
				database_specific: Schema.optionalKey(
					Schema.Struct({ severity: Schema.optionalKey(Schema.String) }),
				),
				affected: Schema.optionalKey(
					Schema.Array(
						Schema.Struct({
							ranges: Schema.optionalKey(
								Schema.Array(Schema.Struct({ events: Schema.Array(OsvEvent) })),
							),
						}),
					),
				),
			}),
		),
	),
})
type OsvVuln = NonNullable<typeof OsvQueryResponse.Type.vulns>[number]

/** `null` records a failed read. */
const CachedAdvisories = Schema.NullOr(Schema.Array(RuntimeAdvisoryRow))

export class RuntimeAdvisoryCatalogError extends Schema.TaggedError<RuntimeAdvisoryCatalogError>()(
	"@maple/security/RuntimeAdvisoryCatalogError",
	{ message: Schema.String, key: Schema.String, cause: Schema.Defect() },
) {}

/** Many advisories carry no summary, only details: their first sentence stands in, capped. */
const summaryOf = (vuln: OsvVuln): string | null => {
	const text = (vuln.summary ?? vuln.details?.split(/(?<=\.)\s/)[0] ?? "").trim()
	if (text === "") return null
	return text.length > SUMMARY_MAX_LENGTH ? `${text.slice(0, SUMMARY_MAX_LENGTH - 1).trimEnd()}…` : text
}

const toAdvisory = (vuln: OsvVuln, version: string): RuntimeAdvisory => {
	const fixes = (vuln.affected ?? [])
		.flatMap((affected) => affected.ranges ?? [])
		.flatMap((range) => {
			const fixed = fixedVersionFor(range.events, version)
			return fixed === null ? [] : [fixed]
		})
	return {
		id: vuln.aliases?.find((alias) => alias.startsWith("CVE-")) ?? vuln.id,
		osvId: vuln.id,
		summary: summaryOf(vuln),
		severity: severityOf(vuln.database_specific?.severity),
		fixedIn: lowestVersion(fixes),
		published: vuln.published ?? null,
	}
}

export interface RuntimeAdvisoryCatalogApi {
	/** Advisories per `advisoryKey`, for the first `MAX_TARGETS` distinct versions in priority order. A version whose read failed is absent. */
	readonly advisories: (
		targets: ReadonlyArray<AdvisoryTarget>,
	) => Effect.Effect<Record<string, ReadonlyArray<RuntimeAdvisory>>>
}

export class RuntimeAdvisoryCatalog extends Context.Service<
	RuntimeAdvisoryCatalog,
	RuntimeAdvisoryCatalogApi
>()("@maple/backend/services/security/RuntimeAdvisoryCatalog", {
	make: Effect.gen(function* () {
		const edgeCache = yield* EdgeCacheService
		const httpClient = (yield* HttpClient.HttpClient).pipe(HttpClient.filterStatusOk)

		const fetchAdvisories = (target: AdvisoryTarget, name: string) =>
			HttpClientRequest.post("https://api.osv.dev/v1/query").pipe(
				HttpClientRequest.bodyJsonUnsafe({
					package: { name, ecosystem: OSV_RUNTIME_ECOSYSTEM },
					version: target.version,
				}),
				httpClient.execute,
				Effect.flatMap(HttpClientResponse.schemaBodyJson(OsvQueryResponse)),
				Effect.timeout(REQUEST_TIMEOUT),
				Effect.map((body) =>
					sortAdvisories((body.vulns ?? []).map((vuln) => toAdvisory(vuln, target.version))),
				),
				Effect.mapError(
					(cause) =>
						new RuntimeAdvisoryCatalogError({
							message: `OSV read failed for ${advisoryKey(target)}`,
							key: advisoryKey(target),
							cause,
						}),
				),
				Effect.withSpan("osv.query", {
					kind: "client",
					attributes: {
						"peer.service": "osv.dev",
						"maple.runtime.product": target.product,
						"maple.runtime.version": target.version,
					},
				}),
			)

		const advisoriesFor = (target: AdvisoryTarget) => {
			const key = advisoryKey(target)
			const name = OSV_RUNTIME_PACKAGES.get(target.product)
			if (name === undefined) return Effect.succeed(Option.none())
			return edgeCache
				.getOrCompute(
					{
						bucket: CACHE_BUCKET,
						key,
						ttlSeconds: (value) => (value === null ? FAILURE_TTL_SECONDS : CACHE_TTL_SECONDS),
						schema: CachedAdvisories,
						readTimeoutMs: CACHE_READ_TIMEOUT_MS,
					},
					fetchAdvisories(target, name).pipe(
						Effect.tapError((error) => Effect.logWarning("runtime advisory read failed", error)),
						Effect.orElseSucceed(() => null),
					),
				)
				.pipe(
					Effect.map((result) =>
						result.value === null ? Option.none() : Option.some([key, result.value] as const),
					),
					// A cache error falls back to the read; only a failed read leaves the version out.
					Effect.catch(() =>
						fetchAdvisories(target, name).pipe(
							Effect.map((value) => Option.some([key, value] as const)),
							Effect.orElseSucceed(() => Option.none()),
						),
					),
				)
		}

		const advisories = Effect.fn("RuntimeAdvisoryCatalog.advisories")(function* (
			targets: ReadonlyArray<AdvisoryTarget>,
		) {
			const distinct = [...new Map(targets.map((target) => [advisoryKey(target), target])).values()]
			const read = yield* Effect.forEach(distinct.slice(0, MAX_TARGETS), advisoriesFor, {
				concurrency: CONCURRENCY,
			})
			return Object.fromEntries(read.flatMap(Option.toArray))
		})

		return { advisories } satisfies RuntimeAdvisoryCatalogApi
	}),
}) {
	static readonly layer = Layer.effect(this, this.make).pipe(Layer.provide(FetchHttpClient.layer))
}
