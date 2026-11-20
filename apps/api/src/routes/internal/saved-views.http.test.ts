import * as Policy from "@maple/domain/policy"
import { afterEach, describe, expect, it } from "@effect/vitest"
import {
	AlertMemberDirectoryUnavailableError,
	ApiSchemaErrors,
	ApiUnexpectedErrors,
	CurrentTenant,
	OrgId,
	RoleName,
	SavedViewsApiGroup,
	UserId,
} from "@maple/domain/http"
import { Context, Effect, Layer, Schema } from "effect"
import { HttpRouter } from "effect/http"
import { HttpApi, HttpApiBuilder } from "effect/http-api"
import { ApiErrorBoundaryLive } from "@maple/backend/http/error-boundary"
import { cleanupTestDbs, createTestDb, type TestDb } from "@maple/backend/testing/test-pglite"
import { OrgMembersService } from "@maple/backend/services/org/OrgMembersService"
import { SavedViewsService } from "@maple/backend/services/saved-views/SavedViewsService"
import { HttpSavedViewsLive } from "./saved-views.http"

const createdDbs: TestDb[] = []
afterEach(() => cleanupTestDbs(createdDbs))

class SavedViewsOnlyApi extends HttpApi.make("MapleInternalApi")
	.add(SavedViewsApiGroup)
	.middleware(ApiSchemaErrors)
	.middleware(ApiUnexpectedErrors) {}

const ORG = Schema.decodeSync(OrgId)("org_views_route")
const OTHER_ORG = Schema.decodeSync(OrgId)("org_views_elsewhere")
const decodeUser = Schema.decodeSync(UserId)
const decodeRole = Schema.decodeSync(RoleName)

interface Session {
	readonly orgId: OrgId
	readonly userId: string
	readonly role: string
}
const ANA: Session = { orgId: ORG, userId: "user_ana", role: "org:member" }
const BEN: Session = { orgId: ORG, userId: "user_ben", role: "org:member" }
const OUTSIDER: Session = { orgId: OTHER_ORG, userId: "user_ana", role: "org:admin" }

const unused = Effect.die("not used by the saved view routes")

const makeHarness = (options: { readonly isDirectoryDown?: boolean } = {}) => {
	const db = createTestDb(createdDbs)
	// The request's session, set by `as` before each call.
	let session: Session = ANA
	const authorization = Layer.succeed(
		CurrentTenant.SessionAuthorization,
		CurrentTenant.SessionAuthorization.of({
			bearer: (httpEffect) =>
				CurrentTenant.provide(
					new CurrentTenant.TenantSchema({
						orgId: session.orgId,
						userId: decodeUser(session.userId),
						roles: [decodeRole(session.role)],
						permissions: Policy.grantsOf([decodeRole(session.role)]),
						authMode: "clerk",
					}),
				)(httpEffect),
		}),
	)
	const directory = Layer.succeed(OrgMembersService, {
		listMembers: () =>
			options.isDirectoryDown === true
				? Effect.fail(
						new AlertMemberDirectoryUnavailableError({
							message: "The directory is down",
							cause: "timeout",
						}),
					)
				: Effect.succeed([
						{ userId: "user_ana", email: "ana@acme.test", name: "Ana Lima", imageUrl: null },
						{ userId: "user_ben", email: "ben@acme.test", name: null, imageUrl: null },
					]),
		listOrganizationsOf: () => unused,
		listMemberActivity: () => unused,
		resolveMembers: () => unused,
	})
	const services = Layer.mergeAll(
		Layer.effect(SavedViewsService, SavedViewsService.make).pipe(Layer.provide(db.layer)),
		directory,
	)
	const routes = HttpApiBuilder.layer(SavedViewsOnlyApi).pipe(
		Layer.provide(HttpSavedViewsLive),
		Layer.provide(ApiErrorBoundaryLive),
		Layer.provideMerge(authorization),
		Layer.provide(services),
	)
	const { handler, dispose } = HttpRouter.toWebHandler(routes, { disableLogger: true })

	const call = async (as: Session, method: string, path: string, body?: unknown) => {
		session = as
		const init: RequestInit = {
			method,
			headers: { authorization: "Bearer test-token", "content-type": "application/json" },
		}
		if (body !== undefined) init.body = JSON.stringify(body)
		const response = await handler(
			new Request(`http://maple.test/internal/saved-views${path}`, init),
			Context.empty() as never,
		)
		const text = await response.text()
		return { status: response.status, body: text === "" ? null : JSON.parse(text) }
	}

	return { call, dispose }
}

const logsView = (name: string, visibility: "private" | "org" = "private") => ({
	surface: "logs",
	name,
	state: { search: { severities: ["ERROR"], timePreset: "1h" } },
	visibility,
})

describe("/internal/saved-views", () => {
	it("names the owner of a view someone else shared, and leaves the caller's own unnamed", async () => {
		const harness = makeHarness()
		try {
			expect((await harness.call(ANA, "POST", "/", logsView("Ana shared", "org"))).status).toBe(200)
			expect((await harness.call(BEN, "POST", "/", logsView("Ben shared", "org"))).status).toBe(200)
			expect((await harness.call(BEN, "POST", "/", logsView("Ben private"))).status).toBe(200)

			const forAna = await harness.call(ANA, "GET", "/?surface=logs")
			expect(forAna.status).toBe(200)
			expect(
				forAna.body.views.map(
					(view: { name: string; ownerName: string | null; isOwner: boolean }) => [
						view.name,
						view.ownerName,
						view.isOwner,
					],
				),
			).toEqual([
				["Ana shared", null, true],
				// Ben has no name in the directory, so his email stands in.
				["Ben shared", "ben@acme.test", false],
			])

			const forBen = await harness.call(BEN, "GET", "/?surface=logs")
			expect(
				forBen.body.views.map((view: { name: string; ownerName: string | null }) => [
					view.name,
					view.ownerName,
				]),
			).toEqual([
				["Ben private", null],
				["Ben shared", null],
				["Ana shared", "Ana Lima"],
			])
		} finally {
			await harness.dispose()
		}
	})

	it("still lists shared views when the member directory is down, without names", async () => {
		const harness = makeHarness({ isDirectoryDown: true })
		try {
			await harness.call(ANA, "POST", "/", logsView("Ana shared", "org"))
			const forBen = await harness.call(BEN, "GET", "/?surface=logs")
			expect(forBen.status).toBe(200)
			expect(forBen.body.views).toMatchObject([{ name: "Ana shared", ownerName: null }])
		} finally {
			await harness.dispose()
		}
	})

	it("answers a view of another org as missing, and a shared one of a teammate as theirs to change", async () => {
		const harness = makeHarness()
		try {
			const created = await harness.call(ANA, "POST", "/", logsView("Ana shared", "org"))
			const id: string = created.body.id

			const outsider = await harness.call(OUTSIDER, "PATCH", `/${id}`, { name: "Taken" })
			expect(outsider.status).toBe(404)
			expect(outsider.body).toMatchObject({ _tag: "@maple/http/saved-views/SavedViewNotFoundError" })
			expect((await harness.call(OUTSIDER, "GET", "/?surface=logs")).body.views).toEqual([])

			const teammate = await harness.call(BEN, "DELETE", `/${id}`)
			expect(teammate.status).toBe(403)
			expect(teammate.body).toMatchObject({ _tag: "@maple/http/saved-views/SavedViewForbiddenError" })

			const renamed = await harness.call(ANA, "PATCH", `/${id}`, { name: "Renamed" })
			expect(renamed.status).toBe(200)
			expect(renamed.body).toMatchObject({ name: "Renamed", visibility: "org", isOwner: true })
			expect((await harness.call(ANA, "DELETE", `/${id}`)).status).toBeLessThan(300)
			expect((await harness.call(ANA, "GET", "/?surface=logs")).body.views).toEqual([])
		} finally {
			await harness.dispose()
		}
	})

	it("refuses a blank name, an unknown explorer and a taken name before anything is stored", async () => {
		const harness = makeHarness()
		try {
			expect((await harness.call(ANA, "POST", "/", logsView("   "))).status).toBe(400)
			expect(
				(await harness.call(ANA, "POST", "/", { ...logsView("Dashboards"), surface: "dashboards" }))
					.status,
			).toBe(400)
			expect((await harness.call(ANA, "POST", "/", logsView("Errors"))).status).toBe(200)
			const taken = await harness.call(ANA, "POST", "/", logsView("Errors"))
			expect(taken.status).toBe(409)
			expect(taken.body).toMatchObject({ _tag: "@maple/http/saved-views/SavedViewNameTakenError" })
			expect((await harness.call(ANA, "GET", "/?surface=logs")).body.views).toHaveLength(1)
		} finally {
			await harness.dispose()
		}
	})
})
