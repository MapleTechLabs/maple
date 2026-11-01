import { assert, describe, it } from "@effect/vitest"
import { EdgeCacheService } from "@maple/cache"
import { Effect, Layer } from "effect"
import { HttpClient, HttpClientResponse, type HttpClientRequest } from "effect/http"
import { CacheBackendLive } from "@maple/backend/platform/CacheBackendLive"
import { RuntimeAdvisoryCatalog } from "./RuntimeAdvisoryCatalog"

// Trimmed from OSV's answer for Bitnami `node` 20.10.0.
const NODE_BODY = {
	vulns: [
		{
			id: "BIT-node-2023-46809",
			aliases: ["BIT-node-min-2023-46809", "CVE-2023-46809"],
			details:
				"Node.js versions which bundle an unpatched version of OpenSSL are susceptible to a Marvin Attack. A second sentence.",
			published: "2024-03-06T10:56:52.360Z",
			database_specific: { severity: "Medium", cpes: ["cpe:2.3:a:nodejs:node.js:*"] },
			affected: [
				{
					package: { name: "node", ecosystem: "Bitnami" },
					ranges: [
						{
							type: "SEMVER",
							events: [
								{ introduced: "0" },
								{ fixed: "18.19.1" },
								{ introduced: "19.0.0" },
								{ fixed: "20.11.1" },
							],
						},
					],
				},
			],
		},
		{
			id: "BIT-node-2024-27983",
			aliases: ["CVE-2024-27983"],
			summary: "HTTP/2 server crash from a race in nghttp2",
			published: "2024-04-04T00:00:00.000Z",
			database_specific: { severity: "Critical" },
			affected: [
				{ ranges: [{ type: "SEMVER", events: [{ introduced: "20.0.0" }, { fixed: "20.12.1" }] }] },
			],
		},
	],
}

// Trimmed from GitHub's answer for oven-sh/bun, plus a withdrawn advisory and a crate-only one.
const BUN_BODY = [
	{
		ghsa_id: "GHSA-663w-cv8g-jj2p",
		cve_id: "CVE-2026-111497",
		html_url: "https://github.com/oven-sh/bun/security/advisories/GHSA-663w-cv8g-jj2p",
		summary: "Bundled brotli decoder has an out-of-bounds write (CVE-2026-111497)",
		severity: "high",
		published_at: "2026-10-23T09:31:05Z",
		withdrawn_at: null,
		vulnerabilities: [
			{
				package: { ecosystem: "npm", name: "bun" },
				vulnerable_version_range: ">= 1.0.21, < 1.4.4",
				patched_versions: "1.4.4",
			},
		],
	},
	{
		ghsa_id: "GHSA-cf8x-9m69-3gg3",
		cve_id: null,
		html_url: "https://github.com/oven-sh/bun/security/advisories/GHSA-cf8x-9m69-3gg3",
		summary: "HTTP/3 QPACK amplification allows remote memory exhaustion and CPU stall",
		severity: "high",
		published_at: "2026-10-24T00:13:31Z",
		withdrawn_at: null,
		vulnerabilities: [
			{
				package: { ecosystem: "npm", name: "bun" },
				vulnerable_version_range: ">= 1.3.14, < 1.4.4",
				patched_versions: "1.4.4",
			},
		],
	},
	{
		ghsa_id: "GHSA-0000-builtin",
		cve_id: null,
		html_url: "https://github.com/oven-sh/bun/security/advisories/GHSA-0000-builtin",
		summary: "A built-in module, versioned with the runtime, with no patched version listed",
		severity: "low",
		published_at: "2026-02-01T00:00:00Z",
		withdrawn_at: null,
		vulnerabilities: [
			{ package: { name: "node:zlib" }, vulnerable_version_range: "< 1.3.0", patched_versions: "" },
		],
	},
	{
		ghsa_id: "GHSA-0000-withdrawn",
		cve_id: null,
		html_url: "https://github.com/oven-sh/bun/security/advisories/GHSA-0000-withdrawn",
		summary: "Withdrawn",
		severity: "critical",
		published_at: "2026-01-01T00:00:00Z",
		withdrawn_at: "2026-01-02T00:00:00Z",
		vulnerabilities: [{ package: null, vulnerable_version_range: "< 9.0.0", patched_versions: null }],
	},
	{
		ghsa_id: "GHSA-0000-crate",
		cve_id: null,
		html_url: "https://github.com/oven-sh/bun/security/advisories/GHSA-0000-crate",
		summary: "A library the runtime publishes, versioned on its own",
		severity: "moderate",
		published_at: "2026-01-01T00:00:00Z",
		withdrawn_at: null,
		vulnerabilities: [
			{ package: { name: "bun-types" }, vulnerable_version_range: "< 9.0.0", patched_versions: null },
		],
	},
]

/**
 * Answers OSV for Node.js and GitHub for Bun, fails everything else with a 503, and records each
 * OSV package and version and each GitHub repository asked for.
 */
const osv = (requests: Array<string>) =>
	HttpClient.make((request: HttpClientRequest.HttpClientRequest) =>
		Effect.sync(() => {
			const github = /api\.github\.com\/repos\/([^/]+\/[^/]+)\/security-advisories/.exec(request.url)
			if (github !== null) {
				requests.push(`github:${github[1]}`)
				return HttpClientResponse.fromWeb(
					request,
					github[1] === "oven-sh/bun"
						? new Response(JSON.stringify(BUN_BODY), { status: 200 })
						: new Response("rate limited", { status: 403 }),
				)
			}
			const body =
				request.body._tag === "Uint8Array"
					? JSON.parse(new TextDecoder().decode(request.body.body))
					: {}
			requests.push(`${body.package?.name}@${body.version}`)
			const response =
				body.package?.name === "node"
					? new Response(JSON.stringify(NODE_BODY), { status: 200 })
					: new Response("unavailable", { status: 503 })
			return HttpClientResponse.fromWeb(request, response)
		}),
	)

const catalogWith = (requests: Array<string>) =>
	Layer.effect(RuntimeAdvisoryCatalog, RuntimeAdvisoryCatalog.make).pipe(
		Layer.provide(
			Layer.mergeAll(
				Layer.succeed(HttpClient.HttpClient, osv(requests)),
				EdgeCacheService.layer.pipe(Layer.provide(CacheBackendLive)),
			),
		),
	)

describe("RuntimeAdvisoryCatalog", () => {
	it.effect("returns each version's advisories worst first and leaves out one whose read failed", () => {
		const requests: Array<string> = []
		return Effect.gen(function* () {
			const catalog = yield* RuntimeAdvisoryCatalog
			const advisories = yield* catalog.advisories([
				{ product: "nodejs", version: "20.10.0" },
				{ product: "python", version: "3.12.7" },
				{ product: "nodejs", version: "20.10.0" },
			])
			assert.deepStrictEqual(advisories.skipped, [])
			assert.deepStrictEqual(advisories.advisories, {
				"nodejs@20.10.0": [
					{
						id: "CVE-2024-27983",
						url: "https://osv.dev/vulnerability/BIT-node-2024-27983",
						summary: "HTTP/2 server crash from a race in nghttp2",
						severity: "critical",
						fixedIn: "20.12.1",
						published: "2024-04-04T00:00:00.000Z",
					},
					{
						id: "CVE-2023-46809",
						url: "https://osv.dev/vulnerability/BIT-node-2023-46809",
						summary:
							"Node.js versions which bundle an unpatched version of OpenSSL are susceptible to a Marvin Attack.",
						severity: "medium",
						fixedIn: "20.11.1",
						published: "2024-03-06T10:56:52.360Z",
					},
				],
			})
			assert.deepStrictEqual(requests.toSorted(), ["node@20.10.0", "python@3.12.7"])
		}).pipe(Effect.provide(catalogWith(requests)))
	})

	it.effect("serves a repeat read from the cache", () => {
		const requests: Array<string> = []
		return Effect.gen(function* () {
			const catalog = yield* RuntimeAdvisoryCatalog
			yield* catalog.advisories([{ product: "nodejs", version: "20.10.0" }])
			const again = yield* catalog.advisories([{ product: "nodejs", version: "20.10.0" }])
			assert.strictEqual(again.advisories["nodejs@20.10.0"]?.length, 2)
			assert.deepStrictEqual(requests, ["node@20.10.0"])
		}).pipe(Effect.provide(catalogWith(requests)))
	})

	it.effect("reads at most 24 uncached versions a request and serves cached ones past that", () => {
		const requests: Array<string> = []
		const targets = Array.from({ length: 26 }, (_, index) => ({
			product: "nodejs" as const,
			version: `20.${index}.0`,
		}))
		return Effect.gen(function* () {
			const catalog = yield* RuntimeAdvisoryCatalog
			const first = yield* catalog.advisories(targets)
			assert.strictEqual(Object.keys(first.advisories).length, 24)
			assert.strictEqual(first.skipped.length, 2)
			assert.strictEqual(requests.length, 24)
			// The 24 now cached cost nothing, so the next request reads the two it skipped.
			const second = yield* catalog.advisories(targets)
			assert.strictEqual(Object.keys(second.advisories).length, 26)
			assert.deepStrictEqual(second.skipped, [])
			assert.strictEqual(requests.length, 26)
		}).pipe(Effect.provide(catalogWith(requests)))
	})

	it.effect("consults at most 96 versions a request and reports the rest as skipped", () => {
		const requests: Array<string> = []
		const targets = Array.from({ length: 100 }, (_, index) => ({
			product: "nodejs" as const,
			version: `20.${index}.0`,
		}))
		return Effect.gen(function* () {
			const catalog = yield* RuntimeAdvisoryCatalog
			const result = yield* catalog.advisories(targets)
			assert.strictEqual(requests.length, 24)
			assert.strictEqual(result.skipped.length, 76)
			assert.include(result.skipped, "nodejs@20.99.0")
		}).pipe(Effect.provide(catalogWith(requests)))
	})

	it.effect("matches Bun versions against one read of its GitHub advisories", () => {
		const requests: Array<string> = []
		return Effect.gen(function* () {
			const catalog = yield* RuntimeAdvisoryCatalog
			const result = yield* catalog.advisories([
				{ product: "bun", version: "1.4.0" },
				{ product: "bun", version: "1.2.0" },
				{ product: "bun", version: "1.4.4" },
				// Deno's read fails, so its version is left out.
				{ product: "deno", version: "2.1.0" },
			])
			assert.deepStrictEqual(result.advisories, {
				"bun@1.4.0": [
					{
						id: "GHSA-cf8x-9m69-3gg3",
						url: "https://github.com/oven-sh/bun/security/advisories/GHSA-cf8x-9m69-3gg3",
						summary: "HTTP/3 QPACK amplification allows remote memory exhaustion and CPU stall",
						severity: "high",
						fixedIn: "1.4.4",
						published: "2026-10-24T00:13:31Z",
					},
					{
						id: "CVE-2026-111497",
						url: "https://github.com/oven-sh/bun/security/advisories/GHSA-663w-cv8g-jj2p",
						summary: "Bundled brotli decoder has an out-of-bounds write (CVE-2026-111497)",
						severity: "high",
						fixedIn: "1.4.4",
						published: "2026-10-23T09:31:05Z",
					},
				],
				"bun@1.2.0": [
					{
						id: "CVE-2026-111497",
						url: "https://github.com/oven-sh/bun/security/advisories/GHSA-663w-cv8g-jj2p",
						summary: "Bundled brotli decoder has an out-of-bounds write (CVE-2026-111497)",
						severity: "high",
						fixedIn: "1.4.4",
						published: "2026-10-23T09:31:05Z",
					},
					// No patched version: the range's end stands in.
					{
						id: "GHSA-0000-builtin",
						url: "https://github.com/oven-sh/bun/security/advisories/GHSA-0000-builtin",
						summary:
							"A built-in module, versioned with the runtime, with no patched version listed",
						severity: "low",
						fixedIn: "1.3.0",
						published: "2026-02-01T00:00:00Z",
					},
				],
				"bun@1.4.4": [],
			})
			assert.deepStrictEqual(result.skipped, [])
			assert.deepStrictEqual(requests.toSorted(), ["github:denoland/deno", "github:oven-sh/bun"])
			// A later request reuses the cached list.
			yield* catalog.advisories([{ product: "bun", version: "1.3.0" }])
			assert.strictEqual(requests.length, 2)
		}).pipe(Effect.provide(catalogWith(requests)))
	})
})
