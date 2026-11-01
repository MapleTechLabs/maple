// Opt-in live check: runs the dependency scanner on public GitHub repositories end to end (tree
// listing, lockfile selection, blob reads, parsing, OSV) and compares every lockfile it read with
// osv-scanner on a shallow clone of the same commit. Needs network, git and osv-scanner:
// DEPSCAN_GITHUB_E2E_REPOS=Makisuo/maple,cli/cli GITHUB_TOKEN=$(gh auth token) \
//   bunx vitest run src/services/dependency-scan/DependencyScanner.github.e2e.test.ts --silent=false
import { afterEach, assert, describe, it } from "@effect/vitest"
import { EdgeCacheService, MemoryCacheBackendLive } from "@maple/cache"
import { GitCommitSha, VcsInstallation, VcsRepo, type VcsRepositoryRef } from "@maple/domain/http"
import { Console, Effect, Layer, Option, Schema } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http"
import { spawnSync } from "node:child_process"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { cleanupTestDbs, createTestDb, type TestDb } from "@maple/backend/platform/test-pglite"
import { PackageAdvisoryCatalog } from "@maple/backend/services/security/PackageAdvisoryCatalog"
import { DependencyScanner, DependencySources } from "./DependencyScanner"
import { DependencyScanStore } from "./DependencyScanStore"

const repos = (process.env.DEPSCAN_GITHUB_E2E_REPOS ?? "").split(",").filter((repo) => repo !== "")
const token = process.env.GITHUB_TOKEN ?? ""

const trackedDbs: Array<TestDb> = []
afterEach(() => cleanupTestDbs(trackedDbs))

const repoOf = (repo: VcsRepositoryRef) => `${repo.owner}/${repo.name}`

const github = (fullName: string, path: string) =>
	Effect.gen(function* () {
		const client = (yield* HttpClient.HttpClient).pipe(HttpClient.filterStatusOk)
		const response = yield* client.execute(
			HttpClientRequest.get(`https://api.github.com/repos/${fullName}${path}`).pipe(
				HttpClientRequest.bearerToken(token),
			),
		)
		return yield* response.json
	}).pipe(Effect.orDie, Effect.provide(FetchHttpClient.layer))

const Tree = Schema.Struct({
	truncated: Schema.Boolean,
	tree: Schema.Array(
		Schema.Struct({
			path: Schema.String,
			type: Schema.String,
			sha: Schema.String,
			size: Schema.optionalKey(Schema.Number),
		}),
	),
})
const Blob = Schema.Struct({ content: Schema.String })
const Repo = Schema.Struct({ default_branch: Schema.String })
const Commit = Schema.Struct({ sha: GitCommitSha })

const source = {
	resolveRef: (_installation: unknown, _repo: VcsRepositoryRef, ref: string) =>
		github(repoOf(_repo), `/commits/${ref}`).pipe(
			Effect.flatMap(Schema.decodeUnknownEffect(Commit)),
			Effect.map((commit) => Option.some(commit.sha)),
			Effect.orDie,
		),
	fetchTreeFiles: (_installation: unknown, _repo: VcsRepositoryRef, commitSha: string) =>
		github(repoOf(_repo), `/git/trees/${commitSha}?recursive=1`).pipe(
			Effect.flatMap(Schema.decodeUnknownEffect(Tree)),
			Effect.map((tree) => ({
				truncated: tree.truncated,
				files: tree.tree.flatMap((entry) =>
					entry.type === "blob"
						? [{ path: entry.path, sha: entry.sha, size: entry.size ?? 0 }]
						: [],
				),
			})),
			Effect.orDie,
		),
	fetchBlobText: (_installation: unknown, _repo: VcsRepositoryRef, blobSha: string) =>
		github(repoOf(_repo), `/git/blobs/${blobSha}`).pipe(
			Effect.flatMap(Schema.decodeUnknownEffect(Blob)),
			Effect.map((blob) => Buffer.from(blob.content.replace(/\s/g, ""), "base64").toString("utf8")),
			Effect.orDie,
		),
}

interface OsvScannerOutput {
	readonly results?: ReadonlyArray<{
		readonly packages?: ReadonlyArray<{
			readonly package: { readonly name: string; readonly version: string; readonly ecosystem: string }
			readonly groups?: ReadonlyArray<{
				readonly ids: ReadonlyArray<string>
				readonly aliases?: ReadonlyArray<string>
			}>
		}>
	}>
}

const osvScanner = (path: string): OsvScannerOutput => {
	// osv-scanner exits non-zero when it finds something, so its status says nothing here.
	const run = spawnSync("osv-scanner", ["scan", "source", "--format", "json", "--lockfile", path], {
		maxBuffer: 256 * 1024 * 1024,
	})
	return JSON.parse(run.stdout.toString() || "{}")
}

const scanAndCompare = (fullName: string) =>
	Effect.gen(function* () {
		const [owner = "", name = ""] = fullName.split("/")
		const repoInfo = yield* github(fullName, "").pipe(
			Effect.flatMap(Schema.decodeUnknownEffect(Repo)),
			Effect.orDie,
		)
		const branch = repoInfo.default_branch
		const installation = Schema.decodeUnknownSync(VcsInstallation)({
			id: "5d7f8a52-1c3e-4b6a-9b1e-2a3c4d5e6f71",
			orgId: "org_harness",
			provider: "github",
			externalInstallationId: "0",
			accountLogin: owner,
			accountType: "organization",
			externalAccountId: "0",
			accountAvatarUrl: null,
			repositorySelection: "all",
			status: "active",
			suspendedAt: null,
			ciTracesEnabled: false,
			installedByUserId: "user_harness",
			createdAt: 0,
			updatedAt: 0,
		})
		const repository = Schema.decodeUnknownSync(VcsRepo)({
			id: "7f0c1a52-4d8e-4b6a-9b1e-2a3c4d5e6f70",
			orgId: "org_harness",
			provider: "github",
			installationId: installation.id,
			externalRepoId: "0",
			owner,
			name,
			fullName,
			defaultBranch: repoInfo.default_branch,
			trackedBranch: branch,
			htmlUrl: `https://github.com/${fullName}`,
			isPrivate: false,
			isArchived: false,
			status: "active",
			syncStatus: "ready",
			lastSyncedAt: null,
			lastSyncError: null,
			prReviewEnabled: false,
			createdAt: 0,
			updatedAt: 0,
		})
		const scanner = yield* DependencyScanner
		const store = yield* DependencyScanStore
		const started = Date.now()
		const outcome = yield* scanner.scan(installation, repository, { trigger: "manual" })
		if (outcome._tag !== "Scanned") return yield* Console.log(`${fullName}: ${outcome._tag}`)
		const scan = outcome.scan
		const matches = yield* store.scanMatches({ orgId: repository.orgId, scanId: scan.id })
		yield* Console.log(
			`${fullName}@${scan.commitSha.slice(0, 12)} (${branch}): ${scan.lockfiles.length} lockfiles, ${scan.packageCount} packages, ${matches.length} vulnerable matches, ${Date.now() - started} ms`,
		)

		const dir = mkdtempSync(join(tmpdir(), "depscan-"))
		spawnSync("git", [
			"clone",
			"--quiet",
			"--depth",
			"1",
			"--branch",
			branch,
			`https://github.com/${fullName}`,
			dir,
		])
		const cloned = spawnSync("git", ["-C", dir, "rev-parse", "HEAD"]).stdout.toString().trim()
		if (cloned !== scan.commitSha) yield* Console.log(`  clone is at ${cloned}, comparison may differ`)

		const results = scan.lockfiles.map((lockfile) => {
			// An unsupported format or an oversized file is an expected outcome; a failed read is not.
			if (lockfile.status !== "parsed")
				return {
					line: `  SKIP  ${lockfile.path}: ${lockfile.status} (${lockfile.message})`,
					ok: lockfile.status === "unsupported" || lockfile.status === "too_large",
				}
			const ours = new Map<string, Array<Set<string>>>()
			matches
				.filter((match) => match.lockfilePath === lockfile.path)
				.forEach((match) => {
					const key = `${match.ecosystem}:${match.packageName}@${match.version.replace(/^v/, "")}`
					ours.set(key, [...(ours.get(key) ?? []), new Set([match.advisoryId, ...match.aliases])])
				})
			const theirs = new Map(
				(osvScanner(join(dir, lockfile.path)).results ?? [])
					.flatMap((result) => result.packages ?? [])
					.map((pkg) => [
						`${pkg.package.ecosystem}:${pkg.package.name}@${pkg.package.version.replace(/^v/, "")}`,
						(pkg.groups ?? []).map((group) => new Set([...group.ids, ...(group.aliases ?? [])])),
					]),
			)
			const keys = new Set([...ours.keys(), ...theirs.keys()])
			const diffs = [...keys].flatMap((key) => {
				const mine = ours.get(key) ?? []
				const other = theirs.get(key) ?? []
				const missing = other.filter(
					(group) => !mine.some((names) => [...group].some((id) => names.has(id))),
				)
				const extra = mine.filter(
					(names) => !other.some((group) => [...group].some((id) => names.has(id))),
				)
				return missing.length === 0 && extra.length === 0
					? []
					: [
							`    ${key}: only osv-scanner ${missing.map((g) => [...g][0]).join(",")}; only ours ${extra.map((n) => [...n][0]).join(",")}`,
						]
			})
			const count = [...ours.values()].reduce((sum, list) => sum + list.length, 0)
			const theirCount = [...theirs.values()].reduce((sum, list) => sum + list.length, 0)
			return {
				line: [
					`  ${diffs.length === 0 ? "MATCH" : "DIFF "} ${lockfile.path}: ${lockfile.packageCount} packages, ${count} advisories (osv-scanner ${theirCount})`,
					...diffs,
				].join("\n"),
				ok: diffs.length === 0,
			}
		})
		yield* Effect.forEach(results, (result) => Console.log(result.line))
		// A scan that compared no lockfile proves nothing.
		const compared = scan.lockfiles.filter((lockfile) => lockfile.status === "parsed").length
		return [
			...results.flatMap((result) => (result.ok ? [] : [result.line])),
			...(compared === 0 ? [`  no lockfile of ${fullName} was parsed and compared`] : []),
		]
	})

const layer = () => {
	const cache = EdgeCacheService.layer.pipe(Layer.provide(MemoryCacheBackendLive))
	const store = DependencyScanStore.layer.pipe(Layer.provide(createTestDb(trackedDbs).layer))
	return Layer.effect(DependencyScanner, DependencyScanner.make).pipe(
		Layer.provide(
			Layer.mergeAll(
				PackageAdvisoryCatalog.layer.pipe(Layer.provide(cache)),
				Layer.succeed(DependencySources, { resolve: () => Effect.succeed(source) }),
				cache,
			),
		),
		Layer.provideMerge(store),
	)
}

describe.skipIf(repos.length === 0)("DependencyScanner on GitHub repositories", () => {
	it.each(repos)(
		"finds what osv-scanner finds in %s",
		(fullName) =>
			Effect.gen(function* () {
				const diffs = yield* scanAndCompare(fullName)
				assert.deepStrictEqual(diffs, [])
			}).pipe(Effect.provide(layer()), Effect.runPromise),
		600_000,
	)
})
