import { afterEach, assert, describe, it } from "@effect/vitest"
import { OrgId, UserId } from "@maple/domain/http"
import { Array as Arr, Effect, Layer, Option, Schema, String as Str } from "effect"
import { TestClock } from "effect/testing"
import * as VendorFake from "@maple/backend/testing/vendor-fake"
import { cleanupTestDbs, createTestDb, queryFirstRow, type TestDb } from "@maple/backend/testing/test-pglite"
import { DeviceSecurityService } from "@maple/backend/services/device-security/DeviceSecurityService"
import { FleetConnectionService } from "./FleetConnectionService"
import { FleetFindingsService } from "./FleetFindingsService"
import { type FakeFleet, fakeFleetDeps, makeFakeFleet } from "./fleet/fake-fleet"

const trackedDbs: TestDb[] = []
afterEach(() => cleanupTestDbs(trackedDbs))

const ORG = Schema.decodeSync(OrgId)("org_fleet")
const OTHER_ORG = Schema.decodeSync(OrgId)("org_other")
const USER = Schema.decodeSync(UserId)("user_fleet")
const HOUR_MS = 60 * 60_000

const run = <A, E>(
	testDb: TestDb,
	world: FakeFleet,
	effect: Effect.Effect<A, E, FleetFindingsService | FleetConnectionService | DeviceSecurityService>,
) => {
	const deps = fakeFleetDeps(testDb, world)
	const findings = Layer.effect(FleetFindingsService, FleetFindingsService.make).pipe(Layer.provide(deps))
	return effect.pipe(
		Effect.provide([
			Layer.effect(DeviceSecurityService, DeviceSecurityService.make).pipe(
				Layer.provideMerge(findings),
				Layer.provide(deps),
			),
			Layer.effect(FleetConnectionService, FleetConnectionService.make).pipe(Layer.provide(deps)),
		]),
	)
}

const connect = FleetConnectionService.use((service) =>
	service.connect(ORG, USER, { url: "https://fleet.example.com", token: "fleet-api-token-0123456789" }),
)
const syncDue = FleetFindingsService.use((service) => service.syncDue)
const devices = (orgId = ORG) => DeviceSecurityService.use((service) => service.devices(orgId))

/** Rows stored for the org, whatever the page shows. */
const storedFindings = (testDb: TestDb) =>
	Effect.promise(() =>
		queryFirstRow<{ policies: number; vulnerabilities: number }>(
			testDb,
			`SELECT (SELECT count(*)::int FROM device_policy_findings) AS policies,
				(SELECT count(*)::int FROM device_vulnerability_findings) AS vulnerabilities`,
		),
	)

const fleetWithFindings = () =>
	makeFakeFleet({
		hostCount: 40,
		policies: [
			{ id: 1, name: "Firewall on", failing_host_count: 3, passing_host_count: 37 },
			{ id: 2, name: "Disk encrypted", critical: true, failing_host_count: 1, passing_host_count: 39 },
			{ id: 3, name: "OS up to date", failing_host_count: 0, passing_host_count: 40 },
		],
		failingHosts: {
			1: [{ id: 11, hostname: "jane-mbp" }],
			2: [{ id: 12, hostname: "build-box" }],
		},
		software: [
			{
				id: 100,
				name: "openssl",
				version: "3.0.1",
				hosts_count: 5,
				vulnerabilities: [{ cve: "CVE-2026-0001", cvss_score: 7.5 }],
			},
			{
				id: 101,
				name: "openssl",
				version: "3.0.2",
				hosts_count: 2,
				vulnerabilities: [{ cve: "CVE-2026-0001", cvss_score: 7.5 }],
			},
			{
				id: 102,
				name: "chrome",
				version: "120",
				hosts_count: 9,
				vulnerabilities: [{ cve: "CVE-2026-0002", cvss_score: 9.8 }],
			},
		],
	})

describe("FleetFindingsService", () => {
	it.effect("lists failing policies and CVEs with links into the Fleet server", () => {
		const testDb = createTestDb(trackedDbs)
		const world = fleetWithFindings()
		return run(
			testDb,
			world,
			Effect.gen(function* () {
				yield* connect
				const synced = yield* syncDue
				assert.deepStrictEqual(synced, {
					connections: 1,
					failedConnections: 0,
					policies: 2,
					vulnerabilities: 2,
				})

				const page = yield* devices()
				assert.deepStrictEqual(
					Arr.map(page.sources, (source) => [source.kind, source.deviceCount]),
					[["fleet", 40]],
				)
				// Critical first; the passing policy is not a finding.
				assert.deepStrictEqual(
					Arr.map(page.policies, (policy) => [policy.name, policy.failingDeviceCount, policy.url]),
					[
						["Disk encrypted", 1, "https://fleet.example.com/policies/2"],
						["Firewall on", 3, "https://fleet.example.com/policies/1"],
					],
				)
				assert.deepStrictEqual(page.policies[1]?.failingDevices, [
					{ id: "11", name: "jane-mbp", platform: null, url: "https://fleet.example.com/hosts/11" },
				])
				// One finding per CVE across its versions, highest score first.
				assert.deepStrictEqual(
					Arr.map(page.vulnerabilities, (finding) => [
						finding.cve,
						finding.cvssScore,
						finding.deviceCount,
						finding.software.length,
					]),
					[
						["CVE-2026-0002", 9.8, 9, 1],
						["CVE-2026-0001", 7.5, 7, 2],
					],
				)
				// Another org sees nothing of it.
				assert.lengthOf((yield* devices(OTHER_ORG)).sources, 0)
			}),
		)
	})

	it.effect("waits an hour between syncs, and drops what was fixed meanwhile", () => {
		const testDb = createTestDb(trackedDbs)
		const world = fleetWithFindings()
		return run(
			testDb,
			world,
			Effect.gen(function* () {
				yield* connect
				yield* syncDue
				const firstSeen = (yield* devices()).policies[1]?.firstSeenAt

				world.policies = [
					{ id: 1, name: "Firewall on", failing_host_count: 2, passing_host_count: 38 },
				]
				world.software = []
				assert.strictEqual((yield* syncDue).connections, 0)

				yield* TestClock.adjust(HOUR_MS)
				yield* syncDue
				const page = yield* devices()
				assert.deepStrictEqual(
					Arr.map(page.policies, (policy) => [policy.name, policy.failingDeviceCount]),
					[["Firewall on", 2]],
				)
				// A finding still open keeps the time it was first seen.
				assert.strictEqual(page.policies[0]?.firstSeenAt, firstSeen)
				assert.lengthOf(page.vulnerabilities, 0)
			}),
		)
	})

	it.effect("keeps the last findings and reports why when the server fails", () => {
		const testDb = createTestDb(trackedDbs)
		const world = fleetWithFindings()
		return run(
			testDb,
			world,
			Effect.gen(function* () {
				yield* connect
				yield* syncDue
				yield* TestClock.adjust(HOUR_MS)
				world.status = 500
				// 5xx answers are retried with back-off first.
				assert.strictEqual((yield* VendorFake.elapsing(syncDue)).failedConnections, 1)
				const page = yield* devices()
				assert.lengthOf(page.policies, 2)
				assert.include(page.sources[0]?.error ?? "", "500")
				// The Fleet card says the device sync is failing, though the activity feed is fine.
				const card = yield* FleetConnectionService.use((service) => service.getStatus(ORG))
				assert.include(card.lastError ?? "", "Devices sync: ")

				// A failed sync waits 15 minutes rather than hitting the server every tick.
				world.status = null
				const calls = world.fake.calls.length
				yield* TestClock.adjust(10 * 60_000)
				assert.strictEqual((yield* syncDue).connections, 0)
				assert.strictEqual(world.fake.calls.length, calls)

				// A new token clears the failure the page shows.
				yield* connect
				assert.isNull((yield* devices()).sources[0]?.error)
			}),
		)
	})

	it.effect("forgets the findings with the connection", () => {
		const testDb = createTestDb(trackedDbs)
		const world = fleetWithFindings()
		return run(
			testDb,
			world,
			Effect.gen(function* () {
				yield* connect
				yield* syncDue
				yield* FleetConnectionService.use((service) => service.disconnect(ORG))
				const page = yield* devices()
				assert.deepStrictEqual(
					[page.sources.length, page.policies.length, page.vulnerabilities.length],
					[0, 0, 0],
				)
				assert.deepStrictEqual(yield* storedFindings(testDb), { policies: 0, vulnerabilities: 0 })
			}),
		)
	})
	it.effect("keeps the findings when the same server gets a new token", () => {
		const testDb = createTestDb(trackedDbs)
		const world = fleetWithFindings()
		return run(
			testDb,
			world,
			Effect.gen(function* () {
				yield* connect
				yield* syncDue
				yield* connect
				assert.deepStrictEqual(yield* storedFindings(testDb), { policies: 2, vulnerabilities: 2 })
				assert.lengthOf((yield* devices()).policies, 2)
			}),
		)
	})

	it.effect("stops both readers when Fleet rejects the token", () => {
		const testDb = createTestDb(trackedDbs)
		const world = fleetWithFindings()
		return run(
			testDb,
			world,
			Effect.gen(function* () {
				yield* connect
				world.status = 401
				assert.strictEqual((yield* syncDue).failedConnections, 1)
				const page = yield* devices()
				assert.isTrue(page.sources[0]?.authFailed)
				// Nothing is due while the token stays rejected, even an hour on.
				yield* TestClock.adjust(HOUR_MS)
				const calls = world.fake.calls.length
				assert.strictEqual((yield* syncDue).connections, 0)
				assert.strictEqual(world.fake.calls.length, calls)
			}),
		)
	})

	it.effect("holds a rate limited server, at most an hour whatever it asks", () => {
		const testDb = createTestDb(trackedDbs)
		const world = fleetWithFindings()
		return run(
			testDb,
			world,
			Effect.gen(function* () {
				yield* connect
				world.status = 429
				assert.strictEqual((yield* syncDue).failedConnections, 1)
				world.status = null
				yield* TestClock.adjust(10 * 60_000)
				assert.strictEqual((yield* syncDue).connections, 0)
				yield* TestClock.adjust(5 * 60_000)
				assert.strictEqual((yield* syncDue).policies, 2)
			}),
		)
	})

	it.effect("stores thousands of CVEs, and keeps those a cut-off read did not reach", () => {
		const testDb = createTestDb(trackedDbs)
		const versions = (from: number) =>
			Arr.makeBy(1_050 - from, (offset) => {
				const index = from + offset
				return {
					id: index,
					name: `pkg-${index}`,
					version: "1.0",
					hosts_count: 2_000 - index,
					vulnerabilities: Arr.makeBy(6, (n) => ({ cve: `CVE-2026-${index}-${n}` })),
				}
			})
		const world = makeFakeFleet({ software: versions(0) })
		return run(
			testDb,
			world,
			Effect.gen(function* () {
				yield* connect
				// 1,000 versions read, six CVEs each: more values than one INSERT may bind.
				assert.strictEqual((yield* syncDue).vulnerabilities, 6_000)
				assert.deepStrictEqual(yield* storedFindings(testDb), { policies: 0, vulnerabilities: 6_000 })

				// The most installed version is gone, but the read stops at ten pages again, so the
				// CVEs it did not reach are not taken as fixed.
				world.software = versions(1)
				yield* TestClock.adjust(HOUR_MS)
				yield* syncDue
				assert.strictEqual((yield* storedFindings(testDb))?.vulnerabilities, 6_006)

				// A day on, still never reached, they are taken as gone.
				yield* TestClock.adjust(25 * HOUR_MS)
				yield* syncDue
				assert.strictEqual((yield* storedFindings(testDb))?.vulnerabilities, 6_000)

				// A read that reaches the end drops what is gone.
				world.software = Arr.take(versions(0), 3)
				yield* TestClock.adjust(HOUR_MS)
				yield* syncDue
				assert.strictEqual((yield* storedFindings(testDb))?.vulnerabilities, 18)
			}),
		)
	})

	/** A Premium server as most are set up: a few global policies, most on fleets. */
	const fleetWithFleets = (version: string) =>
		makeFakeFleet({
			version,
			tier: "premium",
			hostCount: 4,
			policies: [
				{
					id: 1,
					name: "No compromised packages",
					critical: true,
					failing_host_count: 4,
					passing_host_count: 0,
				},
				{ id: 2, name: "Agent reporting", failing_host_count: 0, passing_host_count: 4 },
			],
			fleets: [
				{ id: 2, name: "Workstations" },
				{ id: 3, name: "Servers" },
			],
			fleetPolicies: {
				0: [{ id: 8, name: "Enrolled in a fleet", failing_host_count: 1, passing_host_count: 0 }],
				2: [
					{
						id: 4,
						name: "Disk encrypted",
						critical: true,
						failing_host_count: 1,
						passing_host_count: 1,
					},
					{ id: 5, name: "Screen lock on", failing_host_count: 2, passing_host_count: 0 },
					{ id: 6, name: "OS up to date", failing_host_count: 0, passing_host_count: 2 },
				],
				3: [{ id: 7, name: "SSH root login off", failing_host_count: 1, passing_host_count: 0 }],
			},
			failingHosts: { 4: [{ id: 12, hostname: "ws-bob" }] },
		})

	const listedPolicies = Effect.map(devices(), (page) =>
		Arr.map(page.policies, (policy) => [policy.name, policy.groupName, policy.failingDeviceCount]),
	)

	const EVERY_SCOPE = [
		["No compromised packages", null, 4],
		["Disk encrypted", "Workstations", 1],
		["Screen lock on", "Workstations", 2],
		["Enrolled in a fleet", "Unassigned", 1],
		["SSH root login off", "Servers", 1],
	]

	// Each version keeps fleets and their policies somewhere else; the fake answers as each does.
	it.effect.each([
		["4.62.0", "before fleets were renamed from teams"],
		["4.95.0", "Fleet 4 with fleets"],
		["5.0.0", "Fleet 5, which removed the per-scope paths"],
		["5.0.0-rc.2611231818", "a Fleet 5 release candidate"],
	] as const)("lists global, fleet and unassigned policies with their fleet on %s (%s)", ([version]) => {
		const testDb = createTestDb(trackedDbs)
		const world = fleetWithFleets(version)
		return run(
			testDb,
			world,
			Effect.gen(function* () {
				yield* connect
				assert.deepStrictEqual(yield* syncDue, {
					connections: 1,
					failedConnections: 0,
					policies: 5,
					vulnerabilities: 0,
				})
				assert.sameDeepMembers(yield* listedPolicies, EVERY_SCOPE)
				// A fleet's policy samples its failing devices like a global one.
				const page = yield* devices()
				assert.deepStrictEqual(
					Arr.map(
						Arr.filter(page.policies, (policy) => policy.name === "Disk encrypted"),
						(policy) => Arr.map(policy.failingDevices, (device) => device.name),
					),
					[["ws-bob"]],
				)
			}),
		)
	})

	it.effect.each([["4.56.0"], ["unknown"]] as const)(
		"skips the devices in no fleet on a server from before they had policies (%s)",
		([version]) => {
			const testDb = createTestDb(trackedDbs)
			// Before 4.57 fleet 0 is not a fleet: asking for its policies answers 404.
			const world = fleetWithFleets(version)
			world.era = "legacy"
			return run(
				testDb,
				world,
				Effect.gen(function* () {
					yield* connect
					assert.strictEqual((yield* syncDue).failedConnections, 0)
					assert.sameDeepMembers(
						yield* listedPolicies,
						Arr.filter(EVERY_SCOPE, ([, fleet]) => fleet !== "Unassigned"),
					)
				}),
			)
		},
	)

	it.effect.each([["4.62.0"], ["4.95.0"], ["5.0.0"]] as const)(
		"reads only global policies on Fleet Free, which has no fleets (%s)",
		([version]) => {
			const testDb = createTestDb(trackedDbs)
			const world = makeFakeFleet({
				version,
				policies: [{ id: 1, name: "Firewall on", failing_host_count: 3, passing_host_count: 1 }],
			})
			return run(
				testDb,
				world,
				Effect.gen(function* () {
					yield* connect
					assert.strictEqual((yield* syncDue).failedConnections, 0)
					assert.deepStrictEqual(yield* listedPolicies, [["Firewall on", null, 3]])
				}),
			)
		},
	)

	it.effect("keeps syncing when the server is upgraded to Fleet 5, and shows its new version", () => {
		const testDb = createTestDb(trackedDbs)
		const world = fleetWithFleets("4.95.0")
		return run(
			testDb,
			world,
			Effect.gen(function* () {
				yield* connect
				yield* syncDue
				assert.sameDeepMembers(yield* listedPolicies, EVERY_SCOPE)

				// Fleet 5 answers 410 on every path the 4.95 read used.
				world.version = "5.0.0"
				world.fleetPolicies = { ...world.fleetPolicies, 3: [] }
				yield* TestClock.adjust(HOUR_MS)
				assert.strictEqual((yield* syncDue).failedConnections, 0)
				assert.sameDeepMembers(
					yield* listedPolicies,
					Arr.filter(EVERY_SCOPE, ([name]) => name !== "SSH root login off"),
				)
				const card = yield* FleetConnectionService.use((service) => service.getStatus(ORG))
				assert.strictEqual(card.serverVersion, "5.0.0")
				assert.isNull(card.lastError)
			}),
		)
	})

	it.effect("fails the sync, keeping the last findings, when a listed fleet cannot be read", () => {
		const testDb = createTestDb(trackedDbs)
		const world = fleetWithFleets("5.0.0")
		return run(
			testDb,
			world,
			Effect.gen(function* () {
				yield* connect
				yield* syncDue
				// Reading the fleet as empty would resolve a finding that is still open.
				world.vanishedFleets = [3]
				yield* TestClock.adjust(HOUR_MS)
				assert.strictEqual((yield* syncDue).failedConnections, 1)
				assert.sameDeepMembers(yield* listedPolicies, EVERY_SCOPE)
				// The card names the fleet that went, not the server's address.
				const card = yield* FleetConnectionService.use((service) => service.getStatus(ORG))
				assert.include(card.lastError ?? "", 'no longer has "Servers"')
			}),
		)
	})

	// A build from a commit reports no release, so the paths are found by trying each era's.
	it.effect.each([
		["unknown", "teams"],
		["a1b2c3d", "fleets"],
		["unknown", "fleet5"],
	] as const)("finds the paths of a server whose version %s names no release (%s)", ([version, era]) => {
		const testDb = createTestDb(trackedDbs)
		const world = fleetWithFleets(version)
		world.era = era
		return run(
			testDb,
			world,
			Effect.gen(function* () {
				yield* connect
				assert.strictEqual((yield* syncDue).failedConnections, 0)
				assert.sameDeepMembers(yield* listedPolicies, EVERY_SCOPE)
			}),
		)
	})

	it.effect("reads the release out of a build's longer version", () => {
		const testDb = createTestDb(trackedDbs)
		const world = fleetWithFleets("fleet-v4.95.0-12-gabcdef0")
		return run(
			testDb,
			world,
			Effect.gen(function* () {
				yield* connect
				assert.strictEqual((yield* syncDue).failedConnections, 0)
				assert.sameDeepMembers(yield* listedPolicies, EVERY_SCOPE)
				// 4.95's own paths, with no request spent on another era's.
				assert.isFalse(
					Arr.some(world.fake.calls, (call) => Str.endsWith("/fleet/policies")(call.path)),
				)
			}),
		)
	})

	const manyFleets = (count: number) =>
		Arr.makeBy(count, (index) => ({ id: index + 10, name: `fleet-${index + 10}` }))

	it.effect("reads every fleet of a server with more than one page of them", () => {
		const testDb = createTestDb(trackedDbs)
		const world = fleetWithFleets("5.0.0")
		// The last fleet listed, on the second page, holds a failing policy.
		world.fleets = manyFleets(600)
		world.fleetPolicies = {
			609: [{ id: 90, name: "Last fleet's policy", failing_host_count: 2, passing_host_count: 0 }],
		}
		return run(
			testDb,
			world,
			Effect.gen(function* () {
				yield* connect
				assert.strictEqual((yield* syncDue).failedConnections, 0)
				assert.sameDeepMembers(yield* listedPolicies, [
					["No compromised packages", null, 4],
					["Last fleet's policy", "fleet-609", 2],
				])
			}),
		)
	})

	it.effect("fails the sync rather than read only some fleets of a server with too many", () => {
		const testDb = createTestDb(trackedDbs)
		const world = fleetWithFleets("5.0.0")
		return run(
			testDb,
			world,
			Effect.gen(function* () {
				yield* connect
				yield* syncDue
				world.fleets = manyFleets(1_001)
				yield* TestClock.adjust(HOUR_MS)
				assert.strictEqual((yield* syncDue).failedConnections, 1)
				// The findings read before stay, and the card says why nothing new was read.
				assert.sameDeepMembers(yield* listedPolicies, EVERY_SCOPE)
				const card = yield* FleetConnectionService.use((service) => service.getStatus(ORG))
				assert.include(card.lastError ?? "", "1001 fleets. Maple reads the policies of at most 1000")
			}),
		)
	})

	it.effect("stores a policy once when a fleet's read repeats a global one", () => {
		const testDb = createTestDb(trackedDbs)
		const world = fleetWithFleets("5.0.0")
		world.fleetPolicies = {
			...world.fleetPolicies,
			3: [
				{
					id: 1,
					name: "No compromised packages",
					critical: true,
					failing_host_count: 4,
					passing_host_count: 0,
				},
				{ id: 7, name: "SSH root login off", failing_host_count: 1, passing_host_count: 0 },
			],
		}
		return run(
			testDb,
			world,
			Effect.gen(function* () {
				yield* connect
				assert.strictEqual((yield* syncDue).failedConnections, 0)
				assert.sameDeepMembers(yield* listedPolicies, EVERY_SCOPE)
			}),
		)
	})

	it.effect("says Fleet removed the endpoint, not that the address is wrong, on a 410", () => {
		const testDb = createTestDb(trackedDbs)
		const world = fleetWithFleets("5.0.0")
		return run(
			testDb,
			world,
			Effect.gen(function* () {
				yield* connect
				world.status = 410
				yield* syncDue
				const card = yield* FleetConnectionService.use((service) => service.getStatus(ORG))
				assert.include(card.lastError ?? "", "no longer serves")
				assert.notInclude(card.lastError ?? "", "Use the URL you open Fleet at")
			}),
		)
	})

	it.effect("reads every global policy across pages", () => {
		const testDb = createTestDb(trackedDbs)
		const world = makeFakeFleet({
			policies: Arr.makeBy(1_050, (index) => ({
				id: index + 1,
				name: `policy-${index + 1}`,
				failing_host_count: 1,
				passing_host_count: 0,
			})),
		})
		return run(
			testDb,
			world,
			Effect.gen(function* () {
				yield* connect
				// The fake answers 100 to a request without per_page, so only paging reads them all.
				assert.strictEqual((yield* syncDue).policies, 1_050)
			}),
		)
	})

	it.effect("stops paging policies on a server that ignores paging", () => {
		const testDb = createTestDb(trackedDbs)
		const world = makeFakeFleet({
			policyPaging: "ignored",
			policies: Arr.makeBy(700, (index) => ({
				id: index + 1,
				name: `policy-${index + 1}`,
				failing_host_count: 1,
				passing_host_count: 0,
			})),
		})
		return run(
			testDb,
			world,
			Effect.gen(function* () {
				yield* connect
				assert.strictEqual((yield* syncDue).policies, 700)
				// Page two repeats page one: nothing new, so no third request.
				const policyReads = Arr.filter(world.fake.calls, (call) =>
					Str.endsWith("/global/policies")(call.path),
				)
				assert.lengthOf(policyReads, 2)
			}),
		)
	})

	it.effect("counts each device once per CVE, from Fleet's own CVE list, and its total", () => {
		const testDb = createTestDb(trackedDbs)
		const world = fleetWithFindings()
		// One device carries both openssl versions: Fleet counts it once, the versions sum to 7.
		world.cves = [
			{ cve: "CVE-2026-0001", hosts_count: 6, cvss_score: 7.5 },
			{ cve: "CVE-2026-0002", hosts_count: 9, cvss_score: 9.8 },
			...Arr.makeBy(1_200, (index) => ({ cve: `CVE-2025-${index}`, hosts_count: 1 })),
		]
		return run(
			testDb,
			world,
			Effect.gen(function* () {
				yield* connect
				yield* syncDue
				const page = yield* devices()
				const openssl = Arr.findFirst(
					page.vulnerabilities,
					(finding) => finding.cve === "CVE-2026-0001",
				)
				assert.deepStrictEqual(
					Option.map(openssl, (finding) => [finding.deviceCount, finding.software.length]),
					Option.some([6, 2]),
				)
				// Ten pages of 100 are stored; the rest past the 500 listed comes from Fleet's total.
				assert.strictEqual(page.moreVulnerabilities, 1_202 - 500)
			}),
		)
	})

	it.effect("reads vulnerable software in pages, up to ten", () => {
		const testDb = createTestDb(trackedDbs)
		const world = makeFakeFleet({
			software: Arr.makeBy(1_050, (index) => ({
				id: index,
				name: `pkg-${index}`,
				version: "1.0",
				hosts_count: 1,
				vulnerabilities: [{ cve: `CVE-2026-${index}` }],
			})),
		})
		return run(
			testDb,
			world,
			Effect.gen(function* () {
				yield* connect
				assert.strictEqual((yield* syncDue).vulnerabilities, 1_000)
				const page = yield* devices()
				assert.lengthOf(page.vulnerabilities, 500)
				assert.strictEqual(page.moreVulnerabilities, 500)
			}),
		)
	})

	it.effect("starts over when the org connects another server", () => {
		const testDb = createTestDb(trackedDbs)
		const world = fleetWithFindings()
		return run(
			testDb,
			world,
			Effect.gen(function* () {
				yield* connect
				yield* syncDue
				world.policies = []
				world.software = []
				world.hostCount = 3
				yield* FleetConnectionService.use((service) =>
					service.connect(ORG, USER, {
						url: "https://devices.example.com",
						token: "fleet-api-token-0123456789",
					}),
				)
				const pending = yield* devices()
				assert.deepStrictEqual(
					[pending.sources[0]?.url, pending.sources[0]?.syncedAt, pending.policies.length],
					["https://devices.example.com", null, 0],
				)
				assert.deepStrictEqual(yield* storedFindings(testDb), { policies: 0, vulnerabilities: 0 })
				// A new server is due at once, not an hour after the old one's sync.
				yield* syncDue
				assert.strictEqual((yield* devices()).sources[0]?.deviceCount, 3)
			}),
		)
	})
})
