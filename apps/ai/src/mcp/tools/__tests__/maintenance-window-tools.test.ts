/**
 * The maintenance window tools through the registry, against the real service on PGlite:
 * schedule and matcher validation as invalid input, the window and silences they write,
 * and delete requiring confirm.
 */
import { afterEach, assert, describe, it } from "@effect/vitest"
import { ConfigProvider, Effect, Layer, Schema } from "effect"
import { OrgId, RoleName, UserId } from "@maple/domain/http"
import { ListMaintenanceWindowsOutput, MaintenanceWindowMutationOutput } from "@maple/domain/mcp-outputs"
import { encodePublicId, PublicIdPrefixes } from "@maple/domain/http/v2"
import { Env } from "@maple/backend/platform/Env"
import { EdgeCacheServiceLive } from "@maple/backend/platform/CacheBackendLive"
import { cleanupTestDbs, createTestDb, type TestDb } from "@maple/backend/platform/test-pglite"
import { AlertMaintenanceWindowsService } from "@maple/backend/services/alerts/AlertMaintenanceWindowsService"
import { AlertSilencesService } from "@maple/backend/services/alerts/AlertSilencesService"
import { CurrentMcpTenant } from "../../lib/query-warehouse"
import { executeRegisteredMcpToolUnscoped } from "../registry"
import { unimplementedMcpToolServices } from "../../../../test/mcp/unimplemented-tool-services"

const trackedDbs: TestDb[] = []
afterEach(() => cleanupTestDbs(trackedDbs))

const ORG = Schema.decodeSync(OrgId)("org_mcp_maintenance")

const layerFor = (testDb: TestDb) =>
	Layer.mergeAll(
		unimplementedMcpToolServices,
		AlertMaintenanceWindowsService.layer,
		AlertSilencesService.layer,
		Layer.succeed(CurrentMcpTenant, {
			orgId: ORG,
			userId: Schema.decodeSync(UserId)("user_mcp_maintenance"),
			roles: [Schema.decodeSync(RoleName)("root")],
			authMode: "self_hosted",
		}),
	).pipe(
		Layer.provide(Layer.mergeAll(testDb.layer, EdgeCacheServiceLive)),
		Layer.provideMerge(Env.layer),
		Layer.provide(
			ConfigProvider.layer(
				ConfigProvider.fromUnknown({
					TINYBIRD_HOST: "https://api.tinybird.co",
					TINYBIRD_TOKEN: "test-token",
					MAPLE_AUTH_MODE: "self_hosted",
					MAPLE_ROOT_PASSWORD: "test-root-password",
					MAPLE_DEFAULT_ORG_ID: "default",
					MAPLE_INGEST_KEY_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64"),
					MAPLE_INGEST_KEY_LOOKUP_HMAC_KEY: "maple-test-lookup-secret",
					INTERNAL_SERVICE_TOKEN: "test-internal-token",
				}),
			),
		),
	)

const call = (name: string, params: unknown) =>
	executeRegisteredMcpToolUnscoped(name, params, "mcp").pipe(Effect.result)

const text = (result: { readonly content: ReadonlyArray<{ readonly text: string }> }) =>
	result.content[0]?.text ?? ""

const weekly = {
	name: "Nightly vacuum",
	schedule_type: "weekly",
	time_zone: "Europe/Berlin",
	days: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"],
	start_time: "02:00",
	duration_minutes: "60",
}

describe("maintenance window tools", () => {
	it.effect("create_maintenance_window writes a weekly window and its silences; list shows it", () => {
		const testDb = createTestDb(trackedDbs)
		return Effect.gen(function* () {
			const created = yield* call("create_maintenance_window", { ...weekly, service_names: "checkout" })
			assert.strictEqual(created._tag, "Success")
			if (created._tag !== "Success") return
			const { window } = Schema.decodeUnknownSync(MaintenanceWindowMutationOutput)(
				created.success.structuredContent,
			)
			assert.deepStrictEqual(window.matchers, { services: ["checkout"] })
			assert.deepStrictEqual(window.schedule, {
				type: "weekly",
				timeZone: "Europe/Berlin",
				days: weekly.days,
				startTime: "02:00",
				durationMinutes: 60,
			})
			assert.isNotNull(window.nextOccurrence)
			assert.include(text(created.success), "Nightly vacuum")

			const silences = yield* AlertSilencesService.use((service) => service.list(ORG))
			assert.isTrue(silences.silences.some((silence) => silence.maintenanceWindowId === window.id))

			const listed = yield* call("list_maintenance_windows", {})
			assert.strictEqual(listed._tag, "Success")
			if (listed._tag !== "Success") return
			const output = Schema.decodeUnknownSync(ListMaintenanceWindowsOutput)(
				listed.success.structuredContent,
			)
			assert.deepStrictEqual(
				output.windows.map((row) => row.id),
				[window.id],
			)
		}).pipe(Effect.provide(layerFor(testDb)))
	})

	it.effect("create_maintenance_window turns a one-off duration into an end time", () => {
		const testDb = createTestDb(trackedDbs)
		return Effect.gen(function* () {
			const created = yield* call("create_maintenance_window", {
				name: "Migration",
				schedule_type: "once",
				starts_at: "2030-01-01 00:00:00",
				duration_minutes: 30,
				tags: ["db"],
			})
			assert.strictEqual(created._tag, "Success")
			if (created._tag !== "Success") return
			const { window } = Schema.decodeUnknownSync(MaintenanceWindowMutationOutput)(
				created.success.structuredContent,
			)
			assert.deepStrictEqual(window.schedule, {
				type: "once",
				startsAt: "2030-01-01T00:00:00.000Z",
				endsAt: "2030-01-01T00:30:00.000Z",
			})
		}).pipe(Effect.provide(layerFor(testDb)))
	})

	it.effect("refuses a window with no matcher, an unknown zone or a half-given weekly schedule", () => {
		const testDb = createTestDb(trackedDbs)
		return Effect.gen(function* () {
			const parameterOf = (result: Effect.Success<ReturnType<typeof call>>) =>
				result._tag === "Failure" && "parameter" in result.failure
					? result.failure.parameter
					: undefined
			const messageOf = (result: Effect.Success<ReturnType<typeof call>>) =>
				result._tag === "Failure" ? result.failure.message : ""

			const noMatcher = yield* call("create_maintenance_window", weekly)
			const noDays = yield* call("create_maintenance_window", { ...weekly, days: [], tags: ["db"] })
			const badZone = yield* call("create_maintenance_window", {
				...weekly,
				time_zone: "Mars/Olympus",
				tags: ["db"],
			})
			assert.strictEqual(parameterOf(noMatcher), "services")
			assert.strictEqual(parameterOf(noDays), "days")
			assert.include(messageOf(badZone), "IANA time zone")
			const listed = yield* AlertMaintenanceWindowsService.use((service) => service.list(ORG))
			assert.lengthOf(listed.windows, 0)
		}).pipe(Effect.provide(layerFor(testDb)))
	})

	it.effect("delete_maintenance_window needs confirm, takes the mw_ id and reports an unknown one", () => {
		const testDb = createTestDb(trackedDbs)
		return Effect.gen(function* () {
			const created = yield* call("create_maintenance_window", { ...weekly, tags: ["db"] })
			if (created._tag !== "Success") return assert.fail("create failed")
			const { window } = Schema.decodeUnknownSync(MaintenanceWindowMutationOutput)(
				created.success.structuredContent,
			)
			const publicId = encodePublicId(PublicIdPrefixes.alertMaintenanceWindow, window.id)

			const unconfirmed = yield* call("delete_maintenance_window", { maintenance_window_id: publicId })
			assert.strictEqual(unconfirmed._tag, "Failure")
			const deleted = yield* call("delete_maintenance_window", {
				maintenance_window_id: publicId,
				confirm: true,
			})
			assert.strictEqual(deleted._tag, "Success")
			const again = yield* call("delete_maintenance_window", {
				maintenance_window_id: publicId,
				confirm: true,
			})
			assert.include(
				again._tag === "Failure" ? again.failure.message : "",
				"Maintenance window not found",
			)
		}).pipe(Effect.provide(layerFor(testDb)))
	})
})
