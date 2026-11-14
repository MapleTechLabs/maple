import { afterEach, describe, expect, it } from "vitest"
import {
	AlertMemberDirectoryUnavailableError,
	ApiSchemaErrors,
	ApiUnexpectedErrors,
	AuditDetection,
	AuditDetectionListResponse,
	AuditTrailApiGroup,
	type AuditTrailEntry,
	AuditTrailListResponse,
	CurrentTenant,
	OrgId,
	RoleName,
	UserId,
} from "@maple/domain/http"
import { Context, Effect, Layer, Order, Schema, Array as Arr, String as Str } from "effect"
import { encodePublicId, PublicIdPrefixes } from "@maple/domain/http/v2"
import { HttpRouter } from "effect/http"
import { HttpApi, HttpApiBuilder } from "effect/http-api"
import { ApiErrorBoundaryLive } from "@maple/backend/http/error-boundary"
import { AuditLogService, makeMemoryAuditLog } from "@maple/backend/services/audit/AuditLogService"
import { AuditDetectionsService } from "@maple/backend/services/audit-trail/AuditDetectionsService"
import { cleanupTestDbs, createTestDb, type TestDb } from "@maple/backend/testing/test-pglite"
import {
	type AuditTrailListFilters,
	type AuditTrailPage,
	AuditTrailService,
} from "@maple/backend/services/audit-trail/AuditTrailService"
import { OrgMembersService } from "@maple/backend/services/org/OrgMembersService"
import { HttpAuditTrailLive } from "./audit-trail.http"

class AuditTrailOnlyApi extends HttpApi.make("MapleInternalApi")
	.add(AuditTrailApiGroup)
	.middleware(ApiSchemaErrors)
	.middleware(ApiUnexpectedErrors) {}

const ORG_ID = Schema.decodeSync(OrgId)("org_trail_route")
const USER_ID = Schema.decodeSync(UserId)("user_trail_route")

const unused = Effect.die("not used by the audit trail route")
const asRole = Schema.decodeSync(RoleName)
const asPage = Schema.decodeUnknownSync(AuditTrailListResponse)
const asDetection = Schema.decodeUnknownSync(AuditDetection)
const asDetections = Schema.decodeUnknownSync(AuditDetectionListResponse)
const asFailure = Schema.decodeUnknownSync(Schema.Struct({ _tag: Schema.String }))

const trackedDbs: TestDb[] = []
afterEach(() => cleanupTestDbs(trackedDbs))

const event = (overrides: Partial<AuditTrailEntry> = {}): AuditTrailEntry => ({
	id: Str.repeat(32)("a"),
	provider: "github",
	account: "acme",
	providerEventId: "evt_1",
	occurredAt: 1_700_000_000_000,
	ingestedAt: 1_700_000_060_000,
	actor: { type: "user", id: "octocat", name: null, email: null },
	action: "org.add_member",
	category: "membership",
	outcome: "success",
	outcomeReason: null,
	target: { type: "user", id: "hubot", name: null },
	originIp: null,
	originCountry: null,
	userAgent: null,
	raw: null,
	...overrides,
})

/**
 * The route over a trail that answers with `page` and records the filters it was asked for,
 * and the real detections service over an embedded database (`testDb`, shared to read back
 * as another caller).
 */
const makeHarness = (
	roles: ReadonlyArray<string>,
	page: AuditTrailPage,
	directoryDown = false,
	testDb: TestDb = createTestDb(trackedDbs),
) => {
	const asked: Array<AuditTrailListFilters> = []
	let directoryReads = 0
	const auditLog = makeMemoryAuditLog()
	const services = Layer.mergeAll(
		Layer.succeed(AuditTrailService, {
			write: () => unused,
			list: (_orgId, filters) => Effect.sync(() => (asked.push(filters), page)),
			count: () => unused,
		}),
		Layer.effect(AuditDetectionsService, AuditDetectionsService.make).pipe(Layer.provide(testDb.layer)),
		Layer.succeed(AuditLogService, auditLog),
		Layer.succeed(OrgMembersService, {
			listMembers: () =>
				directoryDown
					? Effect.fail(
							new AlertMemberDirectoryUnavailableError({
								message: "clerk down",
								cause: new Error("down"),
							}),
						)
					: Effect.sync(() => {
							directoryReads += 1
							return [{ userId: USER_ID, email: "ada@acme.test", name: "Ada", imageUrl: null }]
						}),
			listOrganizationsOf: () => unused,
			resolveMembers: () => unused,
			listMemberActivity: () => unused,
		}),
		Layer.succeed(
			CurrentTenant.SessionAuthorization,
			CurrentTenant.SessionAuthorization.of({
				bearer: (httpEffect) =>
					Effect.provideService(
						httpEffect,
						CurrentTenant.Context,
						new CurrentTenant.TenantSchema({
							orgId: ORG_ID,
							userId: USER_ID,
							roles: Arr.map(roles, (role) => asRole(role)),
							authMode: "clerk",
						}),
					),
			}),
		),
	)
	const routes = HttpApiBuilder.layer(AuditTrailOnlyApi).pipe(
		Layer.provide(HttpAuditTrailLive),
		Layer.provide(ApiErrorBoundaryLive),
		Layer.provide(services),
	)
	const { handler, dispose } = HttpRouter.toWebHandler(routes, { disableLogger: true })

	const send = async (request: Request) => {
		const response = await handler(request, Context.empty() as never)
		return { status: response.status, body: await response.json() }
	}

	const list = (search = "") =>
		send(
			new Request(`http://maple.test/internal/audit-trail/events${search}`, {
				headers: { authorization: "Bearer test-token" },
			}),
		)

	/** A call to a detections endpoint: `path` is what follows `/detections`. */
	const detections = (method: string, path = "", body?: unknown) =>
		send(
			new Request(`http://maple.test/internal/audit-trail/detections${path}`, {
				method,
				headers: {
					authorization: "Bearer test-token",
					...(body === undefined ? undefined : { "content-type": "application/json" }),
				},
				...(body === undefined ? undefined : { body: JSON.stringify(body) }),
			}),
		)

	/** What Maple's own audit log recorded: each entry's action, resource and changed fields. */
	const audited = async () =>
		Arr.map(await Effect.runPromise(auditLog.list(ORG_ID, { limit: 50, offset: 0 })), (entry) => ({
			action: entry.action,
			resourceId: entry.resourceId,
			changedFields: entry.changedFields,
		}))

	return { list, detections, audited, asked, directoryReads: () => directoryReads, dispose }
}

const ADMIN = ["org:admin"]

describe("GET /internal/audit-trail/events", () => {
	it("refuses an engineer: the trail sits behind the audit log permission, not the Security hub's", async () => {
		const harness = makeHarness(["org:engineer"], { events: [event()], next: null })
		try {
			const response = await harness.list()

			expect(response.status).toBe(403)
			expect(harness.asked).toEqual([])
		} finally {
			await harness.dispose()
		}
	})

	it("hands an admin a page whose cursor asks for the events after it", async () => {
		const last = event({ id: Str.repeat(32)("b"), occurredAt: 1_700_000_000_412 })
		const harness = makeHarness(ADMIN, {
			events: [event(), last],
			next: { occurredAtMs: last.occurredAt, id: last.id },
		})
		try {
			const first = await harness.list("?provider=github&limit=2")
			expect(first.status).toBe(200)
			const page = asPage(first.body)
			expect(page.events).toHaveLength(2)

			await harness.list(`?provider=github&limit=2&cursor=${page.nextCursor}`)
			expect(harness.asked).toEqual([
				{ provider: "github", limit: 2 },
				{ provider: "github", limit: 2, before: { occurredAtMs: last.occurredAt, id: last.id } },
			])
		} finally {
			await harness.dispose()
		}
	})

	it("answers 400 for a cursor it did not issue, before anything reaches the warehouse", async () => {
		const harness = makeHarness(ADMIN, { events: [], next: null })
		try {
			const response = await harness.list("?cursor=1700000000000:not-an-id")

			expect(response.status).toBe(400)
			expect(harness.asked).toEqual([])
		} finally {
			await harness.dispose()
		}
	})

	it("answers 400 for a time bound no event could have", async () => {
		const harness = makeHarness(ADMIN, { events: [], next: null })
		try {
			const response = await harness.list("?since=9000000000000000")

			expect(response.status).toBe(400)
			expect(harness.asked).toEqual([])
		} finally {
			await harness.dispose()
		}
	})

	const mapleUser = (overrides: Partial<AuditTrailEntry["actor"]> = {}) =>
		event({
			id: Str.repeat(32)("c"),
			provider: "maple",
			actor: { type: "user", id: USER_ID, name: null, email: null, ...overrides },
		})

	it("names Maple's own users from the directory and leaves other platforms' actors alone", async () => {
		const harness = makeHarness(ADMIN, {
			events: [
				mapleUser(),
				// Another platform's actor whose id happens to equal a Maple user id.
				event({ actor: { type: "user", id: USER_ID, name: null, email: null } }),
				// A label frozen when the event was written is what the actor was called then.
				mapleUser({ name: "Device credential" }),
			],
			next: null,
		})
		try {
			const { events } = asPage((await harness.list()).body)

			expect(Arr.map(events, (listed) => [listed.actor.name, listed.actor.email])).toEqual([
				["Ada", "ada@acme.test"],
				[null, null],
				["Device credential", null],
			])
		} finally {
			await harness.dispose()
		}
	})

	it("still serves the page, with ids, when the member directory is down", async () => {
		const harness = makeHarness(ADMIN, { events: [mapleUser()], next: null }, true)
		try {
			const response = await harness.list()

			expect(response.status).toBe(200)
			expect(asPage(response.body).events[0]?.actor).toMatchObject({ id: USER_ID, name: null })
		} finally {
			await harness.dispose()
		}
	})

	// Maple's events are stored under the user id: without the directory an email matches none
	// of them, and a page that left them out would look complete.
	it("answers 503 for an email filter while the member directory is down", async () => {
		const harness = makeHarness(ADMIN, { events: [], next: null }, true)
		try {
			const response = await harness.list("?actor=ada@acme.test")

			expect(response.status).toBe(503)
			expect(harness.asked).toEqual([])
		} finally {
			await harness.dispose()
		}
	})

	it("reads the directory once to resolve an email filter and name the page it returns", async () => {
		const harness = makeHarness(ADMIN, { events: [mapleUser()], next: null })
		try {
			const { events } = asPage((await harness.list("?actor=ada@acme.test")).body)

			expect(events[0]?.actor.name).toBe("Ada")
			expect(harness.directoryReads()).toBe(1)
		} finally {
			await harness.dispose()
		}
	})

	it("does not resolve an email against Maple's members when another platform is asked for", async () => {
		const harness = makeHarness(ADMIN, { events: [], next: null })
		try {
			await harness.list("?provider=github&actor=ada@acme.test")

			expect(harness.asked).toEqual([{ provider: "github", actor: "ada@acme.test", limit: 50 }])
			expect(harness.directoryReads()).toBe(0)
		} finally {
			await harness.dispose()
		}
	})

	// Maple's own events store the user id, and the page shows the email next to it.
	it("finds a member's Maple events when filtering by the email the page showed", async () => {
		const harness = makeHarness(ADMIN, { events: [], next: null })
		try {
			await harness.list("?actor=Ada@acme.test")
			await harness.list("?actor=octocat")

			expect(harness.asked).toEqual([
				{ actor: "Ada@acme.test", actorAlias: USER_ID, limit: 50 },
				{ actor: "octocat", limit: 50 },
			])
		} finally {
			await harness.dispose()
		}
	})

	it("does not read the member directory for a page with no Maple users on it", async () => {
		const harness = makeHarness(ADMIN, { events: [event()], next: null })
		try {
			await harness.list()

			expect(harness.directoryReads()).toBe(0)
		} finally {
			await harness.dispose()
		}
	})
})

const EMPTY_PAGE: AuditTrailPage = { events: [], next: null }

const detectionBody = (overrides: Record<string, unknown> = {}) => ({
	name: "Members added",
	filters: { provider: "vercel", category: "membership" },
	windowMinutes: 10,
	threshold: 3,
	severity: "critical",
	...overrides,
})

const UNKNOWN_ID = "00000000-0000-4000-8000-000000000000"

describe("/internal/audit-trail/detections", () => {
	// A detection says what the audit log holds, so it sits behind the audit log permission.
	it("refuses an engineer on every endpoint and stores nothing", async () => {
		const testDb = createTestDb(trackedDbs)
		const admin = makeHarness(ADMIN, EMPTY_PAGE, false, testDb)
		const engineer = makeHarness(["org:engineer"], EMPTY_PAGE, false, testDb)
		try {
			const existing = asDetection((await admin.detections("POST", "", detectionBody())).body)

			const statuses = [
				await engineer.detections("GET"),
				await engineer.detections("POST", "", detectionBody({ name: "Theirs" })),
				await engineer.detections("PATCH", `/${existing.id}`, { threshold: 9 }),
				await engineer.detections("DELETE", `/${existing.id}`),
			]

			expect(Arr.map(statuses, (response) => response.status)).toEqual([403, 403, 403, 403])
			expect(await engineer.audited()).toEqual([])
			expect(asDetections((await admin.detections("GET")).body).detections).toEqual([existing])
		} finally {
			await admin.dispose()
			await engineer.dispose()
		}
	})

	it("lets an admin create, list, edit and delete a detection, and audits each change", async () => {
		const harness = makeHarness(ADMIN, EMPTY_PAGE)
		try {
			const created = await harness.detections("POST", "", detectionBody({ name: "  Members added  " }))
			expect(created.status).toBe(200)
			const detection = asDetection(created.body)
			expect(detection).toMatchObject({
				name: "Members added",
				enabled: true,
				filters: { provider: "vercel", category: "membership" },
				windowMinutes: 10,
				threshold: 3,
				severity: "critical",
				destinationIds: [],
			})
			expect(asDetections((await harness.detections("GET")).body).detections).toEqual([detection])

			const edited = await harness.detections("PATCH", `/${detection.id}`, {
				threshold: 5,
				enabled: false,
			})
			expect(edited.status).toBe(200)
			expect(asDetection(edited.body)).toMatchObject({
				id: detection.id,
				name: "Members added",
				threshold: 5,
				enabled: false,
			})

			const deleted = await harness.detections("DELETE", `/${detection.id}`)
			expect(deleted).toEqual({ status: 200, body: { id: detection.id } })
			expect(asDetections((await harness.detections("GET")).body).detections).toEqual([])

			// The audit log names a resource by its public id.
			const resourceId = encodePublicId(PublicIdPrefixes.alertRule, detection.id)
			expect(Arr.sortWith(await harness.audited(), (entry) => entry.action, Order.String)).toEqual([
				{ action: "alert_rule.created", resourceId, changedFields: null },
				{ action: "alert_rule.deleted", resourceId, changedFields: null },
				{ action: "alert_rule.updated", resourceId, changedFields: ["enabled", "threshold"] },
			])
		} finally {
			await harness.dispose()
		}
	})

	it("answers 400 for a detection outside its bounds, before anything is stored", async () => {
		const harness = makeHarness(ADMIN, EMPTY_PAGE)
		try {
			const responses = [
				await harness.detections("POST", "", detectionBody({ name: "   " })),
				await harness.detections("POST", "", detectionBody({ name: Str.repeat(121)("x") })),
				await harness.detections("POST", "", detectionBody({ windowMinutes: 4 })),
				await harness.detections("POST", "", detectionBody({ windowMinutes: 1441 })),
				await harness.detections("POST", "", detectionBody({ threshold: 0 })),
				await harness.detections("POST", "", detectionBody({ threshold: 2.5 })),
				await harness.detections("POST", "", detectionBody({ severity: "info" })),
				await harness.detections("POST", "", detectionBody({ filters: { provider: "nowhere" } })),
				await harness.detections("POST", "", detectionBody({ filters: { action: " " } })),
				await harness.detections(
					"POST",
					"",
					detectionBody({ destinationIds: Arr.makeBy(21, () => UNKNOWN_ID) }),
				),
			]

			expect(Arr.dedupe(Arr.map(responses, (response) => response.status))).toEqual([400])
			expect(asDetections((await harness.detections("GET")).body).detections).toEqual([])
		} finally {
			await harness.dispose()
		}
	})

	// The unique index on org and name would otherwise answer a 500.
	it("answers 400 for an unknown destination and for a name already taken", async () => {
		const harness = makeHarness(ADMIN, EMPTY_PAGE)
		try {
			const first = asDetection((await harness.detections("POST", "", detectionBody())).body)
			const other = asDetection(
				(await harness.detections("POST", "", detectionBody({ name: "Tokens created" }))).body,
			)

			const responses = [
				await harness.detections("POST", "", detectionBody({ name: "Members added" })),
				await harness.detections("PATCH", `/${other.id}`, { name: first.name }),
				await harness.detections(
					"POST",
					"",
					detectionBody({ name: "Third", destinationIds: [UNKNOWN_ID] }),
				),
			]

			expect(
				Arr.map(responses, (response) => [response.status, asFailure(response.body)._tag]),
			).toEqual([
				[400, "@maple/http/errors/AuditDetectionInvalidError"],
				[400, "@maple/http/errors/AuditDetectionInvalidError"],
				[400, "@maple/http/errors/AuditDetectionInvalidError"],
			])
			expect(asDetections((await harness.detections("GET")).body).detections).toHaveLength(2)
		} finally {
			await harness.dispose()
		}
	})

	it("answers 404 for a detection that does not exist", async () => {
		const harness = makeHarness(ADMIN, EMPTY_PAGE)
		try {
			const edited = await harness.detections("PATCH", `/${UNKNOWN_ID}`, { threshold: 5 })
			const deleted = await harness.detections("DELETE", `/${UNKNOWN_ID}`)

			expect([edited.status, deleted.status]).toEqual([404, 404])
			expect(await harness.audited()).toEqual([])
		} finally {
			await harness.dispose()
		}
	})
})
