import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { Schema } from "effect"
import { RoleName } from "@maple/domain/http"
import {
	ApplyStatusPageConfigOutput,
	GetStatusPageConfigOutput,
	GetStatusPageOutput,
	ListStatusPagesOutput,
	StatusPageIncidentMutationOutput,
} from "@maple/domain/mcp-outputs"
import { executeSql } from "@maple/backend/platform/test-pglite"
import type { McpToolResult } from "../types"
import { makeEvalRuntime, markdown, runToolDirect, type EvalRuntime } from "../../__evals__/eval-runtime"

let rt: EvalRuntime
beforeAll(async () => {
	rt = makeEvalRuntime()
	const now = Date.now()
	await executeSql(
		rt.testDb,
		`INSERT INTO status_pages (id, org_id, name, slug, created_by, created_at, updated_at)
		 VALUES ($1, $2, 'Acme Status', 'acme-status', $3, to_timestamp($4 / 1000.0), to_timestamp($4 / 1000.0))`,
		["7f0b7d0e-0b6a-4f55-9a0e-2a4b9a0c1d01", rt.tenant.orgId, rt.tenant.userId, now],
	)
	await executeSql(
		rt.testDb,
		`INSERT INTO status_page_components (id, org_id, page_id, name, position, created_at, updated_at)
		 VALUES ($1, $2, $3, 'API', 0, to_timestamp($4 / 1000.0), to_timestamp($4 / 1000.0))`,
		[
			"7f0b7d0e-0b6a-4f55-9a0e-2a4b9a0c1d02",
			rt.tenant.orgId,
			"7f0b7d0e-0b6a-4f55-9a0e-2a4b9a0c1d01",
			now,
		],
	)
})
afterAll(async () => {
	await rt.dispose()
})

const decode = <S extends Schema.Codec<unknown, unknown, never, never>>(schema: S, result: McpToolResult) =>
	Schema.decodeUnknownSync(schema)(result.structuredContent)

describe("status page tools", () => {
	it("lists the org's pages with their REST ids", async () => {
		const output = decode(ListStatusPagesOutput, await runToolDirect(rt, "list_status_pages", {}))
		expect(output.total).toBe(1)
		expect(output.pages[0]).toMatchObject({ name: "Acme Status", slug: "acme-status" })
		expect(output.pages[0]?.id).toMatch(/^stp_/)
	})

	it("opens an agent incident as a draft that the page does not show", async () => {
		const created = decode(
			StatusPageIncidentMutationOutput,
			await runToolDirect(rt, "create_status_page_incident", {
				page: "acme-status",
				title: "Elevated API errors",
				message: "We are looking into elevated error rates.",
				components: ["API"],
				impact: "major",
			}),
		)
		expect(created.incident).toMatchObject({
			kind: "incident",
			status: "investigating",
			published: false,
			impact: "major",
		})
		expect(created.incident.id).toMatch(/^sti_/)

		// A draft names the component but does not change what visitors see.
		const page = decode(
			GetStatusPageOutput,
			await runToolDirect(rt, "get_status_page", { page: "acme-status" }),
		)
		expect(page.components).toMatchObject([{ name: "API", status: "operational" }])
		expect(page.activeIncidents.map((i) => i.id)).toContain(created.incident.id)
		expect(page.freshness.publishPending).toBe(true)

		// Publishing with the next update puts it on the page.
		const updated = decode(
			StatusPageIncidentMutationOutput,
			await runToolDirect(rt, "post_status_page_update", {
				incident: created.incident.id,
				status: "identified",
				message: "We found the cause and are rolling back.",
				publish: true,
			}),
		)
		expect(updated.incident).toMatchObject({ status: "identified", published: true, updateCount: 2 })
		const liveResult = await runToolDirect(rt, "get_status_page", { page: "Acme Status" })
		// The follow-up needs public wording, so it is a notice, not a half-filled call.
		expect(markdown(liveResult)).toContain("To update an open incident, call post_status_page_update")
		const live = decode(GetStatusPageOutput, liveResult)
		expect(live.components).toMatchObject([{ name: "API", status: "partial_outage" }])
		expect(live.overallStatus).toBe("partial_outage")

		const resolved = decode(
			StatusPageIncidentMutationOutput,
			await runToolDirect(rt, "resolve_status_page_incident", {
				incident: created.incident.id,
				message: "Error rates are back to normal.",
			}),
		)
		expect(resolved.incident.status).toBe("resolved")
		expect(resolved.incident.resolvedAt).not.toBeNull()
	})

	it("publishes straight away when asked", async () => {
		const created = decode(
			StatusPageIncidentMutationOutput,
			await runToolDirect(rt, "create_status_page_incident", {
				page: "acme-status",
				title: "Login delays",
				message: "Some sign-ins are slow.",
				publish: true,
			}),
		)
		expect(created.incident.published).toBe(true)
	})

	it("schedules maintenance as a draft with its window", async () => {
		const result = await runToolDirect(rt, "schedule_status_page_maintenance", {
			page: "acme-status",
			title: "Database upgrade",
			message: "The API may be read-only for a few minutes.",
			starts_at: "2026-08-01 02:00:00",
			ends_at: "2026-08-01T03:00:00Z",
			components: ["API"],
		})
		const output = decode(StatusPageIncidentMutationOutput, result)
		expect(output.incident).toMatchObject({
			kind: "maintenance",
			status: "scheduled",
			published: false,
			scheduledStart: "2026-08-01T02:00:00.000Z",
			scheduledEnd: "2026-08-01T03:00:00.000Z",
		})
		expect(markdown(result)).toContain("draft")
	})

	it("names the unknown component and page instead of guessing", async () => {
		const component = await runToolDirect(rt, "create_status_page_incident", {
			page: "acme-status",
			title: "x",
			message: "y",
			components: ["Billing"],
		})
		expect(component.isError).toBe(true)
		expect(markdown(component)).toContain("API")
		const page = await runToolDirect(rt, "get_status_page", { page: "nope" })
		expect(page.isError).toBe(true)
		expect(markdown(page)).toContain("list_status_pages")
	})

	it("resolves a draft and publishes it in the same call, or says it stayed a draft", async () => {
		const open = async (title: string) =>
			decode(
				StatusPageIncidentMutationOutput,
				await runToolDirect(rt, "create_status_page_incident", {
					page: "acme-status",
					title,
					message: "Investigating.",
				}),
			).incident.id
		const kept = await runToolDirect(rt, "resolve_status_page_incident", {
			incident: await open("Quiet draft"),
			message: "Never mind.",
		})
		expect(decode(StatusPageIncidentMutationOutput, kept).incident).toMatchObject({
			status: "resolved",
			published: false,
		})
		expect(markdown(kept)).toContain("closed as a draft")
		expect(markdown(kept)).not.toContain("post_status_page_update")

		const shown = decode(
			StatusPageIncidentMutationOutput,
			await runToolDirect(rt, "resolve_status_page_incident", {
				incident: await open("Public draft"),
				message: "Fixed.",
				publish: true,
			}),
		)
		expect(shown.incident).toMatchObject({ status: "resolved", published: true })
	})

	it("reads delayed while the page's monitors have not reported, and live once one has", async () => {
		const monitorId = "7f0b7d0e-0b6a-4f55-9a0e-2a4b9a0c1d09"
		const now = Date.now()
		await executeSql(
			rt.testDb,
			`INSERT INTO uptime_monitors (id, org_id, name, kind, config_json, created_by, created_at, updated_at, enabled)
			 VALUES ($1, $2, 'API health', 'http', $3, $4, now(), now(), true)`,
			[
				monitorId,
				rt.tenant.orgId,
				JSON.stringify({
					_tag: "http",
					url: "https://example.com/health",
					method: "GET",
					headers: {},
					assertions: [],
					timeoutMs: 5000,
				}),
				rt.tenant.userId,
			],
		)
		await executeSql(
			rt.testDb,
			`INSERT INTO uptime_monitor_states (monitor_id, org_id, status, recent_json, updated_at) VALUES ($1, $2, 'up', '[]', now())`,
			[monitorId, rt.tenant.orgId],
		)
		await executeSql(rt.testDb, `UPDATE status_page_components SET monitor_id = $1 WHERE name = 'API'`, [
			monitorId,
		])
		const freshness = async () =>
			decode(GetStatusPageOutput, await runToolDirect(rt, "get_status_page", { page: "acme-status" }))
				.freshness

		expect(await freshness()).toMatchObject({ state: "delayed", updatedAt: null })
		await executeSql(
			rt.testDb,
			`INSERT INTO uptime_monitor_daily (monitor_id, day, org_id, checks, failures, down_checks, last_check_at)
			 VALUES ($1, $2, $3, 1, 0, 0, to_timestamp($4 / 1000.0))`,
			[monitorId, new Date(now).toISOString().slice(0, 10), rt.tenant.orgId, now - 30_000],
		)
		expect((await freshness()).state).toBe("live")
	})

	describe("config", () => {
		const PAGE = "7f0b7d0e-0b6a-4f55-9a0e-2a4b9a0c1e01"
		const admin = () => ({
			...rt,
			tenant: { ...rt.tenant, roles: [Schema.decodeUnknownSync(RoleName)("org:admin")] },
		})
		beforeAll(async () => {
			const now = Date.now()
			await executeSql(
				rt.testDb,
				`INSERT INTO status_pages (id, org_id, name, slug, created_by, created_at, updated_at)
				 VALUES ($1, $2, 'Config Page', 'config-page', $3, to_timestamp($4 / 1000.0), to_timestamp($4 / 1000.0))`,
				[PAGE, rt.tenant.orgId, rt.tenant.userId, now],
			)
			await executeSql(
				rt.testDb,
				`INSERT INTO status_page_components (id, org_id, page_id, name, position, created_at, updated_at)
				 VALUES ($1, $2, $3, 'Web', 0, now(), now()), ($4, $2, $3, 'Docs', 1, now(), now())`,
				[
					"7f0b7d0e-0b6a-4f55-9a0e-2a4b9a0c1e02",
					rt.tenant.orgId,
					PAGE,
					"7f0b7d0e-0b6a-4f55-9a0e-2a4b9a0c1e03",
				],
			)
		})

		it("reads the page as a JSON document with public ids, fenced for the model", async () => {
			const result = await runToolDirect(rt, "get_status_page_config", { page: "config-page" })
			const { config } = result.structuredContent
			expect(config).toMatchObject({
				name: "Config Page",
				slug: "config-page",
				components: [{ name: "Web" }, { name: "Docs" }],
			})
			expect(config.components[0].id).toMatch(/^stc_/)
			expect(decode(GetStatusPageConfigOutput, result).config.components).toHaveLength(2)
			expect(markdown(result)).toContain("```json\n")
			expect(markdown(result)).toContain(`"id": "${config.components[0].id}"`)
		})

		it("applies an edited document passed as a JSON string and summarises what changed", async () => {
			const read = await runToolDirect(rt, "get_status_page_config", { page: "config-page" })
			const [web] = read.structuredContent.config.components
			const edited = {
				...read.structuredContent.config,
				description: "Live status.",
				components: [{ name: "API" }, { ...web, group: "Apps" }],
			}
			const result = await runToolDirect(admin(), "apply_status_page_config", {
				page: "config-page",
				config: JSON.stringify(edited),
			})
			expect(result.isError).not.toBe(true)
			const output = decode(ApplyStatusPageConfigOutput, result)
			expect(output.changes).toEqual({
				fields: ["description"],
				created: ["API"],
				updated: ["Web"],
				deleted: ["Docs"],
				reordered: false,
			})
			expect(output.config.components.map((c) => c.name)).toEqual(["API", "Web"])
			const text = markdown(result)
			expect(text).toContain("Components created")
			expect(text).toContain("Docs")

			const again = await runToolDirect(admin(), "apply_status_page_config", {
				page: "config-page",
				config: result.structuredContent.config,
			})
			expect(markdown(again)).toContain("Nothing changed")
		})

		it("reports nothing changed for a re-sent document that differs only until stored", async () => {
			const read = await runToolDirect(rt, "get_status_page_config", { page: "config-page" })
			const { config } = read.structuredContent
			const result = await runToolDirect(admin(), "apply_status_page_config", {
				page: "config-page",
				config: {
					...config,
					name: ` ${config.name} `,
					description: config.description === null ? "  " : ` ${config.description} `,
					components: config.components.map((c: { name: string }) => ({
						...c,
						name: ` ${c.name} `,
					})),
				},
			})
			expect(result.isError).not.toBe(true)
			expect(decode(ApplyStatusPageConfigOutput, result).changes).toEqual({
				fields: [],
				created: [],
				updated: [],
				deleted: [],
				reordered: false,
			})
			expect(markdown(result)).toContain("Nothing changed")
		})

		it("refuses a key the config does not define, as an object or as JSON text", async () => {
			const read = await runToolDirect(rt, "get_status_page_config", { page: "config-page" })
			const { config } = read.structuredContent
			const [first, ...rest] = config.components
			const { show_uptime: _shown, ...withoutUptime } = first
			const typo = { ...config, components: [{ ...withoutUptime, show_uptim: false }, ...rest] }
			const asObject = await runToolDirect(admin(), "apply_status_page_config", {
				page: "config-page",
				config: typo,
			})
			expect(asObject.isError).toBe(true)
			expect(markdown(asObject)).toContain("show_uptim")
			const asText = await runToolDirect(admin(), "apply_status_page_config", {
				page: "config-page",
				config: JSON.stringify({ ...config, colour: "red" }),
			})
			expect(asText.isError).toBe(true)
			expect(markdown(asText)).toContain("colour")
			const after = await runToolDirect(rt, "get_status_page_config", { page: "config-page" })
			expect(after.structuredContent.config).toEqual(config)
		})

		it("refuses a document read before the page changed, and says to read it again", async () => {
			const read = await runToolDirect(rt, "get_status_page_config", { page: "config-page" })
			const { config } = read.structuredContent
			await runToolDirect(admin(), "apply_status_page_config", {
				page: "config-page",
				config: { ...config, description: "Changed meanwhile." },
			})
			const moved = await runToolDirect(rt, "get_status_page_config", { page: "config-page" })
			const stale = await runToolDirect(admin(), "apply_status_page_config", {
				page: "config-page",
				config: { ...config, components: [] },
			})
			expect(stale.isError).toBe(true)
			expect(markdown(stale)).toContain("get_status_page_config again")
			const after = await runToolDirect(rt, "get_status_page_config", { page: "config-page" })
			expect(after.structuredContent.config).toEqual(moved.structuredContent.config)
		})

		it("refuses members and names a component id from another page", async () => {
			const read = await runToolDirect(rt, "get_status_page_config", { page: "config-page" })
			const refused = await runToolDirect(rt, "apply_status_page_config", {
				page: "config-page",
				config: read.structuredContent.config,
			})
			expect(refused.isError).toBe(true)
			expect(markdown(refused)).toContain("only org admins")

			const other = await runToolDirect(rt, "get_status_page_config", { page: "acme-status" })
			const stolen = other.structuredContent.config.components[0].id
			const foreign = await runToolDirect(admin(), "apply_status_page_config", {
				page: "config-page",
				config: {
					...read.structuredContent.config,
					components: [{ id: stolen, name: "Stolen" }],
				},
			})
			expect(foreign.isError).toBe(true)
			expect(markdown(foreign)).toContain(stolen)
			const after = await runToolDirect(rt, "get_status_page_config", { page: "config-page" })
			expect(after.structuredContent.config).toEqual(read.structuredContent.config)
		})
	})
})
