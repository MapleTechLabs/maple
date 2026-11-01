import { afterEach, assert, describe, it } from "@effect/vitest"
import type { DependencyScanLockfile, DependencyScanTrigger } from "@maple/domain/dependency-scan"
import { GitCommitSha, VcsRepositoryId } from "@maple/domain/http/vcs"
import { OrgId, UserId } from "@maple/domain/primitives"
import { Effect, Layer, Option, Schema } from "effect"
import { TestClock } from "effect/testing"
import { cleanupTestDbs, createTestDb, type TestDb } from "@maple/backend/platform/test-pglite"
import {
	DependencyScanStore,
	type DependencyScanMatchInput,
	type DependencyScanStoreApi,
} from "./DependencyScanStore"

const trackedDbs: TestDb[] = []
afterEach(() => cleanupTestDbs(trackedDbs))

const orgA = Schema.decodeSync(OrgId)("org_a")
const orgB = Schema.decodeSync(OrgId)("org_b")
const user = Schema.decodeSync(UserId)("user_a")
const repo = Schema.decodeSync(VcsRepositoryId)("7f0c1a52-4d8e-4b6a-9b1e-2a3c4d5e6f70")
const sha = (digit: string) => Schema.decodeSync(GitCommitSha)(digit.repeat(40))

const withStore = <A, E>(body: (store: DependencyScanStoreApi) => Effect.Effect<A, E>) =>
	Effect.gen(function* () {
		const store = yield* DependencyScanStore
		return yield* body(store)
	}).pipe(Effect.provide(DependencyScanStore.layer.pipe(Layer.provide(createTestDb(trackedDbs).layer))))

const lockfile = (
	path: string,
	status: DependencyScanLockfile["status"] = "parsed",
): DependencyScanLockfile => ({
	path,
	kind: "bun-lock",
	blobSha: `blob-${path}`,
	packageCount: 10,
	status,
	message: status === "parsed" ? null : "could not read it",
})

const match = (
	packageName: string,
	overrides: Partial<DependencyScanMatchInput> = {},
): DependencyScanMatchInput => ({
	lockfilePath: "bun.lock",
	ecosystem: "npm",
	packageName,
	version: "1.0.0",
	relation: "transitive",
	advisoryId: `GHSA-${packageName}`,
	aliases: [`CVE-${packageName}`],
	severity: "high",
	summary: `${packageName} is vulnerable`,
	fixedIn: "1.0.1",
	...overrides,
})

/** Starts and completes one scan at `commit`; returns the settled scan row. */
const scan = (
	store: DependencyScanStoreApi,
	commit: string,
	matches: ReadonlyArray<DependencyScanMatchInput>,
	options: {
		readonly orgId?: OrgId
		readonly lockfiles?: ReadonlyArray<DependencyScanLockfile>
		readonly trigger?: DependencyScanTrigger
	} = {},
) =>
	Effect.gen(function* () {
		const orgId = options.orgId ?? orgA
		const trigger = options.trigger ?? "push"
		const started = yield* store.startScan({
			orgId,
			repositoryId: repo,
			commitSha: sha(commit),
			ref: trigger === "production" ? null : "main",
			trigger,
			defaultBranchHead: trigger !== "production",
		})
		return yield* store.completeScan({
			orgId,
			scanId: started.id,
			lockfiles: options.lockfiles ?? [lockfile("bun.lock")],
			packageCount: 10,
			matches,
		})
	})

const findings = (store: DependencyScanStoreApi, orgId: OrgId = orgA) =>
	store.listFindings({ orgId, repositoryId: repo, limit: 100 })

describe("DependencyScanStore bulk reads", () => {
	it.effect("reads each repository's newest head scan, scans at commits and their matches", () =>
		withStore((store) =>
			Effect.gen(function* () {
				const first = yield* scan(store, "a", [match("lodash")])
				yield* TestClock.adjust("1 second")
				const second = yield* scan(store, "b", [match("minimist")])
				yield* TestClock.adjust("1 second")
				yield* scan(store, "c", [match("axios")], { trigger: "production" })
				assert.deepStrictEqual(
					(yield* store.latestBranchScans({ orgId: orgA })).map((row) => row.id),
					[second.id],
				)
				assert.deepStrictEqual(
					(yield* store.scansAtCommits({
						orgId: orgA,
						repositoryIds: [repo],
						commitShas: [sha("a"), sha("c")],
					}))
						.map((row) => row.commitSha)
						.sort(),
					[sha("a"), sha("c")],
				)
				assert.deepStrictEqual(
					(yield* store.matchesOfScans({ orgId: orgA, scanIds: [first.id, second.id] }))
						.map((row) => row.packageName)
						.sort(),
					["lodash", "minimist"],
				)
				assert.deepStrictEqual(yield* store.matchesOfScans({ orgId: orgA, scanIds: [] }), [])
				assert.deepStrictEqual(
					yield* store.scansAtCommits({ orgId: orgA, repositoryIds: [], commitShas: [] }),
					[],
				)
				assert.deepStrictEqual(yield* store.latestBranchScans({ orgId: orgB }), [])
			}),
		),
	)
})

describe("DependencyScanStore findings lifecycle", () => {
	it.effect("keeps a finding's id and triage when OSV later links its advisory to a new record", () =>
		withStore((store) =>
			Effect.gen(function* () {
				yield* scan(store, "a", [
					match("x/net", { ecosystem: "Go", advisoryId: "GO-2026-1", aliases: ["CVE-2026-1"] }),
				])
				const [first] = yield* findings(store)
				if (first === undefined) return yield* Effect.die("no finding")
				yield* store.setFindingStatus({
					orgId: orgA,
					id: first.id,
					status: "dismissed",
					reason: "not reachable",
					actor: user,
				})
				// The GHSA now leads the group and names the GO record as an alias.
				yield* scan(store, "b", [
					match("x/net", {
						ecosystem: "Go",
						advisoryId: "GHSA-aaaa",
						aliases: ["CVE-2026-1", "GO-2026-1"],
					}),
				])
				const rows = yield* findings(store)
				assert.deepStrictEqual(
					rows.map((row) => [row.id, row.advisoryId, row.status]),
					[[first.id, "GO-2026-1", "dismissed"]],
				)
				assert.include(rows[0]?.aliases ?? [], "GHSA-aaaa")
			}),
		),
	)

	it.effect("stores an incomplete scan's matches but reconciles nothing from it", () =>
		withStore((store) =>
			Effect.gen(function* () {
				yield* scan(store, "a", [match("lodash")])
				const started = yield* store.startScan({
					orgId: orgA,
					repositoryId: repo,
					commitSha: sha("b"),
					ref: "main",
					trigger: "schedule",
					defaultBranchHead: true,
				})
				const settled = yield* store.completeScan({
					orgId: orgA,
					scanId: started.id,
					lockfiles: [lockfile("bun.lock")],
					packageCount: 10,
					matches: [match("minimist")],
					incomplete: "12 known vulnerabilities were left out",
				})
				assert.strictEqual(settled.error, "12 known vulnerabilities were left out")
				assert.strictEqual((yield* store.scanMatches({ orgId: orgA, scanId: started.id })).length, 1)
				assert.deepStrictEqual(
					(yield* findings(store)).map((row) => [row.packageName, row.status]),
					[["lodash", "open"]],
				)
			}),
		),
	)

	it.effect("keeps a match on the finding with its exact id when another finding shares an alias", () =>
		withStore((store) =>
			Effect.gen(function* () {
				yield* scan(store, "a", [
					match("x/net", { ecosystem: "Go", advisoryId: "GO-2026-1", aliases: ["CVE-2026-1"] }),
					match("x/net", { ecosystem: "Go", advisoryId: "GHSA-bbbb", aliases: ["CVE-2026-1"] }),
				])
				yield* scan(store, "b", [
					match("x/net", { ecosystem: "Go", advisoryId: "GO-2026-1", aliases: ["CVE-2026-1"] }),
					match("x/net", { ecosystem: "Go", advisoryId: "GHSA-bbbb", aliases: ["CVE-2026-1"] }),
				])
				assert.deepStrictEqual(
					(yield* findings(store)).map((row) => [row.advisoryId, row.status]).sort(),
					[
						["GHSA-bbbb", "open"],
						["GO-2026-1", "open"],
					],
				)
			}),
		),
	)

	it.effect("keeps a finding open when OSV now lists its advisory only as another's alias", () =>
		withStore((store) =>
			Effect.gen(function* () {
				yield* scan(store, "a", [
					match("x/net", { ecosystem: "Go", advisoryId: "GO-2026-1", aliases: [] }),
					match("x/net", { ecosystem: "Go", advisoryId: "GHSA-cccc", aliases: [] }),
				])
				yield* scan(store, "b", [
					match("x/net", { ecosystem: "Go", advisoryId: "GHSA-cccc", aliases: ["GO-2026-1"] }),
				])
				assert.deepStrictEqual(
					(yield* findings(store)).map((row) => [row.advisoryId, row.status]).sort(),
					[
						["GHSA-cccc", "open"],
						["GO-2026-1", "open"],
					],
				)
			}),
		),
	)

	it.effect("never lets an older scan that settles late undo a newer scan's fixes", () =>
		withStore((store) =>
			Effect.gen(function* () {
				yield* scan(store, "a", [match("lodash")])
				yield* TestClock.adjust("1 second")
				const older = yield* store.startScan({
					orgId: orgA,
					repositoryId: repo,
					commitSha: sha("b"),
					ref: "main",
					trigger: "schedule",
					defaultBranchHead: true,
				})
				yield* TestClock.adjust("1 second")
				// The newer head drops lodash and settles first.
				yield* scan(store, "c", [])
				yield* store.completeScan({
					orgId: orgA,
					scanId: older.id,
					lockfiles: [lockfile("bun.lock")],
					packageCount: 10,
					matches: [match("lodash")],
				})
				const rows = yield* findings(store)
				assert.deepStrictEqual(
					rows.map((row) => [row.packageName, row.status, row.fixedSha]),
					[["lodash", "fixed", sha("c")]],
				)
			}),
		),
	)

	it.effect("opens a finding per advisory, merging the versions one lockfile pins", () =>
		withStore((store) =>
			Effect.gen(function* () {
				const settled = yield* scan(store, "a", [
					match("lodash", { version: "4.17.20", severity: "medium", relation: "transitive" }),
					match("lodash", { version: "4.17.11", severity: "critical", relation: "direct" }),
					match("minimist"),
				])
				assert.strictEqual(settled.status, "completed")
				assert.strictEqual(settled.vulnerableCount, 3)
				const rows = yield* findings(store)
				assert.deepStrictEqual(
					rows.map((row) => [
						row.packageName,
						row.status,
						row.severity,
						row.relation,
						row.versions,
					]),
					[
						["lodash", "open", "critical", "direct", ["4.17.11", "4.17.20"]],
						["minimist", "open", "high", "transitive", ["1.0.0"]],
					],
				)
				assert.strictEqual(rows[0]?.firstSeenSha, sha("a"))
			}),
		),
	)

	it.effect("fixes a finding a later scan no longer matches, and reopens it when it comes back", () =>
		withStore((store) =>
			Effect.gen(function* () {
				const first = yield* scan(store, "a", [match("lodash")])
				const second = yield* scan(store, "b", [])
				const [fixed] = yield* findings(store)
				assert.strictEqual(fixed?.status, "fixed")
				assert.strictEqual(fixed?.fixedScanId, second.id)
				assert.strictEqual(fixed?.fixedSha, sha("b"))

				const third = yield* scan(store, "c", [match("lodash")])
				const [reopened] = yield* findings(store)
				assert.strictEqual(reopened?.status, "open")
				assert.strictEqual(reopened?.fixedScanId, null)
				assert.strictEqual(reopened?.fixedSha, null)
				assert.strictEqual(reopened?.firstSeenScanId, first.id)
				assert.strictEqual(reopened?.firstSeenSha, sha("a"))
				assert.strictEqual(reopened?.lastSeenScanId, third.id)
				assert.strictEqual(reopened?.id, fixed?.id)
			}),
		),
	)

	it.effect("keeps a dismissed finding dismissed across scans that find or miss it", () =>
		withStore((store) =>
			Effect.gen(function* () {
				yield* scan(store, "a", [match("lodash")])
				const [open] = yield* findings(store)
				assert.isDefined(open)
				if (open === undefined) return
				yield* store.setFindingStatus({
					orgId: orgA,
					id: open.id,
					status: "dismissed",
					reason: "not reachable",
					actor: user,
				})
				const later = yield* scan(store, "b", [match("lodash", { severity: "critical" })])
				const [found] = yield* findings(store)
				assert.strictEqual(found?.status, "dismissed")
				assert.strictEqual(found?.severity, "critical")
				assert.strictEqual(found?.lastSeenScanId, later.id)
				assert.strictEqual(found?.statusChangedBy, user)

				yield* scan(store, "c", [])
				const [missed] = yield* findings(store)
				assert.strictEqual(missed?.status, "dismissed")
				assert.strictEqual(missed?.fixedScanId, null)
			}),
		),
	)

	it.effect("leaves a lockfile's findings open when the lockfile could not be read", () =>
		withStore((store) =>
			Effect.gen(function* () {
				const both = [lockfile("bun.lock"), lockfile("api/go.sum")]
				yield* scan(
					store,
					"a",
					[
						match("lodash"),
						match("x/net", { lockfilePath: "api/go.sum", ecosystem: "Go", severity: "low" }),
					],
					{
						lockfiles: both,
					},
				)
				yield* scan(store, "b", [], {
					lockfiles: [lockfile("bun.lock", "failed"), lockfile("api/go.sum", "too_large")],
				})
				const rows = yield* findings(store)
				assert.deepStrictEqual(
					rows.map((row) => [row.packageName, row.status]),
					[
						["lodash", "open"],
						["x/net", "open"],
					],
				)
			}),
		),
	)

	it.effect("fixes the findings of a lockfile the repository no longer has", () =>
		withStore((store) =>
			Effect.gen(function* () {
				yield* scan(
					store,
					"a",
					[
						match("lodash"),
						match("serde", {
							lockfilePath: "Cargo.lock",
							ecosystem: "crates.io",
							severity: "low",
						}),
					],
					{
						lockfiles: [lockfile("bun.lock"), lockfile("Cargo.lock")],
					},
				)
				const removal = yield* scan(store, "b", [match("lodash")], {
					lockfiles: [lockfile("bun.lock")],
				})
				const rows = yield* findings(store)
				assert.deepStrictEqual(
					rows.map((row) => [row.packageName, row.status, row.fixedSha]),
					[
						["lodash", "open", null],
						["serde", "fixed", removal.commitSha],
					],
				)
			}),
		),
	)

	it.effect("stores a production scan's matches without touching the findings", () =>
		withStore((store) =>
			Effect.gen(function* () {
				yield* scan(store, "a", [match("lodash")])
				const production = yield* scan(store, "b", [match("minimist", { version: "0.0.8" })], {
					trigger: "production",
				})
				const rows = yield* findings(store)
				assert.deepStrictEqual(
					rows.map((row) => [row.packageName, row.status]),
					[["lodash", "open"]],
				)
				const matches = yield* store.scanMatches({ orgId: orgA, scanId: production.id })
				assert.deepStrictEqual(
					matches.map((row) => [row.packageName, row.version, row.advisoryId]),
					[["minimist", "0.0.8", "GHSA-minimist"]],
				)
			}),
		),
	)
})

describe("DependencyScanStore scans", () => {
	it.effect("refuses to settle a scan twice and records a failure", () =>
		withStore((store) =>
			Effect.gen(function* () {
				const started = yield* store.startScan({
					orgId: orgA,
					repositoryId: repo,
					commitSha: sha("a"),
					ref: "main",
					trigger: "manual",
					defaultBranchHead: true,
				})
				const failed = yield* store.failScan({
					orgId: orgA,
					scanId: started.id,
					error: "clone failed",
				})
				assert.strictEqual(failed.status, "failed")
				assert.strictEqual(failed.error, "clone failed")
				const again = yield* store
					.completeScan({
						orgId: orgA,
						scanId: started.id,
						lockfiles: [],
						packageCount: 0,
						matches: [],
					})
					.pipe(Effect.flip)
				assert.strictEqual(again._tag, "@maple/dependency-scan/DependencyScanNotRunningError")
			}),
		),
	)

	it.effect("reads the latest completed scan, optionally at one commit", () =>
		withStore((store) =>
			Effect.gen(function* () {
				const first = yield* scan(store, "a", [])
				yield* TestClock.adjust("1 minute")
				const second = yield* scan(store, "b", [])
				yield* TestClock.adjust("1 minute")
				yield* store.startScan({
					orgId: orgA,
					repositoryId: repo,
					commitSha: sha("c"),
					ref: "main",
					trigger: "push",
					defaultBranchHead: true,
				})
				const latest = yield* store.latestScan({ orgId: orgA, repositoryId: repo })
				assert.strictEqual(Option.getOrUndefined(latest)?.id, second.id)
				const atA = yield* store.latestScan({ orgId: orgA, repositoryId: repo, commitSha: sha("a") })
				assert.strictEqual(Option.getOrUndefined(atA)?.id, first.id)
				assert.deepStrictEqual(Option.getOrUndefined(atA)?.lockfiles, [lockfile("bun.lock")])
				const scans = yield* store.listScans({ orgId: orgA, repositoryId: repo, limit: 10 })
				assert.deepStrictEqual(
					scans.map((row) => [row.commitSha, row.status]),
					[
						[sha("c"), "running"],
						[sha("b"), "completed"],
						[sha("a"), "completed"],
					],
				)
			}),
		),
	)

	it.effect("keeps one org's scans and findings out of another's reach", () =>
		withStore((store) =>
			Effect.gen(function* () {
				const settled = yield* scan(store, "a", [match("lodash")])
				const [finding] = yield* findings(store)
				assert.isDefined(finding)
				if (finding === undefined) return

				assert.deepStrictEqual(yield* findings(store, orgB), [])
				assert.isTrue(Option.isNone(yield* store.getFinding({ orgId: orgB, id: finding.id })))
				assert.deepStrictEqual(yield* store.listScans({ orgId: orgB, limit: 10 }), [])
				assert.deepStrictEqual(yield* store.scanMatches({ orgId: orgB, scanId: settled.id }), [])
				assert.isTrue(Option.isNone(yield* store.latestScan({ orgId: orgB, repositoryId: repo })))

				const update = yield* store
					.setFindingStatus({
						orgId: orgB,
						id: finding.id,
						status: "dismissed",
						reason: null,
						actor: user,
					})
					.pipe(Effect.flip)
				assert.strictEqual(update._tag, "@maple/dependency-scan/DependencyFindingNotFoundError")
				const fail = yield* store
					.failScan({ orgId: orgB, scanId: settled.id, error: "x" })
					.pipe(Effect.flip)
				assert.strictEqual(fail._tag, "@maple/dependency-scan/DependencyScanNotFoundError")

				const stored = yield* store.getFinding({ orgId: orgA, id: finding.id })
				assert.strictEqual(Option.getOrUndefined(stored)?.status, "open")
			}),
		),
	)
})
