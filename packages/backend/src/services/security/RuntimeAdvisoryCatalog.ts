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
import { Context, Effect, Layer, Ref, Schema } from "effect"
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
/** OSV reads per request; cached versions do not count, so a cold cache costs at most three rounds. */
const MAX_READS = 24
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

/** A version not in the cache once the request's read budget is spent; never cached. */
class RuntimeAdvisoryReadSkipped extends Schema.TaggedError<RuntimeAdvisoryReadSkipped>()(
	"@maple/security/RuntimeAdvisoryReadSkipped",
	{ message: Schema.String, key: Schema.String },
) {}

export interface RuntimeAdvisoryReadResult {
	/** Advisories per `advisoryKey`. A version whose read failed or was skipped is absent. */
	readonly advisories: Record<string, ReadonlyArray<RuntimeAdvisory>>
	/** Versions left unread because the request spent its read budget; a later request reads them. */
	readonly skipped: ReadonlyArray<string>
}

export interface RuntimeAdvisoryCatalogApi {
	/** Every cached version is served; at most `MAX_READS` misses are read, in `targets` order. */
	readonly advisories: (targets: ReadonlyArray<AdvisoryTarget>) => Effect.Effect<RuntimeAdvisoryReadResult>
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

		type Read =
			| {
					readonly _tag: "read"
					readonly key: string
					readonly value: ReadonlyArray<RuntimeAdvisory> | null
			  }
			| { readonly _tag: "skipped"; readonly key: string }

		const advisoriesFor = (target: AdvisoryTarget, budget: Ref.Ref<number>): Effect.Effect<Read> => {
			const key = advisoryKey(target)
			const name = OSV_RUNTIME_PACKAGES.get(target.product)
			if (name === undefined) return Effect.succeed({ _tag: "read", key, value: null })
			const spend = Ref.modify(budget, (left) => [left > 0, left - 1] as const).pipe(
				Effect.flatMap((allowed) =>
					allowed
						? Effect.void
						: Effect.fail(
								new RuntimeAdvisoryReadSkipped({
									message: `read budget spent for ${key}`,
									key,
								}),
							),
				),
			)
			return edgeCache
				.getOrCompute(
					{
						bucket: CACHE_BUCKET,
						key,
						ttlSeconds: (value) => (value === null ? FAILURE_TTL_SECONDS : CACHE_TTL_SECONDS),
						schema: CachedAdvisories,
						readTimeoutMs: CACHE_READ_TIMEOUT_MS,
					},
					spend.pipe(
						Effect.andThen(
							fetchAdvisories(target, name).pipe(
								Effect.tapError((error) =>
									Effect.logWarning("runtime advisory read failed", error),
								),
								Effect.orElseSucceed(() => null),
							),
						),
					),
				)
				.pipe(
					Effect.map((result): Read => ({ _tag: "read", key, value: result.value })),
					Effect.catchTag("@maple/security/RuntimeAdvisoryReadSkipped", () =>
						Effect.succeed<Read>({ _tag: "skipped", key }),
					),
				)
		}

		const advisories = Effect.fn("RuntimeAdvisoryCatalog.advisories")(function* (
			targets: ReadonlyArray<AdvisoryTarget>,
		) {
			const distinct = [...new Map(targets.map((target) => [advisoryKey(target), target])).values()]
			const budget = yield* Ref.make(MAX_READS)
			const reads = yield* Effect.forEach(distinct, (target) => advisoriesFor(target, budget), {
				concurrency: CONCURRENCY,
			})
			return {
				advisories: Object.fromEntries(
					reads.flatMap((read) =>
						read._tag === "read" && read.value !== null ? [[read.key, read.value] as const] : [],
					),
				),
				skipped: reads.flatMap((read) => (read._tag === "skipped" ? [read.key] : [])),
			} satisfies RuntimeAdvisoryReadResult
		})

		return { advisories } satisfies RuntimeAdvisoryCatalogApi
	}),
}) {
	static readonly layer = Layer.effect(this, this.make).pipe(Layer.provide(FetchHttpClient.layer))
}
