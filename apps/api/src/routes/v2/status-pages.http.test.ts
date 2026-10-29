import { afterEach, describe, expect, it } from "@effect/vitest"
import { ConfigProvider, Context, Effect, Layer, ManagedRuntime, Schema } from "effect"
import { HttpRouter } from "effect/http"
import { HttpApiBuilder } from "effect/http-api"
import { OrgId, UserId } from "@maple/domain/http"
import { MapleApiV2 } from "@maple/domain/http/v2"
import { cleanupTestDbs, createTestDb, type TestDb } from "@maple/backend/platform/test-pglite"
import { Env } from "@maple/backend/platform/Env"
import { ApiAuthorizationV2Live } from "@maple/backend/services/auth/ApiAuthorizationV2Live"
import { AuditLogService } from "@maple/backend/services/audit/AuditLogService"
import { ApiKeysService } from "@maple/backend/services/org/ApiKeysService"
import { AuthService } from "@maple/backend/services/auth/AuthService"
import { DashboardPersistenceService } from "@maple/backend/services/dashboards/DashboardPersistenceService"
import { SharedDashboardService } from "@maple/backend/services/dashboards/SharedDashboardService"
import { LiveActivitiesService } from "@maple/backend/services/push/LiveActivitiesService"
import { MobileDevicesService } from "@maple/backend/services/push/MobileDevicesService"
import { V2TransportErrorBoundaryLive } from "./error-envelope"
import {
	AlertsServiceStubLayer,
	AllV2GroupLayersLive,
	ApiV2RateLimiterAllowAllLayer,
	ConfigResourceServiceStubsLayer,
	Phase1ResourceStubsLayer,
	PlanetScaleServiceStubsLayer,
	TelemetryServiceStubsLayer,
} from "./v2-test-support"

/** `/v2/status_pages` and `/v2/status_page_incidents` over an embedded PGlite with the real service. */

const createdDbs: TestDb[] = []
afterEach(() => cleanupTestDbs(createdDbs))

const ORG = Schema.decodeUnknownSync(OrgId)("org_status_pages_e2e")
const OTHER_ORG = Schema.decodeUnknownSync(OrgId)("org_status_pages_other")
const USER = Schema.decodeUnknownSync(UserId)("user_status_pages_e2e")
const MEMBER = { source: "maple_cli", roles: ["org:member"], deviceName: "laptop" }

const testConfig = () =>
	ConfigProvider.layer(
		ConfigProvider.fromUnknown({
			PORT: "3488",
			MCP_PORT: "3489",
			TINYBIRD_HOST: "https://api.tinybird.co",
			TINYBIRD_TOKEN: "test-token",
			MAPLE_AUTH_MODE: "self_hosted",
			MAPLE_ROOT_PASSWORD: "test-root-password",
			MAPLE_DEFAULT_ORG_ID: "default",
			MAPLE_API_BASE_URL: "https://api.maple.test",
			MAPLE_INGEST_KEY_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64"),
			MAPLE_INGEST_KEY_LOOKUP_HMAC_KEY: "maple-test-lookup-secret",
			INTERNAL_SERVICE_TOKEN: "test-internal-token",
		}),
	)

const makeHarness = () => {
	const testDb = createTestDb(createdDbs)
	const envLive = Env.layer.pipe(Layer.provide(testConfig()))
	const servicesLive = Layer.mergeAll(
		ApiKeysService.layer,
		AuthService.layer,
		DashboardPersistenceService.layer,
		SharedDashboardService.layer,
		MobileDevicesService.layer,
		LiveActivitiesService.layer,
	).pipe(Layer.provideMerge(Layer.mergeAll(envLive, testDb.layer)))

	const routes = HttpApiBuilder.layer(MapleApiV2).pipe(
		Layer.provide(AllV2GroupLayersLive),
		Layer.provide(V2TransportErrorBoundaryLive),
		Layer.provide(AlertsServiceStubLayer),
		Layer.provide(ConfigResourceServiceStubsLayer),
		Layer.provide(Phase1ResourceStubsLayer),
		Layer.provide(PlanetScaleServiceStubsLayer),
		Layer.provide(TelemetryServiceStubsLayer),
		Layer.provideMerge(ApiAuthorizationV2Live),
		Layer.provideMerge(AuditLogService.layerMemory),
		Layer.provideMerge(ApiV2RateLimiterAllowAllLayer),
		Layer.provideMerge(servicesLive),
	)
	const { handler, dispose: disposeHandler } = HttpRouter.toWebHandler(routes, { disableLogger: true })
	const runtime = ManagedRuntime.make(servicesLive)

	const request = async (method: string, path: string, token: string, body?: unknown) => {
		const response = await handler(
			new Request(`http://maple.test${path}`, {
				method,
				headers: {
					authorization: `Bearer ${token}`,
					...(body !== undefined ? { "content-type": "application/json" } : undefined),
				},
				body: body === undefined ? undefined : JSON.stringify(body),
			}),
			Context.empty() as never,
		)
		const text = await response.text()
		return { status: response.status, body: text.length === 0 ? null : JSON.parse(text) }
	}

	const bootstrapKey = (orgId: OrgId = ORG, metadataJson?: Record<string, unknown>) =>
		runtime.runPromise(
			Effect.gen(function* () {
				const service = yield* ApiKeysService
				return yield* service.create(orgId, USER, { name: "status-pages-test", metadataJson })
			}),
		)

	return {
		request,
		bootstrapKey,
		dispose: async () => {
			await disposeHandler()
			await runtime.dispose()
		},
	}
}

const withHarness = (body: (harness: ReturnType<typeof makeHarness>) => Promise<void>) =>
	Effect.runPromise(
		Effect.acquireUseRelease(
			Effect.sync(makeHarness),
			(harness) => Effect.promise(() => body(harness)),
			(harness) => Effect.promise(() => harness.dispose()),
		),
	)

describe("v2 status pages", () => {
	it("creates, retrieves, updates and deletes a page", () =>
		withHarness(async (harness) => {
			const { secret: token } = await harness.bootstrapKey()
			const created = await harness.request("POST", "/v2/status_pages", token, {
				name: "Acme Status",
				slug: "acme-status",
				theme: { accent: "#1A2B3C" },
			})
			expect(created.status).toBe(200)
			expect(created.body).toMatchObject({
				object: "status_page",
				name: "Acme Status",
				slug: "acme-status",
				theme: {
					preset: "default",
					appearance: "auto",
					accent: "#1a2b3c",
					background: null,
					text: null,
					card: null,
					border: null,
					radius: "md",
					font: "sans",
				},
				auto_incidents: "off",
				revision: 1,
				published_revision: 0,
				published_at: null,
			})
			const id: string = created.body.id
			expect(id).toMatch(/^stp_/)

			const retrieved = await harness.request("GET", `/v2/status_pages/${id}`, token)
			expect(retrieved.body).toEqual(created.body)

			const updated = await harness.request("PATCH", `/v2/status_pages/${id}`, token, {
				description: "Live status of Acme.",
				auto_incidents: "draft",
				theme: { preset: "paper", appearance: "light", background: "#FFFDF7" },
			})
			expect(updated.status).toBe(200)
			// Omitted theme fields keep their values.
			expect(updated.body.theme).toMatchObject({
				preset: "paper",
				appearance: "light",
				accent: "#1a2b3c",
				background: "#fffdf7",
			})

			const unreadable = await harness.request("PATCH", `/v2/status_pages/${id}`, token, {
				theme: { text: "#777777", background: "#ffffff" },
			})
			expect(unreadable.status).toBe(400)
			expect(unreadable.body.error.message).toContain("4.48:1")
			expect(updated.body).toMatchObject({
				name: "Acme Status",
				description: "Live status of Acme.",
				auto_incidents: "draft",
			})
			expect(updated.body.revision).toBeGreaterThan(created.body.revision)

			const listed = await harness.request("GET", "/v2/status_pages", token)
			expect(listed.body.data.map((page: { id: string }) => page.id)).toEqual([id])

			// No edge storage is bound in the harness, so the minutely sweep owns publishing.
			const published = await harness.request("POST", `/v2/status_pages/${id}/publish`, token)
			expect(published.body).toEqual({
				id,
				object: "status_page.publish_result",
				outcome: "queued",
				revision: updated.body.revision,
			})

			const removed = await harness.request("DELETE", `/v2/status_pages/${id}`, token)
			expect(removed.body).toEqual({ id, object: "status_page", deleted: true })
			const missing = await harness.request("GET", `/v2/status_pages/${id}`, token)
			expect(missing.status).toBe(404)
			expect(missing.body.error.code).toBe("status_page_not_found")
		}))

	it("refuses a taken slug and an invalid one", () =>
		withHarness(async (harness) => {
			const { secret: token } = await harness.bootstrapKey()
			await harness.request("POST", "/v2/status_pages", token, { name: "A", slug: "acme-status" })
			const taken = await harness.request("POST", "/v2/status_pages", token, {
				name: "B",
				slug: "acme-status",
			})
			expect(taken.status).toBe(409)
			expect(taken.body.error.code).toBe("status_page_slug_taken")
			const invalid = await harness.request("POST", "/v2/status_pages", token, {
				name: "C",
				slug: "Not A Slug",
			})
			expect(invalid.status).toBe(400)
			expect(invalid.body.error.code).toBe("status_page_invalid")
		}))

	it("issues a break-glass token once and revokes it", () =>
		withHarness(async (harness) => {
			const { secret: token } = await harness.bootstrapKey()
			const page = await harness.request("POST", "/v2/status_pages", token, {
				name: "Acme",
				slug: "acme-glass",
			})
			const issued = await harness.request(
				"POST",
				`/v2/status_pages/${page.body.id}/rotate_break_glass`,
				token,
			)
			expect(issued.body.token).toMatch(/^mstat_/)
			expect(issued.body.token_suffix).toBe(issued.body.token.slice(-6))
			const retrieved = await harness.request("GET", `/v2/status_pages/${page.body.id}`, token)
			expect(retrieved.body.break_glass_token_suffix).toBe(issued.body.token_suffix)
			expect(JSON.stringify(retrieved.body)).not.toContain(issued.body.token)

			const revoked = await harness.request(
				"DELETE",
				`/v2/status_pages/${page.body.id}/break_glass`,
				token,
			)
			expect(revoked.body.break_glass_token_suffix).toBeNull()
		}))

	it("adds, reorders, updates and removes components", () =>
		withHarness(async (harness) => {
			const { secret: token } = await harness.bootstrapKey()
			const page = await harness.request("POST", "/v2/status_pages", token, {
				name: "Acme",
				slug: "acme-parts",
			})
			const base = `/v2/status_pages/${page.body.id}/components`
			const api = await harness.request("POST", base, token, { name: "API" })
			const web = await harness.request("POST", base, token, { name: "Dashboard", group: "Apps" })
			expect(api.body).toMatchObject({ object: "status_page_component", position: 0, group: null })
			expect(web.body).toMatchObject({ position: 1, group: "Apps" })

			const reordered = await harness.request("POST", `${base}/reorder`, token, {
				component_ids: [web.body.id, api.body.id],
			})
			expect(reordered.body.data.map((c: { name: string }) => c.name)).toEqual(["Dashboard", "API"])
			const partial = await harness.request("POST", `${base}/reorder`, token, {
				component_ids: [web.body.id],
			})
			expect(partial.status).toBe(400)

			const updated = await harness.request("PATCH", `${base}/${api.body.id}`, token, {
				manual_status: "degraded",
			})
			expect(updated.body).toMatchObject({ name: "API", manual_status: "degraded" })

			// A component addressed through another page is not found.
			const other = await harness.request("POST", "/v2/status_pages", token, {
				name: "Other",
				slug: "acme-other",
			})
			const crossPage = await harness.request(
				"PATCH",
				`/v2/status_pages/${other.body.id}/components/${api.body.id}`,
				token,
				{ name: "Hijack" },
			)
			expect(crossPage.status).toBe(404)
			expect(crossPage.body.error.code).toBe("status_page_component_not_found")

			const removed = await harness.request("DELETE", `${base}/${api.body.id}`, token)
			expect(removed.body).toEqual({ id: api.body.id, object: "status_page_component", deleted: true })
			const listed = await harness.request("GET", base, token)
			expect(listed.body.data.map((c: { id: string }) => c.id)).toEqual([web.body.id])
		}))

	it("runs an incident from draft to resolved", () =>
		withHarness(async (harness) => {
			const { secret: admin } = await harness.bootstrapKey()
			const { secret: member } = await harness.bootstrapKey(ORG, MEMBER)
			const page = await harness.request("POST", "/v2/status_pages", admin, {
				name: "Acme",
				slug: "acme-incidents",
			})
			const component = await harness.request(
				"POST",
				`/v2/status_pages/${page.body.id}/components`,
				admin,
				{
					name: "API",
				},
			)

			// Responders post incidents without being org admins.
			const opened = await harness.request("POST", "/v2/status_page_incidents", member, {
				page_id: page.body.id,
				title: "Elevated API errors",
				body: "We are looking into elevated error rates.",
				component_ids: [component.body.id],
				published: false,
			})
			expect(opened.status).toBe(200)
			expect(opened.body).toMatchObject({
				object: "status_page_incident",
				page_id: page.body.id,
				kind: "incident",
				impact: "minor",
				status: "investigating",
				published: false,
				resolved_at: null,
				component_ids: [component.body.id],
			})
			expect(opened.body.updates).toHaveLength(1)
			expect(opened.body.updates[0]).toMatchObject({ source: "api", status: "investigating" })
			const id: string = opened.body.id

			const published = await harness.request("PATCH", `/v2/status_page_incidents/${id}`, member, {
				published: true,
				impact: "major",
			})
			expect(published.body).toMatchObject({ published: true, impact: "major" })

			const resolved = await harness.request(
				"POST",
				`/v2/status_page_incidents/${id}/updates`,
				member,
				{
					status: "resolved",
					body: "Error rates are back to normal.",
				},
			)
			expect(resolved.body.status).toBe("resolved")
			expect(resolved.body.resolved_at).not.toBeNull()
			expect(resolved.body.updates.map((u: { status: string }) => u.status)).toEqual([
				"resolved",
				"investigating",
			])

			const open = await harness.request(
				"GET",
				`/v2/status_page_incidents?page_id=${page.body.id}`,
				member,
			)
			expect(open.body.data).toEqual([])
			const closed = await harness.request("GET", "/v2/status_page_incidents?state=closed", member)
			expect(closed.body.data.map((i: { id: string }) => i.id)).toEqual([id])

			const wrongStatus = await harness.request(
				"POST",
				`/v2/status_page_incidents/${id}/updates`,
				member,
				{
					status: "completed",
					body: "Maintenance status on an incident.",
				},
			)
			expect(wrongStatus.status).toBe(400)

			const removed = await harness.request("DELETE", `/v2/status_page_incidents/${id}`, member)
			expect(removed.body).toEqual({ id, object: "status_page_incident", deleted: true })
		}))

	it("schedules maintenance with its window", () =>
		withHarness(async (harness) => {
			const { secret: token } = await harness.bootstrapKey()
			const page = await harness.request("POST", "/v2/status_pages", token, {
				name: "Acme",
				slug: "acme-maint",
			})
			const scheduled = await harness.request("POST", "/v2/status_page_incidents", token, {
				page_id: page.body.id,
				kind: "maintenance",
				title: "Database upgrade",
				body: "We are upgrading the primary database.",
				scheduled_start: "2026-08-01T02:00:00.000Z",
				scheduled_end: "2026-08-01T03:00:00.000Z",
			})
			expect(scheduled.body).toMatchObject({
				kind: "maintenance",
				status: "scheduled",
				impact: "none",
				scheduled_start: "2026-08-01T02:00:00.000Z",
				scheduled_end: "2026-08-01T03:00:00.000Z",
				started_at: "2026-08-01T02:00:00.000Z",
			})
			const noWindow = await harness.request("POST", "/v2/status_page_incidents", token, {
				page_id: page.body.id,
				kind: "maintenance",
				title: "Upgrade",
				body: "Soon.",
			})
			expect(noWindow.status).toBe(400)
		}))

	it("refuses page and component writes from members", () =>
		withHarness(async (harness) => {
			const { secret: member } = await harness.bootstrapKey(ORG, MEMBER)
			const create = await harness.request("POST", "/v2/status_pages", member, {
				name: "Acme",
				slug: "acme-member",
			})
			expect(create.status).toBe(403)
			expect((await harness.request("GET", "/v2/status_pages", member)).status).toBe(200)
		}))

	it("hides one org's pages and incidents from another", () =>
		withHarness(async (harness) => {
			const { secret: token } = await harness.bootstrapKey()
			const { secret: outsider } = await harness.bootstrapKey(OTHER_ORG)
			const page = await harness.request("POST", "/v2/status_pages", token, {
				name: "Acme",
				slug: "acme-private",
			})
			const incident = await harness.request("POST", "/v2/status_page_incidents", token, {
				page_id: page.body.id,
				title: "Outage",
				body: "Investigating.",
			})

			const pagePath = `/v2/status_pages/${page.body.id}`
			const incidentPath = `/v2/status_page_incidents/${incident.body.id}`
			const reads = await Promise.all([
				harness.request("GET", pagePath, outsider),
				harness.request("PATCH", pagePath, outsider, { name: "Mine" }),
				harness.request("DELETE", pagePath, outsider),
				harness.request("GET", `${pagePath}/components`, outsider),
				harness.request("GET", incidentPath, outsider),
				harness.request("POST", `${incidentPath}/updates`, outsider, {
					status: "resolved",
					body: "Not yours.",
				}),
				harness.request("POST", "/v2/status_page_incidents", outsider, {
					page_id: page.body.id,
					title: "Fake",
					body: "Fake.",
				}),
			])
			expect(reads.map((r) => r.status)).toEqual([404, 404, 404, 404, 404, 404, 404])
			expect((await harness.request("GET", "/v2/status_pages", outsider)).body.data).toEqual([])
			expect((await harness.request("GET", "/v2/status_page_incidents", outsider)).body.data).toEqual(
				[],
			)

			const intact = await harness.request("GET", incidentPath, token)
			expect(intact.body.status).toBe("investigating")
		}))

	describe("config", () => {
		const seedPage = async (harness: ReturnType<typeof makeHarness>, token: string, slug: string) => {
			const page = await harness.request("POST", "/v2/status_pages", token, { name: "Acme", slug })
			const base = `/v2/status_pages/${page.body.id}/components`
			const api = await harness.request("POST", base, token, { name: "API" })
			const web = await harness.request("POST", base, token, { name: "Web", group: "Apps" })
			return { id: page.body.id as string, apiId: api.body.id as string, webId: web.body.id as string }
		}

		it("round-trips the document with a single revision bump", () =>
			withHarness(async (harness) => {
				const { secret: token } = await harness.bootstrapKey()
				const { id, apiId, webId } = await seedPage(harness, token, "acme-config")
				const read = await harness.request("GET", `/v2/status_pages/${id}/config`, token)
				expect(read.status).toBe(200)
				expect(read.body).toMatchObject({
					name: "Acme",
					slug: "acme-config",
					show_powered_by: true,
					auto_incidents: "off",
					components: [
						{ id: apiId, name: "API", group: null, monitor_id: null, show_uptime: true },
						{ id: webId, name: "Web", group: "Apps" },
					],
				})
				const before = (await harness.request("GET", `/v2/status_pages/${id}`, token)).body.revision
				expect(read.body.revision).toBe(before)

				const applied = await harness.request(
					"PUT",
					`/v2/status_pages/${id}/config`,
					token,
					read.body,
				)
				expect(applied.status).toBe(200)
				expect(applied.body).toEqual({ ...read.body, revision: before + 1 })
				const after = (await harness.request("GET", `/v2/status_pages/${id}`, token)).body.revision
				expect(after).toBe(before + 1)
			}))

		it("applies created, updated, deleted and reordered components with the page fields", () =>
			withHarness(async (harness) => {
				const { secret: token } = await harness.bootstrapKey()
				const { id, apiId, webId } = await seedPage(harness, token, "acme-apply")
				const applied = await harness.request("PUT", `/v2/status_pages/${id}/config`, token, {
					name: "Acme Inc",
					slug: "acme-apply",
					description: "Live status.",
					theme: { preset: "midnight" },
					components: [
						{ name: "Docs" },
						{ id: apiId, name: "Public API", manual_status: "degraded" },
					],
				})
				expect(applied.status).toBe(200)
				expect(applied.body).toMatchObject({
					name: "Acme Inc",
					description: "Live status.",
					theme: { preset: "midnight", appearance: "auto", accent: null },
					components: [
						{ name: "Docs", manual_status: null },
						{ id: apiId, name: "Public API", manual_status: "degraded" },
					],
				})
				expect(applied.body.components[0].id).toMatch(/^stc_/)
				const listed = await harness.request("GET", `/v2/status_pages/${id}/components`, token)
				expect(
					listed.body.data.map((c: { id: string; position: number }) => [c.id, c.position]),
				).toEqual([
					[applied.body.components[0].id, 0],
					[apiId, 1],
				])
				expect(listed.body.data.some((c: { id: string }) => c.id === webId)).toBe(false)
			}))

		it("refuses an invalid document with a 400 naming the problem and changes nothing", () =>
			withHarness(async (harness) => {
				const { secret: token } = await harness.bootstrapKey()
				const { id } = await seedPage(harness, token, "acme-invalid")
				const other = await seedPage(harness, token, "acme-invalid-other")
				const path = `/v2/status_pages/${id}/config`
				const read = await harness.request("GET", path, token)
				const foreign = await harness.request("PUT", path, token, {
					...read.body,
					name: "Changed",
					components: [...read.body.components, { id: other.apiId, name: "Stolen" }],
				})
				expect(foreign.status).toBe(400)
				expect(foreign.body.error.code).toBe("status_page_invalid")
				expect(foreign.body.error.message).toContain(other.apiId)
				const duplicate = await harness.request("PUT", path, token, {
					...read.body,
					components: [...read.body.components, read.body.components[0]],
				})
				expect(duplicate.status).toBe(400)
				expect(duplicate.body.error.message).toContain("more than once")
				const malformed = await harness.request("PUT", path, token, { name: "No slug" })
				expect(malformed.status).toBe(400)
				expect((await harness.request("GET", path, token)).body).toEqual(read.body)
			}))

		it("refuses a key the document does not define, naming it, and changes nothing", () =>
			withHarness(async (harness) => {
				const { secret: token } = await harness.bootstrapKey()
				const { id } = await seedPage(harness, token, "acme-typo")
				const path = `/v2/status_pages/${id}/config`
				const read = await harness.request("GET", path, token)
				const [first, ...rest] = read.body.components
				const { show_uptime: _shown, ...withoutUptime } = first
				const typo = await harness.request("PUT", path, token, {
					...read.body,
					name: "Changed",
					components: [{ ...withoutUptime, show_uptim: false }, ...rest],
				})
				expect(typo.status).toBe(400)
				expect(typo.body.error.param).toBe("components[0].show_uptim")
				const topLevel = await harness.request("PUT", path, token, { ...read.body, colour: "red" })
				expect(topLevel.status).toBe(400)
				expect(topLevel.body.error.param).toBe("colour")
				expect((await harness.request("GET", path, token)).body).toEqual(read.body)
			}))

		it("with a stale if_revision answers 409 and writes nothing; a current one applies", () =>
			withHarness(async (harness) => {
				const { secret: token } = await harness.bootstrapKey()
				const { id } = await seedPage(harness, token, "acme-stale")
				const path = `/v2/status_pages/${id}/config`
				const read = await harness.request("GET", path, token)
				await harness.request("POST", `/v2/status_pages/${id}/components`, token, { name: "Added" })
				const moved = await harness.request("GET", path, token)
				const stale = await harness.request(
					"PUT",
					`${path}?if_revision=${read.body.revision}`,
					token,
					{ ...read.body, name: "Stale" },
				)
				expect(stale.status).toBe(409)
				expect(stale.body.error.code).toBe("status_page_conflict")
				expect(stale.body.error.message).toContain(`revision ${read.body.revision}`)
				expect((await harness.request("GET", path, token)).body).toEqual(moved.body)

				const current = await harness.request(
					"PUT",
					`${path}?if_revision=${moved.body.revision}`,
					token,
					{ ...moved.body, name: "Fresh" },
				)
				expect(current.status).toBe(200)
				expect(current.body.name).toBe("Fresh")
				expect(current.body.components.map((c: { name: string }) => c.name)).toContain("Added")
			}))

		it("refuses more than 200 components", () =>
			withHarness(async (harness) => {
				const { secret: token } = await harness.bootstrapKey()
				const { id } = await seedPage(harness, token, "acme-big")
				const path = `/v2/status_pages/${id}/config`
				const read = await harness.request("GET", path, token)
				const tooMany = await harness.request("PUT", path, token, {
					...read.body,
					components: Array.from({ length: 201 }, (_, index) => ({ name: `C${index}` })),
				})
				expect(tooMany.status).toBe(400)
				expect((await harness.request("GET", path, token)).body).toEqual(read.body)
			}))

		it("hides another org's config and refuses members", () =>
			withHarness(async (harness) => {
				const { secret: token } = await harness.bootstrapKey()
				const { secret: outsider } = await harness.bootstrapKey(OTHER_ORG)
				const { secret: member } = await harness.bootstrapKey(ORG, MEMBER)
				const { id } = await seedPage(harness, token, "acme-guarded")
				const path = `/v2/status_pages/${id}/config`
				const read = await harness.request("GET", path, token)
				expect((await harness.request("GET", path, outsider)).status).toBe(404)
				expect((await harness.request("PUT", path, outsider, read.body)).status).toBe(404)
				expect((await harness.request("GET", path, member)).status).toBe(200)
				const refused = await harness.request("PUT", path, member, { ...read.body, name: "Member" })
				expect(refused.status).toBe(403)
				expect((await harness.request("GET", path, token)).body.name).toBe("Acme")
			}))
	})
})
