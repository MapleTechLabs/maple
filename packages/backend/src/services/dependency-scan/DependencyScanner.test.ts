import { afterEach, assert, describe, it } from "@effect/vitest"
import { EdgeCacheService, MemoryCacheBackendLive } from "@maple/cache"
import {
	GitCommitSha,
	VcsInstallation,
	VcsInstallationGoneError,
	VcsRepo,
	VcsRepositoryBlockedError,
	VcsRepoUnavailableError,
} from "@maple/domain/http"
import {
	Deferred,
	Effect,
	Fiber,
	Layer,
	Option,
	Schema,
	Array as Arr,
	Record as Rec,
	String as Str,
} from "effect"
import { HttpClient, type HttpClientRequest, HttpClientResponse } from "effect/http"
import { TestClock } from "effect/testing"
import { cleanupTestDbs, createTestDb, type TestDb } from "@maple/backend/testing/test-pglite"
import type { VcsTreeFile } from "@maple/backend/services/integrations/vcs/VcsProviderClient"
import { PackageAdvisoryCatalog } from "@maple/backend/services/security/PackageAdvisoryCatalog"
import osvFixture from "../security/__fixtures__/osv.json"
import { DependencyScanner, DependencySources, MAX_LOCKFILE_BYTES } from "./DependencyScanner"
import { DependencyScanStore } from "./DependencyScanStore"
import { RESCAN_AFTER_MS } from "./production"
import { MAX_LOCKFILES, MAX_MANIFEST_BYTES, MAX_SKIPPED_LOCKFILES } from "./lockfile-selection"

const trackedDbs: TestDb[] = []
afterEach(() => cleanupTestDbs(trackedDbs))

const sha = (digit: string) => Schema.decodeSync(GitCommitSha)(Str.repeat(40)(digit))

const installation = Schema.decodeSync(VcsInstallation)({
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
	auditLogEnabled: true,
	auditCategories: {},
	repositoryDiscovery: null,
	installedByUserId: "user_scan",
	createdAt: 0,
	updatedAt: 0,
})

const repository = Schema.decodeSync(VcsRepo)({
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

const CARGO_LOCK = Arr.join(
	[
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
	],
	"\n",
)

interface World {
	/** Null once the branch is deleted. */
	head: GitCommitSha | null
	files: Map<string, { readonly sha: string; readonly content: string; readonly size?: number }>
	truncated: boolean
	/** What the provider answers a ref lookup with instead of the head. */
	refusal: VcsRepositoryBlockedError | VcsRepoUnavailableError | VcsInstallationGoneError | undefined
	osvDown: boolean
	/** Where the branch head moves while the tree is read, as a concurrent push would. */
	headAfterTree: GitCommitSha | null | undefined
	/** When set, blob reads never finish; completed once one starts. */
	stallBlobs: Deferred.Deferred<void> | undefined
	/** Blob shas read from the provider, in order. */
	readonly blobReads: Array<string>
	/** Provider and OSV calls, counted per kind. */
	readonly calls: { resolveRef: number; fetchTreeFiles: number; querybatch: number }
	/** Vulnerability ids OSV leaves out of its answer, as before an advisory is published. */
	readonly hidden: Set<string>
	/** Per vulnerability id: a newer `modified`, or a record OSV serves as withdrawn. */
	readonly revisions: Map<string, { readonly modified?: string; readonly withdrawn?: string }>
}

const world = (files: Record<string, string>): World => ({
	head: sha("a"),
	files: new Map(
		Arr.map(Rec.toEntries(files), ([path, content]) => [
			path,
			{ sha: `blob:${path}:${content.length}`, content },
		]),
	),
	truncated: false,
	refusal: undefined,
	osvDown: false,
	headAfterTree: undefined,
	stallBlobs: undefined,
	blobReads: [],
	calls: { resolveRef: 0, fetchTreeFiles: 0, querybatch: 0 },
	hidden: new Set(),
	revisions: new Map(),
})

const source = (state: World) => ({
	resolveRef: () =>
		Effect.suspend(() => {
			state.calls.resolveRef += 1
			return state.refusal === undefined
				? Effect.succeed(Option.fromNullOr(state.head))
				: Effect.fail(state.refusal)
		}),
	fetchTreeFiles: () =>
		Effect.sync(() => {
			state.calls.fetchTreeFiles += 1
			const listing = {
				truncated: state.truncated,
				files: Arr.map([...state.files], ([path, blob]): VcsTreeFile => ({
					path,
					sha: blob.sha,
					size: blob.size ?? blob.content.length,
				})),
			}
			if (state.headAfterTree !== undefined) state.head = state.headAfterTree
			return listing
		}),
	fetchBlobText: (_installation: unknown, _repo: unknown, blobSha: string) =>
		state.stallBlobs === undefined
			? Effect.sync(() => {
					state.blobReads.push(blobSha)
					return (
						Option.getOrUndefined(
							Arr.findFirst([...state.files.values()], (blob) => blob.sha === blobSha),
						)?.content ?? ""
					)
				})
			: Deferred.succeed(state.stallBlobs, undefined).pipe(Effect.andThen(Effect.never)),
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
				state.calls.querybatch += 1
				const body: { queries: ReadonlyArray<Query> } =
					request.body._tag === "Uint8Array"
						? JSON.parse(new TextDecoder().decode(request.body.body))
						: { queries: [] }
				return json(request, {
					results: Arr.map(body.queries, (query) => {
						const index = Arr.findFirstIndex(
							osvFixture.queries,
							(known) =>
								known.package.ecosystem === query.package.ecosystem &&
								known.package.name === query.package.name &&
								known.version === query.version,
						)
						const result: { readonly vulns?: ReadonlyArray<{ id: string; modified: string }> } =
							Option.match(index, {
								onNone: () => ({}),
								onSome: (i) => osvFixture.batch.results[i] ?? {},
							})
						return {
							vulns: Arr.flatMap(result.vulns ?? [], (vuln) =>
								state.hidden.has(vuln.id)
									? []
									: [
											{
												...vuln,
												modified:
													state.revisions.get(vuln.id)?.modified ?? vuln.modified,
											},
										],
							),
						}
					}),
				})
			}
			const id = decodeURIComponent(Str.replace("/v1/vulns/", "")(url.pathname))
			const vuln = Option.getOrUndefined(
				Arr.findFirst(osvFixture.vulns, (candidate) => candidate.id === id),
			)
			const withdrawn = state.revisions.get(id)?.withdrawn
			return vuln === undefined
				? json(request, { message: "not found" }, 404)
				: json(request, withdrawn === undefined ? vuln : { ...vuln, withdrawn })
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
					Arr.map(outcome.scan.lockfiles, (lockfile) => [
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
				const byPackage = (name: string) =>
					Arr.filter(findings, (finding) => finding.packageName === name)
				assert.strictEqual(byPackage("lodash").length, 6)
				assert.deepStrictEqual(
					Arr.map(byPackage("minimist"), (finding) => [
						finding.severity,
						finding.relation,
						finding.fixedIn,
					]),
					[["critical", "dev", "1.2.6"]],
				)
				assert.isTrue(
					Arr.every(
						byPackage("golang.org/x/net"),
						(finding) => finding.lockfilePath === "services/api/go.mod",
					),
				)
				assert.deepStrictEqual(
					Arr.map(byPackage("time"), (finding) => finding.relation),
					["direct"],
				)
				// The go.sum beside go.mod, the vendored lockfile and the binary bun.lockb are never read.
				assert.isFalse(
					Arr.some(
						state.blobReads,
						(blob) =>
							Str.includes("go.sum")(blob) ||
							Str.includes("node_modules")(blob) ||
							Str.includes("bun.lockb")(blob),
					),
				)
			}).pipe(Effect.provide(scannerFor(state)))
		},
	)

	it.effect("records a broken lockfile as failed and does not parse the same blob again", () => {
		const state = world({ "package-lock.json": "{ not json" })
		return Effect.gen(function* () {
			const scanner = yield* DependencyScanner
			const first = yield* scanner.scan(installation, repository, { trigger: "schedule" })
			state.head = sha("b")
			const second = yield* scanner.scan(installation, repository, { trigger: "schedule" })
			assert.deepStrictEqual(
				Arr.map([first, second], (outcome) =>
					outcome._tag === "Scanned"
						? Arr.map(outcome.scan.lockfiles, (lockfile) => [lockfile.path, lockfile.status])
						: outcome._tag,
				),
				[[["package-lock.json", "failed"]], [["package-lock.json", "failed"]]],
			)
			assert.strictEqual(state.blobReads.length, 1)
		}).pipe(Effect.provide(scannerFor(state)))
	})

	it.effect("parses one blob under each lockfile format it is named as", () => {
		const content = packageLock("4.17.15")
		const state = world({ "bun.lock": content, "package-lock.json": content })
		state.files = new Map(
			Arr.map([...state.files], ([path, blob]) => [path, { ...blob, sha: "blob:shared" }]),
		)
		return Effect.gen(function* () {
			const scanner = yield* DependencyScanner
			const outcome = yield* scanner.scan(installation, repository, { trigger: "schedule" })
			const lockfiles =
				outcome._tag === "Scanned"
					? Arr.map(outcome.scan.lockfiles, (lockfile) => [
							lockfile.path,
							lockfile.status,
							lockfile.packageCount,
						])
					: outcome._tag
			assert.deepStrictEqual(lockfiles, [
				["bun.lock", "failed", 0],
				["package-lock.json", "parsed", 2],
			])
		}).pipe(Effect.provide(scannerFor(state)))
	})

	it.effect("skips a push that changed no lockfile, and fixes the advisories an upgrade removes", () => {
		const state = world(MONOREPO)
		return Effect.gen(function* () {
			const scanner = yield* DependencyScanner
			yield* scanner.scan(installation, repository, { trigger: "schedule" })

			// A production scan of an older commit in between does not hide the branch's last scan.
			yield* scanner.scan(installation, repository, { trigger: "production", commitSha: sha("9") })
			state.head = sha("b")
			state.files.set("README.md", { sha: "readme-2", content: "# shop 2" })
			const unchanged = yield* scanner.scan(installation, repository, { trigger: "push" })
			assert.strictEqual(unchanged._tag, "Unchanged")

			state.head = sha("c")
			const upgraded = packageLock("4.18.0")
			state.files.set("package-lock.json", { sha: "lock-2", content: upgraded })
			const outcome = yield* scanner.scan(installation, repository, { trigger: "push" })
			assert.strictEqual(outcome._tag, "Scanned")

			const lodash = Arr.filter(yield* findingsOf, (finding) => finding.packageName === "lodash")
			assert.strictEqual(lodash.length, 6)
			assert.isTrue(
				Arr.every(lodash, (finding) => finding.status === "fixed" && finding.fixedSha === sha("c")),
			)
		}).pipe(Effect.provide(scannerFor(state)))
	})

	it.effect("skips an unchanged push in a repository with more lockfiles than a scan reads", () => {
		const many = Rec.fromEntries(
			Array.from({ length: MAX_LOCKFILES + 2 }, (_, i): [string, string] => [
				`pkg${i}/package-lock.json`,
				packageLock("4.17.15"),
			]),
		)
		const state = world(many)
		return Effect.gen(function* () {
			const scanner = yield* DependencyScanner
			const first = yield* scanner.scan(installation, repository, { trigger: "schedule" })
			assert.strictEqual(
				first._tag === "Scanned"
					? Arr.filter(first.scan.lockfiles, (lockfile) => lockfile.status === "skipped").length
					: 0,
				2,
			)
			state.head = sha("b")
			const again = yield* scanner.scan(installation, repository, { trigger: "push" })
			assert.strictEqual(again._tag, "Unchanged")
		}).pipe(Effect.provide(scannerFor(state)))
	})

	it.effect("records skipped lockfiles only up to a cap, and leaves a scan past it unreconciled", () => {
		const total = MAX_LOCKFILES + MAX_SKIPPED_LOCKFILES + 5
		const many = Rec.fromEntries(
			Array.from({ length: total }, (_, i): [string, string] => [
				`pkg${i}/package-lock.json`,
				packageLock("4.17.15"),
			]),
		)
		const state = world(many)
		return Effect.gen(function* () {
			const scanner = yield* DependencyScanner
			const outcome = yield* scanner.scan(installation, repository, { trigger: "schedule" })
			assert.strictEqual(outcome._tag, "Scanned")
			if (outcome._tag !== "Scanned") return
			assert.strictEqual(outcome.scan.lockfiles.length, MAX_LOCKFILES + MAX_SKIPPED_LOCKFILES)
			assert.strictEqual(
				outcome.scan.error,
				`5 lockfiles past the ${MAX_LOCKFILES + MAX_SKIPPED_LOCKFILES} a scan records were left out`,
			)
		}).pipe(Effect.provide(scannerFor(state)))
	})

	it.effect("rescans a push that adds a lockfile past the record cap to a full scan", () => {
		const many = Rec.fromEntries(
			Array.from({ length: MAX_LOCKFILES + MAX_SKIPPED_LOCKFILES }, (_, i): [string, string] => [
				`pkg${i}/package-lock.json`,
				packageLock("4.17.15"),
			]),
		)
		const state = world(many)
		return Effect.gen(function* () {
			const scanner = yield* DependencyScanner
			const first = yield* scanner.scan(installation, repository, { trigger: "schedule" })
			assert.isTrue(first._tag === "Scanned" && first.scan.error === null)
			state.head = sha("b")
			state.files.set("zzz/deep/new/package-lock.json", {
				sha: "deep-1",
				content: packageLock("4.17.15"),
			})
			const again = yield* scanner.scan(installation, repository, { trigger: "push" })
			assert.strictEqual(again._tag, "Scanned")
		}).pipe(Effect.provide(scannerFor(state)))
	})

	it.effect("rescans a yarn repository on every push, since package.json decides direct and dev", () => {
		const yarnLock = '"lodash@4.17.15":\n  version "4.17.15"\n'
		const state = world({
			"yarn.lock": yarnLock,
			"package.json": '{"dependencies":{"lodash":"4.17.15"}}',
		})
		return Effect.gen(function* () {
			const scanner = yield* DependencyScanner
			yield* scanner.scan(installation, repository, { trigger: "schedule" })
			state.head = sha("b")
			state.files.set("package.json", {
				sha: "pkg-2",
				content: '{"devDependencies":{"lodash":"4.17.15"}}',
			})
			const again = yield* scanner.scan(installation, repository, { trigger: "push" })
			assert.strictEqual(again._tag, "Scanned")
		}).pipe(Effect.provide(scannerFor(state)))
	})

	it.effect("does not reconcile when the branch moved on while the scan read it", () => {
		const state = world({ "package-lock.json": packageLock("4.17.15") })
		return Effect.gen(function* () {
			const scanner = yield* DependencyScanner
			yield* scanner.scan(installation, repository, { trigger: "schedule" })
			// The lockfile is upgraded, but a newer push lands while this scan lists the tree.
			state.head = sha("b")
			state.files.set("package-lock.json", { sha: "lock-up", content: packageLock("4.18.0") })
			state.headAfterTree = sha("c")
			const outcome = yield* scanner.scan(installation, repository, { trigger: "schedule" })
			assert.strictEqual(
				outcome._tag === "Scanned" ? outcome.scan.error : null,
				"main moved on to ccccccc during the scan",
			)
			assert.isTrue(Arr.every(yield* findingsOf, (finding) => finding.status === "open"))
		}).pipe(Effect.provide(scannerFor(state)))
	})

	it.effect("does not reconcile when the branch was deleted while the scan read it", () => {
		const state = world({ "package-lock.json": packageLock("4.17.15") })
		return Effect.gen(function* () {
			const scanner = yield* DependencyScanner
			yield* scanner.scan(installation, repository, { trigger: "schedule" })
			state.head = sha("b")
			state.files.set("package-lock.json", { sha: "lock-up", content: packageLock("4.18.0") })
			state.headAfterTree = null
			const outcome = yield* scanner.scan(installation, repository, { trigger: "schedule" })
			assert.strictEqual(
				outcome._tag === "Scanned" ? outcome.scan.error : null,
				"main was deleted during the scan",
			)
			assert.isTrue(Arr.every(yield* findingsOf, (finding) => finding.status === "open"))
		}).pipe(Effect.provide(scannerFor(state)))
	})

	it.effect("rescans a push whose lockfiles match a scan that never reconciled", () => {
		const state = world({ "package-lock.json": packageLock("4.17.15") })
		return Effect.gen(function* () {
			const scanner = yield* DependencyScanner
			yield* scanner.scan(installation, repository, { trigger: "schedule" })
			state.head = sha("b")
			state.files.set("package-lock.json", { sha: "lock-up", content: packageLock("4.18.0") })
			state.headAfterTree = sha("c")
			yield* scanner.scan(installation, repository, { trigger: "schedule" })
			// The push of c keeps b's lockfile, so only b's scan has read it, and that one never reconciled.
			state.headAfterTree = undefined
			const outcome = yield* scanner.scan(installation, repository, { trigger: "push" })
			assert.strictEqual(outcome._tag, "Scanned")
			const lodash = Arr.filter(yield* findingsOf, (finding) => finding.packageName === "lodash")
			assert.isTrue(lodash.length > 0 && Arr.every(lodash, (finding) => finding.status === "fixed"))
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
			const before = Arr.map(yield* findingsOf, keyOf).sort()

			state.osvDown = true
			state.head = sha("d")
			state.files.set("package-lock.json", { sha: "lock-3", content: packageLock("4.18.0") })
			const error = yield* Effect.flip(scanner.scan(installation, repository, { trigger: "push" }))
			assert.strictEqual(error._tag, "@maple/dependency-scan/DependencyScanError")
			// The typed failure's message, followed by what caused it: the span and error group
			// show only this message.
			assert.match(error.message, /^Could not read advisories: .+/)

			const [latest] = yield* store.listScans({ orgId: repository.orgId, limit: 1 })
			assert.strictEqual(latest?.status, "failed")
			assert.strictEqual(latest?.error, error.message)
			assert.deepStrictEqual(Arr.map(yield* findingsOf, keyOf).sort(), before)
		}).pipe(Effect.provide(scannerFor(state)))
	})

	it.effect("settles a scan interrupted mid-read as failed instead of leaving it running", () => {
		const state = world({ "package-lock.json": packageLock("4.17.15") })
		return Effect.gen(function* () {
			const scanner = yield* DependencyScanner
			const store = yield* DependencyScanStore
			const reading = yield* Deferred.make<void>()
			state.stallBlobs = reading
			const fiber = yield* scanner
				.scan(installation, repository, { trigger: "schedule" })
				.pipe(Effect.forkChild)
			yield* Deferred.await(reading)
			yield* Fiber.interrupt(fiber)

			const [latest] = yield* store.listScans({ orgId: repository.orgId, limit: 1 })
			assert.strictEqual(latest?.status, "failed")
			assert.strictEqual(latest?.error, "The scan was interrupted before it finished")
		}).pipe(Effect.provide(scannerFor(state)))
	})

	it.effect("settles a scan abandoned in running as failed when the repository is scanned again", () => {
		const state = world({ "package-lock.json": packageLock("4.17.15") })
		return Effect.gen(function* () {
			const scanner = yield* DependencyScanner
			const store = yield* DependencyScanStore
			// A worker that died mid-scan: nothing ever settled its row.
			const abandoned = yield* store.startScan({
				orgId: repository.orgId,
				repositoryId: repository.id,
				commitSha: sha("9"),
				ref: "main",
				trigger: "push",
				defaultBranchHead: true,
			})
			yield* TestClock.adjust(`${RESCAN_AFTER_MS + 1} millis`)
			yield* scanner.scan(installation, repository, { trigger: "schedule" })

			const scans = yield* store.listScans({ orgId: repository.orgId, limit: 10 })
			const settled = Arr.findFirst(scans, (scan) => scan.id === abandoned.id)
			assert.strictEqual(Option.getOrUndefined(settled)?.status, "failed")
			assert.isFalse(Arr.some(scans, (scan) => scan.status === "running"))
		}).pipe(Effect.provide(scannerFor(state)))
	})

	it.effect(
		"records a scan whose tree listing was cut short as failed instead of fixing the unlisted lockfiles' findings",
		() => {
			const state = world({ "package-lock.json": packageLock("4.17.15") })
			return Effect.gen(function* () {
				const scanner = yield* DependencyScanner
				yield* scanner.scan(installation, repository, { trigger: "schedule" })
				state.head = sha("b")
				state.truncated = true
				state.files.delete("package-lock.json")
				const outcome = yield* scanner.scan(installation, repository, { trigger: "schedule" })
				assert.strictEqual(outcome._tag, "TreeTooLarge")
				if (outcome._tag !== "TreeTooLarge") return
				assert.deepStrictEqual([outcome.scan.status, outcome.scan.commitSha], ["failed", sha("b")])
				assert.include(outcome.scan.error ?? "", "too large")
				assert.isTrue(Arr.every(yield* findingsOf, (finding) => finding.status === "open"))
			}).pipe(Effect.provide(scannerFor(state)))
		},
	)

	it.effect("records a tree too large to list once, not on every push", () => {
		const state = world({ "package-lock.json": packageLock("4.17.15") })
		return Effect.gen(function* () {
			const scanner = yield* DependencyScanner
			const store = yield* DependencyScanStore
			state.truncated = true
			const first = yield* scanner.scan(installation, repository, { trigger: "push" })
			assert.strictEqual(first._tag, "TreeTooLarge")
			state.head = sha("b")
			const again = yield* scanner.scan(installation, repository, { trigger: "push" })
			assert.strictEqual(again._tag, "Unchanged")
			assert.strictEqual((yield* store.listScans({ orgId: repository.orgId, limit: 10 })).length, 1)
			// Scan now records its own result, so the page sees the scan it asked for.
			yield* scanner.scan(installation, repository, { trigger: "manual" })
			assert.strictEqual((yield* store.listScans({ orgId: repository.orgId, limit: 10 })).length, 2)
		}).pipe(Effect.provide(scannerFor(state)))
	})

	it.effect("answers a repository the provider blocks or lost as unreachable, recording no scan", () => {
		const state = world({ "package-lock.json": packageLock("4.17.15") })
		const refusals = [
			new VcsRepositoryBlockedError({ message: "Repository access blocked", status: 451 }),
			new VcsRepoUnavailableError({ message: "Not Found" }),
			new VcsInstallationGoneError({ message: "Not Found" }),
		]
		return Effect.gen(function* () {
			const scanner = yield* DependencyScanner
			const store = yield* DependencyScanStore
			const reasons = yield* Effect.forEach(refusals, (refusal) => {
				state.refusal = refusal
				return scanner
					.scan(installation, repository, { trigger: "schedule" })
					.pipe(
						Effect.map((outcome) =>
							outcome._tag === "RepositoryUnreachable" ? outcome.reason : outcome._tag,
						),
					)
			})
			assert.deepStrictEqual(reasons, ["blocked", "unavailable", "installation_gone"])
			assert.strictEqual((yield* store.listScans({ orgId: repository.orgId, limit: 10 })).length, 0)
			assert.strictEqual(state.calls.fetchTreeFiles, 0)
		}).pipe(Effect.provide(scannerFor(state)))
	})

	it.effect("reads a yarn lockfile's manifests but never one too large to be a package.json", () => {
		const state = world({
			"yarn.lock": '"lodash@4.17.15":\n  version "4.17.15"\n',
			"package.json": '{"dependencies":{"lodash":"4.17.15"}}',
		})
		state.files.set("packages/huge/package.json", {
			sha: "huge-manifest",
			content: "{}",
			size: MAX_MANIFEST_BYTES + 1,
		})
		return Effect.gen(function* () {
			const scanner = yield* DependencyScanner
			const outcome = yield* scanner.scan(installation, repository, { trigger: "schedule" })
			assert.strictEqual(outcome._tag, "Scanned")
			assert.isTrue(state.blobReads.includes(state.files.get("package.json")!.sha))
			assert.isFalse(state.blobReads.includes("huge-manifest"))
		}).pipe(Effect.provide(scannerFor(state)))
	})

	it.effect("records an oversized lockfile without reading it and keeps its findings open", () => {
		const state = world({ "package-lock.json": packageLock("4.17.15") })
		return Effect.gen(function* () {
			const scanner = yield* DependencyScanner
			yield* scanner.scan(installation, repository, { trigger: "schedule" })
			state.head = sha("b")
			state.files.set("package-lock.json", { sha: "huge", content: "", size: MAX_LOCKFILE_BYTES + 1 })
			const outcome = yield* scanner.scan(installation, repository, { trigger: "schedule" })
			assert.strictEqual(
				outcome._tag === "Scanned" ? outcome.scan.lockfiles[0]?.status : undefined,
				"too_large",
			)
			assert.isFalse(state.blobReads.includes("huge"))
			assert.isTrue(Arr.every(yield* findingsOf, (finding) => finding.status === "open"))
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
			// A commit's content never changes, so asking again reads nothing.
			const reads = state.blobReads.length
			const again = yield* scanner.scan(installation, repository, {
				trigger: "production",
				commitSha: sha("e"),
			})
			assert.strictEqual(again._tag, "Unchanged")
			assert.strictEqual(state.blobReads.length, reads)
		}).pipe(Effect.provide(scannerFor(state)))
	})
})

describe("DependencyScanner scheduled rescans", () => {
	const LOCKFILE = { "package-lock.json": packageLock("4.17.15") }
	const MINIMIST_ADVISORY = "GHSA-xvch-5gv4-984h"

	const resetCalls = (state: World) => {
		state.calls.resolveRef = 0
		state.calls.fetchTreeFiles = 0
		state.calls.querybatch = 0
	}

	const scansOf = Effect.gen(function* () {
		const store = yield* DependencyScanStore
		return yield* store.listScans({ orgId: repository.orgId, limit: 50 })
	})

	const minimistOpen = Effect.map(findingsOf, (findings) =>
		Arr.some(
			findings,
			(finding) => finding.advisoryId === MINIMIST_ADVISORY && finding.status === "open",
		),
	)

	/** A completed default-branch scan of commit a, written as a scan before this change would. */
	const completedScanAt = (fingerprint: string | undefined, incomplete?: string) =>
		Effect.gen(function* () {
			const store = yield* DependencyScanStore
			const started = yield* store.startScan({
				orgId: repository.orgId,
				repositoryId: repository.id,
				commitSha: sha("a"),
				ref: "main",
				trigger: "schedule",
				defaultBranchHead: true,
			})
			return yield* store.completeScan({
				orgId: repository.orgId,
				scanId: started.id,
				lockfiles: [],
				packageCount: 0,
				matches: [],
				advisoryFingerprint: fingerprint,
				incomplete,
			})
		})

	it.effect("skips a commit already scanned when OSV answers the same, but still asks OSV", () => {
		const state = world(LOCKFILE)
		return Effect.gen(function* () {
			const scanner = yield* DependencyScanner
			const first = yield* scanner.scan(installation, repository, { trigger: "schedule" })
			assert.strictEqual(first._tag, "Scanned")
			// Before: every scheduled scan resolved the head twice, listed the tree and asked OSV.
			assert.deepStrictEqual(state.calls, { resolveRef: 2, fetchTreeFiles: 1, querybatch: 1 })
			resetCalls(state)
			yield* TestClock.adjust("12 hours")

			const again = yield* scanner.scan(installation, repository, { trigger: "schedule" })
			assert.strictEqual(again._tag, "Unchanged")
			assert.deepStrictEqual(state.calls, { resolveRef: 1, fetchTreeFiles: 0, querybatch: 1 })
			assert.strictEqual((yield* scansOf).length, 1)
		}).pipe(Effect.provide(scannerFor(state)))
	})

	it.effect("scans again when OSV publishes a new advisory, asking OSV once", () => {
		const state = world(LOCKFILE)
		state.hidden.add(MINIMIST_ADVISORY)
		return Effect.gen(function* () {
			const scanner = yield* DependencyScanner
			yield* scanner.scan(installation, repository, { trigger: "schedule" })
			assert.isFalse(yield* minimistOpen)
			state.hidden.delete(MINIMIST_ADVISORY)
			resetCalls(state)
			yield* TestClock.adjust("12 hours")

			const outcome = yield* scanner.scan(installation, repository, { trigger: "schedule" })
			assert.strictEqual(outcome._tag, "Scanned")
			assert.deepStrictEqual(state.calls, { resolveRef: 2, fetchTreeFiles: 0, querybatch: 1 })
			assert.isTrue(yield* minimistOpen)
			if (outcome._tag !== "Scanned") return
			const store = yield* DependencyScanStore
			const matches = yield* store.scanMatches({ orgId: repository.orgId, scanId: outcome.scan.id })
			assert.isTrue(Arr.some(matches, (match) => match.advisoryId === MINIMIST_ADVISORY))
		}).pipe(Effect.provide(scannerFor(state)))
	})

	it.effect("scans again when an advisory is modified, even under the same id", () => {
		const state = world(LOCKFILE)
		state.revisions.set(MINIMIST_ADVISORY, { modified: "2026-01-01T00:00:00Z", withdrawn: "2026-01-01" })
		return Effect.gen(function* () {
			const scanner = yield* DependencyScanner
			yield* scanner.scan(installation, repository, { trigger: "schedule" })
			assert.isFalse(yield* minimistOpen)
			// Reinstated: a new modification time, and the record no longer withdrawn.
			state.revisions.set(MINIMIST_ADVISORY, { modified: "2026-11-01T00:00:00Z" })
			yield* TestClock.adjust("12 hours")

			const outcome = yield* scanner.scan(installation, repository, { trigger: "schedule" })
			assert.strictEqual(outcome._tag, "Scanned")
			assert.isTrue(yield* minimistOpen)
		}).pipe(Effect.provide(scannerFor(state)))
	})

	it.effect(
		"scans in full when the last scan of the commit is incomplete, failed or has no fingerprint",
		() =>
			Effect.forEach(
				[
					{ name: "incomplete", setup: completedScanAt("stale", "main moved on") },
					{ name: "no fingerprint", setup: completedScanAt(undefined) },
					{
						name: "failed",
						setup: Effect.gen(function* () {
							const store = yield* DependencyScanStore
							const started = yield* store.startScan({
								orgId: repository.orgId,
								repositoryId: repository.id,
								commitSha: sha("a"),
								ref: "main",
								trigger: "schedule",
								defaultBranchHead: true,
							})
							return yield* store.failScan({
								orgId: repository.orgId,
								scanId: started.id,
								error: "OSV querybatch failed",
							})
						}),
					},
				],
				({ name, setup }) => {
					const state = world(LOCKFILE)
					return Effect.gen(function* () {
						yield* setup
						const scanner = yield* DependencyScanner
						const outcome = yield* scanner.scan(installation, repository, { trigger: "schedule" })
						assert.strictEqual(outcome._tag, "Scanned", name)
						if (outcome._tag !== "Scanned") return
						assert.isNotNull(outcome.scan.advisoryFingerprint, name)
						assert.strictEqual(state.calls.querybatch, 1, name)
					}).pipe(Effect.provide(scannerFor(state)))
				},
				{ discard: true },
			),
	)

	it.effect("scans in full after a failed scan, so the repository does not stay failed", () => {
		const state = world(LOCKFILE)
		return Effect.gen(function* () {
			const scanner = yield* DependencyScanner
			const store = yield* DependencyScanStore
			yield* scanner.scan(installation, repository, { trigger: "schedule" })
			yield* TestClock.adjust("1 hour")
			// A transient failure at the same commit, newer than the completed scan.
			const failed = yield* store.startScan({
				orgId: repository.orgId,
				repositoryId: repository.id,
				commitSha: sha("a"),
				ref: "main",
				trigger: "push",
				defaultBranchHead: true,
			})
			yield* store.failScan({ orgId: repository.orgId, scanId: failed.id, error: "rate limited" })
			yield* TestClock.adjust("12 hours")

			const outcome = yield* scanner.scan(installation, repository, { trigger: "schedule" })
			assert.strictEqual(outcome._tag, "Scanned")
			const latest = yield* store.latestBranchScans({ orgId: repository.orgId })
			assert.strictEqual(latest[0]?.status, "completed")
		}).pipe(Effect.provide(scannerFor(state)))
	})

	it.effect("scans in full when the branch moved to another commit", () => {
		const state = world(LOCKFILE)
		return Effect.gen(function* () {
			const scanner = yield* DependencyScanner
			yield* scanner.scan(installation, repository, { trigger: "schedule" })
			state.head = sha("b")
			const outcome = yield* scanner.scan(installation, repository, { trigger: "schedule" })
			assert.strictEqual(outcome._tag, "Scanned")
			assert.strictEqual(state.calls.fetchTreeFiles, 2)
		}).pipe(Effect.provide(scannerFor(state)))
	})

	it.effect("never skips a manual scan", () => {
		const state = world(LOCKFILE)
		return Effect.gen(function* () {
			const scanner = yield* DependencyScanner
			yield* scanner.scan(installation, repository, { trigger: "schedule" })
			const outcome = yield* scanner.scan(installation, repository, { trigger: "manual" })
			assert.strictEqual(outcome._tag, "Scanned")
			assert.strictEqual((yield* scansOf).length, 2)
		}).pipe(Effect.provide(scannerFor(state)))
	})

	it.effect("skips an unchanged commit with no lockfiles without asking OSV", () => {
		const state = world({ "README.md": "# shop" })
		return Effect.gen(function* () {
			const scanner = yield* DependencyScanner
			yield* scanner.scan(installation, repository, { trigger: "schedule" })
			resetCalls(state)
			const outcome = yield* scanner.scan(installation, repository, { trigger: "schedule" })
			assert.strictEqual(outcome._tag, "Unchanged")
			assert.deepStrictEqual(state.calls, { resolveRef: 1, fetchTreeFiles: 0, querybatch: 0 })
		}).pipe(Effect.provide(scannerFor(state)))
	})

	it.effect("stores no fingerprint on an incomplete scan, so the next one scans in full", () => {
		const state = world(LOCKFILE)
		state.headAfterTree = sha("c")
		return Effect.gen(function* () {
			const scanner = yield* DependencyScanner
			const first = yield* scanner.scan(installation, repository, { trigger: "schedule" })
			assert.strictEqual(
				first._tag === "Scanned" ? first.scan.error : null,
				"main moved on to ccccccc during the scan",
			)
			assert.isNull(first._tag === "Scanned" ? first.scan.advisoryFingerprint : "missing")

			state.head = sha("a")
			state.headAfterTree = undefined
			const again = yield* scanner.scan(installation, repository, { trigger: "schedule" })
			assert.strictEqual(again._tag, "Scanned")
		}).pipe(Effect.provide(scannerFor(state)))
	})
})
