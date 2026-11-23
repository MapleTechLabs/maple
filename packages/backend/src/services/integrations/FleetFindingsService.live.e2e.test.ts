// Opt-in live check: connects to real Fleet servers and compares the Devices page and the audit
// log with what `scripts/fleet-live/up.sh` seeded. Start the servers with that script (it needs
// Docker), then run the command it prints.
import { afterEach, assert, describe, it } from "@effect/vitest"
import type { AuditTrailEvent } from "@maple/domain/audit-trail"
import type { DeviceRef } from "@maple/domain/device-security"
import { OrgId, UserId } from "@maple/domain/http"
import { Array as Arr, Effect, Layer, Option, Schema } from "effect"
import { FetchHttpClient } from "effect/http"
import { cleanupTestDbs, createTestDb, type TestDb } from "@maple/backend/testing/test-pglite"
import { AuditTrailService } from "@maple/backend/services/audit-trail/AuditTrailService"
import { DeviceSecurityService } from "@maple/backend/services/device-security/DeviceSecurityService"
import { FleetAuditService } from "./FleetAuditService"
import { FleetConnectionService } from "./FleetConnectionService"
import { FleetFindingsService } from "./FleetFindingsService"
import { fleetDeps } from "./fleet/fake-fleet"

const Target = Schema.Struct({
	/** Where the server listens, e.g. `https://localhost:8495`. */
	url: Schema.String,
	/** An API-only Observer's token. */
	token: Schema.String,
	version: Schema.String,
	tier: Schema.Literals(["premium", "free"]),
})
type Target = typeof Target.Type

const targets = Option.getOrElse(
	Schema.decodeOption(Schema.fromJsonString(Schema.Array(Target)))(process.env.FLEET_LIVE_TARGETS ?? "[]"),
	(): ReadonlyArray<Target> => [],
)

const trackedDbs: Array<TestDb> = []
afterEach(() => cleanupTestDbs(trackedDbs))

const ORG = Schema.decodeSync(OrgId)("org_fleet_live")
const USER = Schema.decodeSync(UserId)("user_fleet_live")

/** The address Maple is given: a public name, since it refuses to connect to a local one. */
const PUBLIC_URL = "https://fleet-live.example.com"

/** Sends what Maple addresses to {@link PUBLIC_URL} to the local server instead. */
const toLocalServer = (target: Target) =>
	Layer.succeed(FetchHttpClient.Fetch, (input, init) => {
		const asked = new URL(input instanceof Request ? input.url : input)
		const local = new URL(target.url)
		return globalThis.fetch(new URL(`${asked.pathname}${asked.search}`, local), init)
	})

const run = <A, E>(
	target: Target,
	written: Array<AuditTrailEvent>,
	effect: Effect.Effect<
		A,
		E,
		FleetFindingsService | FleetConnectionService | DeviceSecurityService | FleetAuditService
	>,
) => {
	const deps = fleetDeps(createTestDb(trackedDbs), toLocalServer(target))
	const findings = Layer.effect(FleetFindingsService, FleetFindingsService.make).pipe(Layer.provide(deps))
	const trail = Layer.succeed(AuditTrailService, {
		write: (_orgId, events) => Effect.sync(() => void written.push(...events)),
		list: () => Effect.die("unused"),
		count: () => Effect.die("unused"),
		providerStats: () => Effect.die("unused"),
	})
	return effect.pipe(
		Effect.provide([
			Layer.effect(DeviceSecurityService, DeviceSecurityService.make).pipe(
				Layer.provideMerge(findings),
				Layer.provide(deps),
			),
			Layer.effect(FleetConnectionService, FleetConnectionService.make).pipe(Layer.provide(deps)),
			Layer.effect(FleetAuditService, FleetAuditService.make).pipe(
				Layer.provide(Layer.merge(deps, trail)),
			),
		]),
	)
}

// What up.sh seeds: [policy, the fleet it belongs to, failing devices, passing devices].
const GLOBAL = [["No compromised packages", null, 4, 0]]
const EVERY_SCOPE = [
	...GLOBAL,
	["Disk encrypted", "Engineering laptops", 1, 1],
	["Screen lock on", "Engineering laptops", 2, 0],
	["SSH root login off", "Build servers", 1, 0],
	["Enrolled in a fleet", "Unassigned", 1, 0],
]

describe.skipIf(targets.length === 0)("Fleet integration against real Fleet servers", () => {
	it.live.each(targets)("reads every policy of Fleet $version ($tier)", (target) => {
		const written: Array<AuditTrailEvent> = []
		return run(
			target,
			written,
			Effect.gen(function* () {
				const card = yield* FleetConnectionService.use((service) =>
					service.connect(ORG, USER, { url: PUBLIC_URL, token: target.token }),
				)
				assert.deepStrictEqual(
					[card.connected, card.serverVersion, card.licenseTier, card.apiUserRole],
					[true, target.version, target.tier, "observer"],
				)

				const synced = yield* FleetFindingsService.use((service) => service.syncDue)
				const after = yield* FleetConnectionService.use((service) => service.getStatus(ORG))
				assert.isNull(after.lastError)
				assert.strictEqual(synced.failedConnections, 0)

				const page = yield* DeviceSecurityService.use((service) => service.devices(ORG))
				assert.deepStrictEqual(
					Arr.map(page.sources, (source) => source.deviceCount),
					[4],
				)
				assert.sameDeepMembers(
					Arr.map(page.policies, (policy) => [
						policy.name,
						policy.groupName,
						policy.failingDeviceCount,
						policy.passingDeviceCount,
					]),
					target.tier === "premium" ? EVERY_SCOPE : GLOBAL,
				)
				const failingOf = (name: string) =>
					Arr.map(
						Arr.findFirst(page.policies, (policy) => policy.name === name).pipe(
							Option.map((policy) => policy.failingDevices),
							Option.getOrElse((): ReadonlyArray<DeviceRef> => []),
						),
						(device) => device.name,
					)
				assert.sameMembers(failingOf("No compromised packages"), [
					"ws-ada",
					"ws-bob",
					"srv-cid",
					"stray-dee",
				])
				if (target.tier === "premium") {
					assert.deepStrictEqual(failingOf("Disk encrypted"), ["ws-bob"])
					assert.deepStrictEqual(failingOf("Enrolled in a fleet"), ["stray-dee"])
				}

				// The audit log: what the seeding did shows up, each entry naming what it was about.
				const polled = yield* FleetAuditService.use((service) => service.pollAll)
				assert.strictEqual(polled.failedConnections, 0)
				const about = (name: string) =>
					Arr.map(
						Arr.filter(written, (event) => event.target?.name === name),
						(event) => `${event.category} ${event.target?.type}`,
					)
				assert.deepStrictEqual(about("No compromised packages"), ["configuration policy"])
				// Creating the fleet, then moving a device into it.
				if (target.tier === "premium")
					assert.deepStrictEqual(about("Build servers"), ["configuration fleet", "resource fleet"])
			}),
		)
	})
})
