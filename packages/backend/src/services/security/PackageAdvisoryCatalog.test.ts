import { assert, describe, it } from "@effect/vitest"
import { CacheBackendLive } from "@maple/backend/platform/CacheBackendLive"
import { EdgeCacheService } from "@maple/cache"
import { type PackageRef, packageKey } from "@maple/domain/package-advisories"
import { Effect, Layer, Option, Array as Arr, String as Str } from "effect"
import { HttpClient, type HttpClientRequest, HttpClientResponse } from "effect/http"
import fixture from "./__fixtures__/osv.json"
import { MAX_VULNERABILITIES, PackageAdvisoryCatalog } from "./PackageAdvisoryCatalog"

interface Query {
	readonly package: { readonly ecosystem: string; readonly name: string }
	readonly version: string
	readonly page_token?: string
}

interface FakeOsv {
	/** Requests seen, as `querybatch:<n>` or `vuln:<id>`. */
	readonly requests: Array<string>
	/** Overrides the captured answer for a query. */
	readonly answer?: (query: Query) => {
		vulns?: ReadonlyArray<{ id: string; modified: string }>
		next_page_token?: string
	}
	readonly failBatch?: boolean
}

const capturedAnswer = (query: Query) => {
	const index = Option.getOrElse(
		Arr.findFirstIndex(
			fixture.queries,
			(known) =>
				known.package.ecosystem === query.package.ecosystem &&
				known.package.name === query.package.name &&
				known.version === query.version,
		),
		() => -1,
	)
	return fixture.batch.results[index] ?? {}
}

const json = (request: HttpClientRequest.HttpClientRequest, body: unknown, status = 200) =>
	HttpClientResponse.fromWeb(request, new Response(JSON.stringify(body), { status }))

const osv = (fake: FakeOsv) =>
	HttpClient.make((request: HttpClientRequest.HttpClientRequest) =>
		Effect.sync(() => {
			const url = new URL(request.url)
			if (url.pathname === "/v1/querybatch") {
				const body: { queries: ReadonlyArray<Query> } =
					request.body._tag === "Uint8Array"
						? JSON.parse(new TextDecoder().decode(request.body.body))
						: { queries: [] }
				fake.requests.push(`querybatch:${body.queries.length}`)
				if (fake.failBatch === true) return json(request, { message: "unavailable" }, 503)
				return json(request, { results: Arr.map(body.queries, fake.answer ?? capturedAnswer) })
			}
			const id = decodeURIComponent(Str.replace("/v1/vulns/", "")(url.pathname))
			fake.requests.push(`vuln:${id}`)
			const vuln = Arr.findFirst(fixture.vulns, (candidate) => candidate.id === id)
			if (Option.isSome(vuln)) return json(request, vuln.value)
			// Synthetic ids a test invents answer with a bare record.
			return Str.startsWith("GHSA-many-")(id)
				? json(request, { id, aliases: [] })
				: json(request, { message: "not found" }, 404)
		}),
	)

const catalogWith = (fake: FakeOsv) =>
	Layer.effect(PackageAdvisoryCatalog, PackageAdvisoryCatalog.make).pipe(
		Layer.provide(
			Layer.mergeAll(
				Layer.succeed(HttpClient.HttpClient, osv(fake)),
				EdgeCacheService.layer.pipe(Layer.provide(CacheBackendLive)),
			),
		),
	)

const refs: ReadonlyArray<PackageRef> = Arr.map(fixture.queries, (query) => ({
	ecosystem:
		query.package.ecosystem === "Go"
			? "Go"
			: query.package.ecosystem === "crates.io"
				? "crates.io"
				: "npm",
	name: query.package.name,
	version: query.version,
}))

const keyOf = (name: string) => {
	return Option.match(
		Arr.findFirst(refs, (candidate) => candidate.name === name),
		{ onNone: () => "", onSome: (ref) => packageKey(ref) },
	)
}

describe("PackageAdvisoryCatalog", () => {
	it.effect("answers every package in one batch, reads each vulnerability once and caches it", () => {
		const fake: FakeOsv = { requests: [] }
		return Effect.gen(function* () {
			const catalog = yield* PackageAdvisoryCatalog
			const { byPackage: first } = yield* catalog.advisories([...refs, ...refs])
			assert.deepStrictEqual(
				Arr.map(first.get(keyOf("minimist")) ?? [], (advisory) => [
					advisory.id,
					advisory.severity,
					advisory.fixedIn,
				]),
				[["GHSA-xvch-5gv4-984h", "critical", "1.2.6"]],
			)
			assert.strictEqual(first.get(keyOf("lodash"))?.length, 6)
			assert.isFalse(first.has(keyOf("left-pad")))

			const batches = Arr.filter(fake.requests, (request) => Str.startsWith("querybatch")(request))
			const reads = Arr.filter(fake.requests, (request) => Str.startsWith("vuln:")(request))
			assert.deepStrictEqual(batches, [`querybatch:${refs.length}`])
			assert.strictEqual(reads.length, new Set(reads).size)
			assert.strictEqual(reads.length, fixture.vulns.length)

			fake.requests.length = 0
			const { byPackage: second } = yield* catalog.advisories(refs)
			assert.deepStrictEqual(fake.requests, [`querybatch:${refs.length}`])
			assert.deepStrictEqual([...second.keys()], [...first.keys()])
		}).pipe(Effect.provide(catalogWith(fake)))
	})

	it.effect("follows a query's next page", () => {
		const fake: FakeOsv = {
			requests: [],
			answer: (query) =>
				query.package.name !== "lodash"
					? {}
					: query.page_token === undefined
						? { vulns: [{ id: "GHSA-p6mc-m468-83gw", modified: "1" }], next_page_token: "page-2" }
						: { vulns: [{ id: "GHSA-29mw-wpgm-hmr9", modified: "1" }] },
		}
		return Effect.gen(function* () {
			const catalog = yield* PackageAdvisoryCatalog
			const { byPackage: advisories } = yield* catalog.advisories(refs)
			assert.deepStrictEqual(
				Arr.map(advisories.get(keyOf("lodash")) ?? [], (advisory) => advisory.id).sort(),
				["GHSA-29mw-wpgm-hmr9", "GHSA-p6mc-m468-83gw"],
			)
			assert.deepStrictEqual(
				Arr.filter(fake.requests, (request) => Str.startsWith("querybatch")(request)),
				[`querybatch:${refs.length}`, "querybatch:1"],
			)
		}).pipe(Effect.provide(catalogWith(fake)))
	})

	it.live("fails as a whole when OSV is down, after retrying", () => {
		const fake: FakeOsv = { requests: [], failBatch: true }
		return Effect.gen(function* () {
			const catalog = yield* PackageAdvisoryCatalog
			const error = yield* Effect.flip(catalog.advisories(refs))
			assert.strictEqual(error._tag, "@maple/security/PackageAdvisoryCatalogError")
			assert.strictEqual(fake.requests.length, 3)
		}).pipe(Effect.provide(catalogWith(fake)))
	})

	it.effect("reads at most the capped number of vulnerabilities and counts the rest as unread", () => {
		const many = Array.from({ length: MAX_VULNERABILITIES + 3 }, (_, i) => ({
			id: `GHSA-many-${Str.padStart(4, "0")(String(i))}`,
			modified: "1",
		}))
		const fake: FakeOsv = {
			requests: [],
			answer: (query) => (query.package.name === "lodash" ? { vulns: many } : {}),
		}
		return Effect.gen(function* () {
			const catalog = yield* PackageAdvisoryCatalog
			const { unread } = yield* catalog.advisories(refs)
			assert.strictEqual(unread, 3)
			assert.strictEqual(
				Arr.filter(fake.requests, (request) => Str.startsWith("vuln:")(request)).length,
				MAX_VULNERABILITIES,
			)
		}).pipe(Effect.provide(catalogWith(fake)))
	})
})
