import { EdgeCacheService } from "@maple/cache"
import { type PackageAdvisory, type PackageRef, packageKey } from "@maple/domain/package-advisories"
import { Array as Arr, Context, Effect, Layer, Schedule, Schema } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http"
import { advisoriesOf, OsvRecord, OsvVulnResponse, toOsvRecord } from "./osv-records"

// Known vulnerabilities per locked package version for the dependency scanner, read from OSV.dev.
// A scan sends every package through `querybatch` (ids only) and reads each vulnerability once,
// cached by id and modification time, which never changes for a given pair.

const OSV_API = "https://api.osv.dev/v1"
/** OSV's cap on queries per `querybatch` call. */
const BATCH_SIZE = 1000
const CACHE_BUCKET = "osv-vulns"
const CACHE_TTL_SECONDS = 7 * 24 * 60 * 60
const CACHE_READ_TIMEOUT_MS = 150
const REQUEST_TIMEOUT = "15 seconds"
/** Distinct vulnerabilities read per call; a scan past it fails rather than store a partial answer. */
export const MAX_VULNERABILITIES = 500
const CONCURRENCY = 16
const RETRY = { times: 2, schedule: Schedule.exponential("250 millis") } as const

const QueryBatchResponse = Schema.Struct({
	results: Schema.Array(
		Schema.Struct({
			vulns: Schema.optionalKey(
				Schema.Array(Schema.Struct({ id: Schema.String, modified: Schema.String })),
			),
			next_page_token: Schema.optionalKey(Schema.String),
		}),
	),
})

interface VulnRef {
	readonly id: string
	readonly modified: string
}

export class PackageAdvisoryCatalogError extends Schema.TaggedError<PackageAdvisoryCatalogError>()(
	"@maple/security/PackageAdvisoryCatalogError",
	{ message: Schema.String, cause: Schema.Defect() },
) {}

export interface PackageAdvisoryCatalogApi {
	/**
	 * Advisories per `packageKey`; packages without any are absent. Fails as a whole when any read
	 * fails, so a scan never mistakes an outage for a clean dependency.
	 */
	readonly advisories: (
		packages: ReadonlyArray<PackageRef>,
	) => Effect.Effect<ReadonlyMap<string, ReadonlyArray<PackageAdvisory>>, PackageAdvisoryCatalogError>
}

interface Pending {
	readonly ref: PackageRef
	readonly pageToken?: string
}

interface Page {
	readonly ref: PackageRef
	readonly vulns: ReadonlyArray<VulnRef>
	readonly nextPageToken: string | undefined
}

export class PackageAdvisoryCatalog extends Context.Service<
	PackageAdvisoryCatalog,
	PackageAdvisoryCatalogApi
>()("@maple/backend/services/security/PackageAdvisoryCatalog", {
	make: Effect.gen(function* () {
		const edgeCache = yield* EdgeCacheService
		const httpClient = (yield* HttpClient.HttpClient).pipe(HttpClient.filterStatusOk)

		const catalogError = (message: string) => (cause: unknown) =>
			new PackageAdvisoryCatalogError({ message, cause })

		const queryBatch = (
			batch: ReadonlyArray<Pending>,
		): Effect.Effect<ReadonlyArray<Page>, PackageAdvisoryCatalogError> =>
			HttpClientRequest.post(`${OSV_API}/querybatch`).pipe(
				HttpClientRequest.bodyJsonUnsafe({
					queries: batch.map(({ ref, pageToken }) => ({
						package: { ecosystem: ref.ecosystem, name: ref.name },
						version: ref.version,
						// JSON leaves out an undefined token.
						page_token: pageToken,
					})),
				}),
				httpClient.execute,
				Effect.flatMap(HttpClientResponse.schemaBodyJson(QueryBatchResponse)),
				Effect.timeout(REQUEST_TIMEOUT),
				Effect.retry(RETRY),
				Effect.flatMap((body) =>
					body.results.length === batch.length
						? Effect.succeed(
								batch.map(({ ref }, i): Page => ({
									ref,
									vulns: body.results[i]?.vulns ?? [],
									nextPageToken: body.results[i]?.next_page_token,
								})),
							)
						: Effect.fail(
								`querybatch answered ${body.results.length} of ${batch.length} queries`,
							),
				),
				Effect.mapError(catalogError("OSV querybatch failed")),
				Effect.withSpan("osv.querybatch", {
					kind: "client",
					attributes: { "peer.service": "osv.dev", "maple.depscan.query_count": batch.length },
				}),
			)

		/** Every page of every query; a package with more than one page of vulnerabilities is rare. */
		const queryAll = (
			pending: ReadonlyArray<Pending>,
			found: ReadonlyMap<string, ReadonlyArray<VulnRef>>,
		): Effect.Effect<ReadonlyMap<string, ReadonlyArray<VulnRef>>, PackageAdvisoryCatalogError> =>
			pending.length === 0
				? Effect.succeed(found)
				: Effect.forEach(Arr.chunksOf(pending, BATCH_SIZE), queryBatch, { concurrency: 2 }).pipe(
						Effect.flatMap((batches) => {
							const pages = batches.flat()
							const next = new Map(found)
							pages.forEach((page) => {
								const key = packageKey(page.ref)
								next.set(key, [...(next.get(key) ?? []), ...page.vulns])
							})
							return queryAll(
								pages.flatMap((page) =>
									page.nextPageToken === undefined
										? []
										: [{ ref: page.ref, pageToken: page.nextPageToken }],
								),
								next,
							)
						}),
					)

		const fetchRecord = (vuln: VulnRef) =>
			edgeCache
				.getOrCompute(
					{
						bucket: CACHE_BUCKET,
						key: `${vuln.id}@${vuln.modified}`,
						ttlSeconds: CACHE_TTL_SECONDS,
						schema: OsvRecord,
						readTimeoutMs: CACHE_READ_TIMEOUT_MS,
					},
					httpClient.get(`${OSV_API}/vulns/${encodeURIComponent(vuln.id)}`).pipe(
						Effect.flatMap(HttpClientResponse.schemaBodyJson(OsvVulnResponse)),
						Effect.timeout(REQUEST_TIMEOUT),
						Effect.retry(RETRY),
						Effect.map(toOsvRecord),
						Effect.mapError(catalogError(`OSV read failed for ${vuln.id}`)),
						Effect.withSpan("osv.vuln", {
							kind: "client",
							attributes: { "peer.service": "osv.dev", "maple.depscan.advisory_id": vuln.id },
						}),
					),
				)
				.pipe(Effect.map((result) => result.value))

		const advisories = Effect.fn("PackageAdvisoryCatalog.advisories")(function* (
			packages: ReadonlyArray<PackageRef>,
		) {
			const distinct = [...new Map(packages.map((ref) => [packageKey(ref), ref])).values()]
			const found = yield* queryAll(
				distinct.map((ref) => ({ ref })),
				new Map(),
			)
			const vulns = [...new Map([...found.values()].flat().map((vuln) => [vuln.id, vuln])).values()]
			yield* Effect.annotateCurrentSpan({
				"maple.depscan.package_count": distinct.length,
				"maple.depscan.vulnerability_count": vulns.length,
			})
			if (vulns.length > MAX_VULNERABILITIES) {
				return yield* new PackageAdvisoryCatalogError({
					message: `${vulns.length} known vulnerabilities, more than the ${MAX_VULNERABILITIES} a scan reads`,
					cause: undefined,
				})
			}
			const records = new Map(
				(yield* Effect.forEach(vulns, fetchRecord, { concurrency: CONCURRENCY })).map((record) => [
					record.id,
					record,
				]),
			)
			return new Map(
				distinct.flatMap((ref) => {
					const matched = (found.get(packageKey(ref)) ?? []).flatMap((vuln) => {
						const record = records.get(vuln.id)
						return record === undefined ? [] : [record]
					})
					const list = advisoriesOf(matched, ref)
					return list.length === 0 ? [] : [[packageKey(ref), list] as const]
				}),
			)
		})

		return { advisories } satisfies PackageAdvisoryCatalogApi
	}),
}) {
	static readonly layer = Layer.effect(this, this.make).pipe(Layer.provide(FetchHttpClient.layer))
}
