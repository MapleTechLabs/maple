import { afterEach, assert, describe, it } from "@effect/vitest"
import { EdgeCacheService, MemoryCacheBackendLive } from "@maple/cache"
import { GitCommitSha, VcsInstallation, VcsRepo } from "@maple/domain/http"
import { Effect, Layer, Option, Schema } from "effect"
import { HttpClient, type HttpClientRequest, HttpClientResponse } from "effect/http"
import { cleanupTestDbs, createTestDb, type TestDb } from "@maple/backend/platform/test-pglite"
import type { VcsTreeFile } from "@maple/backend/services/integrations/vcs/VcsProviderClient"
import { PackageAdvisoryCatalog } from "@maple/backend/services/security/PackageAdvisoryCatalog"
import osvFixture from "../security/__fixtures__/osv.json"
import { DependencyScanner, DependencySources, MAX_LOCKFILE_BYTES } from "./DependencyScanner"
import { DependencyScanStore } from "./DependencyScanStore"

const trackedDbs: TestDb[] = []
afterEach(() => cleanupTestDbs(trackedDbs))

const sha = (digit: string) => Schema.decodeSync(GitCommitSha)(digit.repeat(40))

const installation = Schema.decodeUnknownSync(VcsInstallation)({
	id: "5d7f8a52-1c3e-4b6a-9b1e-2a3c4d5e6f71",
	orgId: "org_scan",
	provider: "github",
	externalInstallationId: "42",
	accountLogin: "octo",
	accountType: "organization",
	externalAccountId: "1",
	accountAvatarUrl: null,
	repositorySelection: "all",
	status: "active",
	suspendedAt: null,
	ciTracesEnabled: true,
	installedByUserId: "user_scan",
	createdAt: 0,
	updatedAt: 0,
})

const repository = Schema.decodeUnknownSync(VcsRepo)({
	id: "7f0c1a52-4d8e-4b6a-9b1e-2a3c4d5e6f70",
	orgId: "org_scan",
	provider: "github",
	installationId: installation.id,
	externalRepoId: "7",
	owner: "octo",
	name: "shop",
	fullName: "octo/shop",
	defaultBranch: "main",
	trackedBranch: null,
	htmlUrl: "https://github.com/octo/shop",
	isPrivate: true,
	isArchived: false,
	status: "active",
	syncStatus: "ready",
	lastSyncedAt: null,
	lastSyncError: null,
	prReviewEnabled: false,
	createdAt: 0,
	updatedAt: 0,
})

const packageLock = (lodash: string) =>
	JSON.stringify({
		name: "shop",
		lockfileVersion: 3,
		requires: true,
		packages: {
			"": { name: "shop", dependencies: { lodash }, devDependencies: { minimist: "1.2.5" } },
			"node_modules/lodash": { version: lodash },
			"node_modules/minimist": { version: "1.2.5", dev: true },
		},
	})

const GO_MOD = "module example.com/api\n\ngo 1.22\n\nrequire golang.org/x/net v0.7.0\n"

const CARGO_LOCK = [
	"version = 3",
	"",
	"[[package]]",
	'name = "shop"',
	'version = "0.1.0"',
	'dependencies = ["time"]',
	"",
	"[[package]]",
	'name = "time"',
	'version = "0.1.43"',
	'source = "registry+https://github.com/rust-lang/crates.io-index"',
	"",
].join("\n")

interface World {
	head: GitCommitSha
	files: Map<string, { readonly sha: string; readonly content: string; readonly size?: number }>
	truncated: boolean
	osvDown: boolean
	/** Blob shas read from the provider, in order. */
	readonly blobReads: Array<string>
}

const world = (files: Record<string, string>): World => ({
	head: sha("a"),
	files: new Map(
		Object.entries(files).map(([path, content]) => [
			path,
			{ sha: `blob:${path}:${content.length}`, content },
		]),
	),
	truncated: false,
	osvDown: false,
	blobReads: [],
})

const source = (state: World) => ({
	resolveRef: () => Effect.sync(() => Option.some(state.head)),
	fetchTreeFiles: () =>
		Effect.sync(() => ({
			truncated: state.truncated,
			files: [...state.files].map(([path, blob]): VcsTreeFile => ({
				path,
				sha: blob.sha,
				size: blob.size ?? blob.content.length,
			})),
		})),
	fetchBlobText: (_installation: unknown, _repo: unknown, blobSha: string) =>
		Effect.sync(() => {
			state.blobReads.push(blobSha)
			return [...state.files.values()].find((blob) => blob.sha === blobSha)?.content ?? ""
		}),
})

const json = (request: HttpClientRequest.HttpClientRequest, body: unknown, status = 200) =>
	HttpClientResponse.fromWeb(request, new Response(JSON.stringify(body), { status }))

interface Query {
	readonly package: { readonly ecosystem: string; readonly name: string }
	readonly version: string
}

/** OSV as captured in the fixture: packages it does not list have no advisories. */
const osv = (state: World) =>
	HttpClient.make((request: HttpClientRequest.HttpClientRequest) =>
		Effect.sync(() => {
			if (state.osvDown) return json(request, { message: "unavailable" }, 503)
			const url = new URL(request.url)
			if (url.pathname === "/v1/querybatch") {
				const body: { queries: ReadonlyArray<Query> } =
					request.body._tag === "Uint8Array"
						? JSON.parse(new TextDecoder().decode(request.body.body))
						: { queries: [] }
				return json(request, {
					results: body.queries.map((query) => {
						const index = osvFixture.queries.findIndex(
							(known) =>
								known.package.ecosystem === query.package.ecosystem &&
								known.package.name === query.package.name &&
								known.version === query.version,
						)
						return osvFixture.batch.results[index] ?? {}
					}),
				})
			}
			const id = decodeURIComponent(url.pathname.replace("/v1/vulns/", ""))
			const vuln = osvFixture.vulns.find((candidate) => candidate.id === id)
			return vuln === undefined ? json(request, { message: "not found" }, 404) : json(request, vuln)
		}),
	)

const scannerFor = (state: World) => {
	const store = DependencyScanStore.layer.pipe(Layer.provide(createTestDb(trackedDbs).layer))
	const cache = EdgeCacheService.layer.pipe(Layer.provide(MemoryCacheBackendLive))
	const catalog = Layer.effect(PackageAdvisoryCatalog, PackageAdvisoryCatalog.make).pipe(
		Layer.provide(Layer.mergeAll(Layer.succeed(HttpClient.HttpClient, osv(state)), cache)),
	)
	const sources = Layer.succeed(DependencySources, { resolve: () => Effect.succeed(source(state)) })
	return Layer.effect(DependencyScanner, DependencyScanner.make).pipe(
		Layer.provide(Layer.mergeAll(catalog, sources, cache)),
		Layer.provideMerge(store),
	)
}

const MONOREPO = {
	"package-lock.json": packageLock("4.17.15"),
	"services/api/go.mod": GO_MOD,
	"services/api/go.sum": "golang.org/x/net v0.7.0 h1:abc=\n",
	"crates/core/Cargo.lock": CARGO_LOCK,
	"web/node_modules/left-pad/package-lock.json": packageLock("4.17.15"),
	"legacy/bun.lockb": "binary",
	"README.md": "# shop",
}

const findingsOf = Effect.gen(function* () {
	const store = yield* DependencyScanStore
	return yield* store.listFindings({ orgId: repository.orgId, limit: 500 })
})

const keyOf = (finding: {
	readonly packageName: string
	readonly advisoryId: string
	readonly status: string
}) => `${finding.packageName}:${finding.advisoryId}:${finding.status}`

describe("DependencyScanner", () => {
	it.effect(
		"reads every lockfile of a monorepo at the tracked head and opens a finding per advisory",
		() => {
			const state = world(MONOREPO)
			return Effect.gen(function* () {
				const scanner = yield* DependencyScanner
				const outcome = yield* scanner.scan(installation, repository, { trigger: "schedule" })
				assert.strictEqual(outcome._tag, "Scanned")
				if (outcome._tag !== "Scanned") return
				assert.deepStrictEqual(
					outcome.scan.lockfiles.map((lockfile) => [
						lockfile.path,
						lockfile.status,
						lockfile.packageCount,
					]),
					[
						["package-lock.json", "parsed", 2],
						["legacy/bun.lockb", "unsupported", 0],
						["crates/core/Cargo.lock", "parsed", 1],
						["services/api/go.mod", "parsed", 1],
					],
				)
				assert.isTrue(outcome.scan.defaultBranchHead)
				assert.strictEqual(outcome.scan.ref, "main")
				assert.strictEqual(outcome.scan.commitSha, sha("a"))

				const findings = yield* findingsOf
				const byPackage = (name: string) => findings.filter((finding) => finding.packageName === name)
				assert.strictEqual(byPackage("lodash").length, 6)
				assert.deepStrictEqual(
					byPackage("minimist").map((finding) => [
						finding.severity,
						finding.relation,
						finding.fixedIn,
					]),
					[["critical", "dev", "1.2.6"]],
				)
				assert.isTrue(
					byPackage("golang.org/x/net").every(
						(finding) => finding.lockfilePath === "services/api/go.mod",
					),
				)
				assert.deepStrictEqual(
					byPackage("time").map((finding) => finding.relation),
					["direct"],
				)
				// The go.sum beside go.mod and the vendored lockfile are never read.
				assert.isFalse(
					state.blobReads.some((blob) => blob.includes("go.sum") || blob.includes("node_modules")),
				)
			}).pipe(Effect.provide(scannerFor(state)))
		},
	)

	it.effect("skips a push that changed no lockfile, and fixes the advisories an upgrade removes", () => {
		const state = world(MONOREPO)
		return Effect.gen(function* () {
			const scanner = yield* DependencyScanner
			yield* scanner.scan(installation, repository, { trigger: "schedule" })

			state.head = sha("b")
			state.files.set("README.md", { sha: "readme-2", content: "# shop 2" })
			const unchanged = yield* scanner.scan(installation, repository, { trigger: "push" })
			assert.strictEqual(unchanged._tag, "Unchanged")

			state.head = sha("c")
			const upgraded = packageLock("4.18.0")
			state.files.set("package-lock.json", { sha: "lock-2", content: upgraded })
			const outcome = yield* scanner.scan(installation, repository, { trigger: "push" })
			assert.strictEqual(outcome._tag, "Scanned")

			const lodash = (yield* findingsOf).filter((finding) => finding.packageName === "lodash")
			assert.strictEqual(lodash.length, 6)
			assert.isTrue(
				lodash.every((finding) => finding.status === "fixed" && finding.fixedSha === sha("c")),
			)
		}).pipe(Effect.provide(scannerFor(state)))
	})

	it.effect("reads a lockfile's packages from the parse cache on a rescan", () => {
		const state = world({ "package-lock.json": packageLock("4.17.15") })
		return Effect.gen(function* () {
			const scanner = yield* DependencyScanner
			yield* scanner.scan(installation, repository, { trigger: "schedule" })
			assert.strictEqual(state.blobReads.length, 1)
			yield* scanner.scan(installation, repository, { trigger: "schedule" })
			assert.strictEqual(state.blobReads.length, 1)
		}).pipe(Effect.provide(scannerFor(state)))
	})

	it.live("records a failed scan and keeps the findings when OSV cannot be read", () => {
		const state = world({ "package-lock.json": packageLock("4.17.15") })
		return Effect.gen(function* () {
			const scanner = yield* DependencyScanner
			const store = yield* DependencyScanStore
			yield* scanner.scan(installation, repository, { trigger: "schedule" })
			const before = (yield* findingsOf).map(keyOf).sort()

			state.osvDown = true
			state.head = sha("d")
			state.files.set("package-lock.json", { sha: "lock-3", content: packageLock("4.18.0") })
			const error = yield* Effect.flip(scanner.scan(installation, repository, { trigger: "push" }))
			assert.strictEqual(error._tag, "@maple/dependency-scan/DependencyScanError")

			const [latest] = yield* store.listScans({ orgId: repository.orgId, limit: 1 })
			assert.strictEqual(latest?.status, "failed")
			assert.deepStrictEqual((yield* findingsOf).map(keyOf).sort(), before)
		}).pipe(Effect.provide(scannerFor(state)))
	})

	it.effect(
		"fails a scan whose tree listing was cut short instead of fixing the unlisted lockfiles' findings",
		() => {
			const state = world({ "package-lock.json": packageLock("4.17.15") })
			return Effect.gen(function* () {
				const scanner = yield* DependencyScanner
				yield* scanner.scan(installation, repository, { trigger: "schedule" })
				state.truncated = true
				state.files.delete("package-lock.json")
				const error = yield* Effect.flip(
					scanner.scan(installation, repository, { trigger: "schedule" }),
				)
				assert.include(error.message, "too large")
				assert.isTrue((yield* findingsOf).every((finding) => finding.status === "open"))
			}).pipe(Effect.provide(scannerFor(state)))
		},
	)

	it.effect("records an oversized lockfile without reading it and keeps its findings open", () => {
		const state = world({ "package-lock.json": packageLock("4.17.15") })
		return Effect.gen(function* () {
			const scanner = yield* DependencyScanner
			yield* scanner.scan(installation, repository, { trigger: "schedule" })
			state.files.set("package-lock.json", { sha: "huge", content: "", size: MAX_LOCKFILE_BYTES + 1 })
			const outcome = yield* scanner.scan(installation, repository, { trigger: "schedule" })
			assert.strictEqual(
				outcome._tag === "Scanned" ? outcome.scan.lockfiles[0]?.status : undefined,
				"too_large",
			)
			assert.isFalse(state.blobReads.includes("huge"))
			assert.isTrue((yield* findingsOf).every((finding) => finding.status === "open"))
		}).pipe(Effect.provide(scannerFor(state)))
	})

	it.effect("stores an older commit's matches without touching the findings", () => {
		const state = world({ "package-lock.json": packageLock("4.17.15") })
		return Effect.gen(function* () {
			const scanner = yield* DependencyScanner
			const store = yield* DependencyScanStore
			const outcome = yield* scanner.scan(installation, repository, {
				trigger: "production",
				commitSha: sha("e"),
			})
			assert.strictEqual(outcome._tag, "Scanned")
			if (outcome._tag !== "Scanned") return
			assert.isFalse(outcome.scan.defaultBranchHead)
			assert.isNull(outcome.scan.ref)
			assert.strictEqual(
				(yield* store.scanMatches({ orgId: repository.orgId, scanId: outcome.scan.id })).length,
				7,
			)
			assert.deepStrictEqual(yield* findingsOf, [])
		}).pipe(Effect.provide(scannerFor(state)))
	})
})
