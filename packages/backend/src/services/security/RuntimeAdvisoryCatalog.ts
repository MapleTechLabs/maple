import { EdgeCacheService } from "@maple/cache"
import { RuntimeAdvisoryRow } from "@maple/domain/http"
import {
	ADVISORY_SOURCES,
	type AdvisoryTarget,
	advisoryKey,
	fixedVersionFor,
	inAdvisoryRange,
	isPatched,
	lowestVersion,
	OSV_RUNTIME_ECOSYSTEM,
	patchedVersionFor,
	rangeEndFor,
	type RuntimeAdvisory,
	severityOf,
	sortAdvisories,
} from "@maple/domain/runtime-advisories"
import { Context, Effect, Layer, Ref, Schema } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http"

// Known vulnerabilities per runtime version for the Security Center's Runtimes tab. OSV.dev is read
// once per runtime version a day; a GitHub repository's advisory list once per repository a day,
// matched against each version here. A version whose read fails is left out.

const CACHE_BUCKET = "runtime-advisories"
const CACHE_TTL_SECONDS = 24 * 60 * 60
/** A failed read is remembered briefly, so an outage costs one timeout per version, not one per request. */
const FAILURE_TTL_SECONDS = 10 * 60
const CACHE_READ_TIMEOUT_MS = 150
const REQUEST_TIMEOUT = "3 seconds"
const SUMMARY_MAX_LENGTH = 160
/** OSV reads per request; cached versions do not count, so a cold cache costs at most three rounds. */
const MAX_READS = 24
/** Versions consulted per request, cached or not, so a tenant with hundreds stays bounded. */
const MAX_VERSIONS = 96
const CONCURRENCY = 16

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

const GithubAdvisoriesResponse = Schema.Array(
	Schema.Struct({
		ghsa_id: Schema.String,
		cve_id: Schema.NullOr(Schema.String),
		html_url: Schema.String,
		summary: Schema.NullOr(Schema.String),
		severity: Schema.NullOr(Schema.String),
		published_at: Schema.NullOr(Schema.String),
		withdrawn_at: Schema.NullOr(Schema.String),
		vulnerabilities: Schema.NullOr(
			Schema.Array(
				Schema.Struct({
					package: Schema.NullOr(Schema.Struct({ name: Schema.NullOr(Schema.String) })),
					vulnerable_version_range: Schema.NullOr(Schema.String),
					patched_versions: Schema.NullOr(Schema.String),
				}),
			),
		),
	}),
)

/** A repository advisory reduced to what matching a version needs. */
const GithubAdvisory = Schema.Struct({
	id: Schema.String,
	url: Schema.String,
	summary: Schema.NullOr(Schema.String),
	severity: RuntimeAdvisoryRow.fields.severity,
	published: Schema.NullOr(Schema.String),
	ranges: Schema.Array(Schema.Struct({ vulnerable: Schema.String, patched: Schema.NullOr(Schema.String) })),
})
type GithubAdvisory = typeof GithubAdvisory.Type

const CachedGithubAdvisories = Schema.NullOr(Schema.Array(GithubAdvisory))

/**
 * Whether an advisory entry is versioned like the runtime: unnamed, the runtime or repo, or a built-in
 * module (`node:crypto`). Deno's crates (`deno_fetch`, `serde_v8`) carry their own versions.
 */
const isRuntimePackage = (
	name: string | null | undefined,
	product: AdvisoryTarget["product"],
	repo: string,
) => {
	const normalized = (name ?? "").trim().toLowerCase()
	return (
		normalized === "" ||
		normalized === product ||
		normalized === repo.toLowerCase() ||
		normalized.includes(":")
	)
}

const toGithubAdvisory = (
	advisory: (typeof GithubAdvisoriesResponse.Type)[number],
	product: AdvisoryTarget["product"],
	repo: string,
): GithubAdvisory => ({
	id: advisory.cve_id ?? advisory.ghsa_id,
	url: advisory.html_url,
	summary: advisory.summary,
	severity: severityOf(advisory.severity),
	published: advisory.published_at,
	ranges: (advisory.vulnerabilities ?? []).flatMap((vulnerability) =>
		vulnerability.vulnerable_version_range === null ||
		!isRuntimePackage(vulnerability.package?.name, product, repo)
			? []
			: [
					{
						vulnerable: vulnerability.vulnerable_version_range,
						patched: vulnerability.patched_versions,
					},
				],
	),
})

/** The advisories whose ranges hold `version`, each with the lowest patched version above it. */
const githubAdvisoriesFor = (
	advisories: ReadonlyArray<GithubAdvisory>,
	version: string,
): ReadonlyArray<RuntimeAdvisory> =>
	sortAdvisories(
		advisories.flatMap((advisory) => {
			const hits = advisory.ranges.filter(
				(range) => inAdvisoryRange(range.vulnerable, version) && !isPatched(range.patched, version),
			)
			if (hits.length === 0) return []
			const fixes = hits.flatMap((range) => {
				const fixed =
					patchedVersionFor(range.patched, version) ?? rangeEndFor(range.vulnerable, version)
				return fixed === null ? [] : [fixed]
			})
			return [
				{
					id: advisory.id,
					url: advisory.url,
					summary: truncate(advisory.summary),
					severity: advisory.severity,
					fixedIn: lowestVersion(fixes),
					published: advisory.published,
				},
			]
		}),
	)

export class RuntimeAdvisoryCatalogError extends Schema.TaggedError<RuntimeAdvisoryCatalogError>()(
	"@maple/security/RuntimeAdvisoryCatalogError",
	{ message: Schema.String, key: Schema.String, cause: Schema.Defect() },
) {}

/** Advisories per page; a repository past this many only has its newest read. */
const GITHUB_PAGE_SIZE = 100

const truncate = (raw: string | null | undefined): string | null => {
	const text = (raw ?? "").trim()
	if (text === "") return null
	return text.length > SUMMARY_MAX_LENGTH ? `${text.slice(0, SUMMARY_MAX_LENGTH - 1).trimEnd()}…` : text
}

/** Many advisories carry no summary, only details: their first sentence stands in, capped. */
const summaryOf = (vuln: OsvVuln): string | null =>
	truncate(vuln.summary ?? vuln.details?.split(/(?<=\.)\s/)[0])

const toAdvisory = (vuln: OsvVuln, version: string): RuntimeAdvisory => {
	const fixes = (vuln.affected ?? [])
		.flatMap((affected) => affected.ranges ?? [])
		.flatMap((range) => {
			const fixed = fixedVersionFor(range.events, version)
			return fixed === null ? [] : [fixed]
		})
	return {
		id: vuln.aliases?.find((alias) => alias.startsWith("CVE-")) ?? vuln.id,
		url: `https://osv.dev/vulnerability/${encodeURIComponent(vuln.id)}`,
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
	/** Versions left unread: past `MAX_VERSIONS`, or past the read budget (a later request reads those). */
	readonly skipped: ReadonlyArray<string>
}

export interface RuntimeAdvisoryCatalogApi {
	/** The first `MAX_VERSIONS` distinct versions in `targets` order are served; at most `MAX_READS` of them are read. */
	readonly advisories: (targets: ReadonlyArray<AdvisoryTarget>) => Effect.Effect<RuntimeAdvisoryReadResult>
}

export class RuntimeAdvisoryCatalog extends Context.Service<
	RuntimeAdvisoryCatalog,
	RuntimeAdvisoryCatalogApi
>()("@maple/backend/services/security/RuntimeAdvisoryCatalog", {
	make: Effect.gen(function* () {
		const edgeCache = yield* EdgeCacheService
		const httpClient = (yield* HttpClient.HttpClient).pipe(HttpClient.filterStatusOk)

		const fetchGithubAdvisories = (product: AdvisoryTarget["product"], repo: string) =>
			HttpClientRequest.get(`https://api.github.com/repos/${repo}/security-advisories`).pipe(
				HttpClientRequest.setUrlParams({ per_page: String(GITHUB_PAGE_SIZE), state: "published" }),
				HttpClientRequest.setHeaders({
					accept: "application/vnd.github+json",
					"user-agent": "maple-security-center",
					"x-github-api-version": "2022-11-28",
				}),
				httpClient.execute,
				Effect.flatMap(HttpClientResponse.schemaBodyJson(GithubAdvisoriesResponse)),
				Effect.timeout(REQUEST_TIMEOUT),
				Effect.map((advisories) =>
					advisories
						.filter((advisory) => advisory.withdrawn_at === null)
						.map((advisory) => toGithubAdvisory(advisory, product, repo)),
				),
				Effect.mapError(
					(cause) =>
						new RuntimeAdvisoryCatalogError({
							message: `GitHub advisory read failed for ${repo}`,
							key: repo,
							cause,
						}),
				),
				Effect.withSpan("github.security_advisories", {
					kind: "client",
					attributes: {
						"peer.service": "api.github.com",
						"maple.runtime.product": product,
						"maple.advisory.repo": repo,
					},
				}),
			)

		/** A repository's advisory list, null when the read failed. Shared by every version of the runtime. */
		const githubListFor = (product: AdvisoryTarget["product"], repo: string) =>
			edgeCache
				.getOrCompute(
					{
						bucket: CACHE_BUCKET,
						key: `github:${repo}`,
						ttlSeconds: (value) => (value === null ? FAILURE_TTL_SECONDS : CACHE_TTL_SECONDS),
						schema: CachedGithubAdvisories,
						readTimeoutMs: CACHE_READ_TIMEOUT_MS,
					},
					fetchGithubAdvisories(product, repo).pipe(
						Effect.tapError((error) => Effect.logWarning("runtime advisory read failed", error)),
						Effect.orElseSucceed(() => null),
					),
				)
				.pipe(Effect.map((result) => result.value))

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

		const advisoriesFor = (
			target: AdvisoryTarget,
			budget: Ref.Ref<number>,
			githubLists: ReadonlyMap<string, Effect.Effect<ReadonlyArray<GithubAdvisory> | null>>,
		): Effect.Effect<Read> => {
			const key = advisoryKey(target)
			const source = ADVISORY_SOURCES[target.product]
			if (source._tag === "github") {
				const list = githubLists.get(source.repo) ?? githubListFor(target.product, source.repo)
				return list.pipe(
					Effect.map((advisories): Read => ({
						_tag: "read",
						key,
						value: advisories === null ? null : githubAdvisoriesFor(advisories, target.version),
					})),
				)
			}
			const name = source.package
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
			const consulted = distinct.slice(0, MAX_VERSIONS)
			const budget = yield* Ref.make(MAX_READS)
			// One read per repository however many of its runtime's versions are asked for.
			const githubLists = new Map(
				yield* Effect.forEach(
					[
						...new Map(
							consulted.flatMap((target) => {
								const source = ADVISORY_SOURCES[target.product]
								return source._tag === "github"
									? [[source.repo, target.product] as const]
									: []
							}),
						),
					],
					([repo, product]) =>
						Effect.cached(githubListFor(product, repo)).pipe(
							Effect.map((list) => [repo, list] as const),
						),
				),
			)
			const reads = yield* Effect.forEach(
				consulted,
				(target) => advisoriesFor(target, budget, githubLists),
				{ concurrency: CONCURRENCY },
			)
			return {
				advisories: Object.fromEntries(
					reads.flatMap((read) =>
						read._tag === "read" && read.value !== null ? [[read.key, read.value] as const] : [],
					),
				),
				skipped: [
					...reads.flatMap((read) => (read._tag === "skipped" ? [read.key] : [])),
					...distinct.slice(MAX_VERSIONS).map(advisoryKey),
				],
			} satisfies RuntimeAdvisoryReadResult
		})

		return { advisories } satisfies RuntimeAdvisoryCatalogApi
	}),
}) {
	static readonly layer = Layer.effect(this, this.make).pipe(Layer.provide(FetchHttpClient.layer))
}
