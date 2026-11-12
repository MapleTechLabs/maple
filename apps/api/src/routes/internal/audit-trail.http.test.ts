import { describe, expect, it } from "vitest"
import {
	AlertMemberDirectoryUnavailableError,
	ApiSchemaErrors,
	ApiUnexpectedErrors,
	AuditTrailApiGroup,
	type AuditTrailEntry,
	AuditTrailListResponse,
	CurrentTenant,
	OrgId,
	RoleName,
	UserId,
} from "@maple/domain/http"
import { Context, Effect, Layer, Schema, Array as Arr, String as Str } from "effect"
import { HttpRouter } from "effect/http"
import { HttpApi, HttpApiBuilder } from "effect/http-api"
import { ApiErrorBoundaryLive } from "@maple/backend/http/error-boundary"
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
	target: { type: "user", id: "hubot", name: null },
	originIp: null,
	originCountry: null,
	userAgent: null,
	raw: null,
	...overrides,
})

/** The route over a trail that answers with `page` and records the filters it was asked for. */
const makeHarness = (roles: ReadonlyArray<string>, page: AuditTrailPage, directoryDown = false) => {
	const asked: Array<AuditTrailListFilters> = []
	let directoryReads = 0
	const services = Layer.mergeAll(
		Layer.succeed(AuditTrailService, {
			write: () => unused,
			list: (_orgId, filters) => Effect.sync(() => (asked.push(filters), page)),
		}),
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

	const list = async (search = "") => {
		const response = await handler(
			new Request(`http://maple.test/internal/audit-trail/events${search}`, {
				headers: { authorization: "Bearer test-token" },
			}),
			Context.empty() as never,
		)
		return { status: response.status, body: await response.json() }
	}

	return { list, asked, directoryReads: () => directoryReads, dispose }
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
