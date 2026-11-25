/**
 * The configuration writes added for ingest sources, alert destinations, maintenance windows and
 * dashboards, run through the registry against the real services and a migrated database. Each
 * test reads the change back through the list tool an agent would use next.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import * as Policy from "@maple/domain/policy"
import { installFakeWarehouse, restoreWarehouse } from "../../__evals__/fake-warehouse"
import {
	asCaller,
	makeEvalRuntime,
	markdown,
	runToolDirect,
	type EvalRuntime,
} from "../../__evals__/eval-runtime"
import { ADMIN_CALLER, CONFIG_WORLD, seedConfigWorld } from "../../../evals/config/world"

const W = CONFIG_WORLD

let admin: EvalRuntime
let member: EvalRuntime
/** What the next webhook delivery answers with; the destinations' URLs are never really called. */
let webhookStatus = 200
const delivered: Array<string> = []

interface ToolResult {
	readonly isError?: boolean
	readonly structuredContent?: unknown
	readonly content?: ReadonlyArray<{ readonly text?: string }>
}

beforeAll(async () => {
	vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
		delivered.push(String(input instanceof Request ? input.url : input))
		return new Response(webhookStatus === 200 ? "ok" : "upstream said no", { status: webhookStatus })
	})
	installFakeWarehouse([], undefined, "empty")
	member = makeEvalRuntime()
	await seedConfigWorld(member)
	admin = asCaller(member, ADMIN_CALLER)
})

afterAll(async () => {
	restoreWarehouse()
	vi.unstubAllGlobals()
	await member.dispose()
})

const run = (name: string, params: unknown, rt: EvalRuntime = admin): Promise<ToolResult> =>
	runToolDirect(rt, name, params)

const text = async (name: string, params: unknown = {}, rt: EvalRuntime = admin) =>
	markdown(await run(name, params, rt))

/** The row of a markdown table whose cells include `label`, or undefined. */
const rowOf = (table: string, label: string) =>
	table.split("\n").find((line) => line.startsWith("|") && line.includes(label))

/** A listed resource's id, read from the first id-shaped cell of its row. */
const idOf = (table: string, label: string, pattern: RegExp) => rowOf(table, label)?.match(pattern)?.[0]

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/

describe("manage_ingest_source", () => {
	it("pauses a source until it is resumed, and resumes it", async () => {
		const paused = await text("manage_ingest_source", { action: "pause", source: W.source })
		expect(paused).toContain("Ingest source paused")
		expect(paused).toContain("until resumed")

		const resumed = await text("manage_ingest_source", { action: "resume", source: W.source })
		expect(resumed).toContain("Ingest source resumed")
		expect(resumed).toMatch(/Paused.*no/)
	})

	it("pauses until a time, and refuses one that has already passed", async () => {
		const until = new Date(Date.now() + 24 * 3_600_000).toISOString()
		const paused = await text("manage_ingest_source", {
			action: "pause",
			source: W.source,
			resume_at: until,
		})
		expect(paused).toContain(until.slice(0, 16))

		const past = await run("manage_ingest_source", {
			action: "pause",
			source: W.source,
			resume_at: "2020-01-01T00:00:00Z",
		})
		expect(past.isError).toBe(true)
		expect(markdown(past)).toContain("future")
		await run("manage_ingest_source", { action: "resume", source: W.source })
	})

	it("renames a source, found afterwards by its new name and still by its id", async () => {
		const before = await text("list_ingest_sources")
		const id = idOf(before, W.otherSource, /src_[A-Za-z0-9]+/)
		expect(id).toBeDefined()

		await run("manage_ingest_source", { action: "update", source: W.otherSource, name: "payments-otel" })
		const after = await text("list_ingest_sources")
		expect(rowOf(after, "payments-otel")).toContain(id)
		expect(rowOf(after, W.otherSource)).toBeUndefined()

		// Back to the seeded name by id, so the other tests find it.
		await run("manage_ingest_source", { action: "update", source: id, name: W.otherSource })
		expect(rowOf(await text("list_ingest_sources"), W.otherSource)).toContain(id)
	})

	it("reads a reference as an id before a name, when another source is named like that id", async () => {
		const listed = await text("list_ingest_sources")
		const id = idOf(listed, W.otherSource, /src_[A-Za-z0-9]+/)
		const namesake = idOf(listed, W.source, /src_[A-Za-z0-9]+/)
		expect(id).toBeDefined()
		expect(namesake).not.toBe(id)
		await run("manage_ingest_source", { action: "update", source: namesake, name: id })

		const paused = await run("manage_ingest_source", { action: "pause", source: id })
		expect(paused.isError).not.toBe(true)
		expect(markdown(paused)).toContain(W.otherSource)

		// Back to the seeded state, so the other tests find both.
		await run("manage_ingest_source", { action: "resume", source: id })
		await run("manage_ingest_source", { action: "update", source: namesake, name: W.source })
		expect(rowOf(await text("list_ingest_sources"), W.source)).toContain(namesake)
	})

	it("limits the signals a token may send, and lifts the limit", async () => {
		const limited = await text("manage_ingest_source", {
			action: "update",
			source: W.source,
			allowed_signals: ["traces", "logs"],
		})
		expect(limited).toMatch(/Signals.*traces, logs/)

		const lifted = await text("manage_ingest_source", {
			action: "update",
			source: W.source,
			allow_all_signals: true,
		})
		expect(lifted).toMatch(/Signals.*all/)
	})

	it("sets a rate limit, and reports a fractional one as the parameter to fix", async () => {
		const limited = await text("manage_ingest_source", {
			action: "update",
			source: W.source,
			rate_limit_rps: 50,
		})
		expect(limited).toContain("50 requests/s")

		const fractional = await run("manage_ingest_source", {
			action: "update",
			source: W.source,
			rate_limit_rps: 2.5,
		})
		expect(fractional.isError).toBe(true)
		expect(markdown(fractional)).toContain("rate_limit_rps")

		const lifted = await text("manage_ingest_source", {
			action: "update",
			source: W.source,
			clear_rate_limit: true,
		})
		expect(lifted).toMatch(/Rate limit.*none/)
	})

	it("refuses an update that changes nothing, and a source that does not exist", async () => {
		const empty = await run("manage_ingest_source", { action: "update", source: W.source })
		expect(empty.isError).toBe(true)
		expect(markdown(empty)).toContain("Nothing to change")

		const missing = await run("manage_ingest_source", { action: "pause", source: "no-such-source" })
		expect(missing.isError).toBe(true)
		expect(markdown(missing)).toContain("list_ingest_sources")
	})

	it("deletes a token source only when confirmed", async () => {
		const unconfirmed = await run("manage_ingest_source", {
			action: "delete",
			source: W.pausedSource,
			confirm: false,
		})
		expect(unconfirmed.isError).toBe(true)
		expect(await text("list_ingest_sources")).toContain(W.pausedSource)

		const deleted = await text("manage_ingest_source", {
			action: "delete",
			source: W.pausedSource,
			confirm: true,
		})
		expect(deleted).toContain("Ingest source deleted")
		expect(await text("list_ingest_sources")).not.toContain(W.pausedSource)
	})

	it("refuses a member, who may not manage sources", async () => {
		const refused = await run("manage_ingest_source", { action: "pause", source: W.source }, member)
		expect(refused.isError).toBe(true)
		const row = rowOf(await text("list_ingest_sources"), W.source)
		expect(row).not.toContain("paused")
	})
})

describe("manage_alert_destination", () => {
	it("lists what routes to each destination, so an unused one is one lookup away", async () => {
		const listed = await text("list_alert_destinations")
		expect(rowOf(listed, W.destination)).toContain(`rule "${W.rule}"`)
		expect(rowOf(listed, W.destination)).toContain(`rule "${W.otherRule}"`)
		expect(rowOf(listed, W.unusedDestination)).toContain("| nothing |")
	})

	it("turns a destination off and on again without touching its target", async () => {
		const off = await text("manage_alert_destination", {
			action: "update",
			destination: W.unusedDestination,
			enabled: false,
		})
		expect(off).toContain("Alert destination updated")
		expect(off).toContain("hooks.example.com")
		expect(await text("list_alert_destinations", { enabled_only: true })).not.toContain(
			W.unusedDestination,
		)

		await run("manage_alert_destination", {
			action: "update",
			destination: W.unusedDestination,
			enabled: true,
		})
		expect(await text("list_alert_destinations", { enabled_only: true })).toContain(W.unusedDestination)
	})

	it("renames a destination, addressed by its REST id", async () => {
		const listed = await text("list_alert_destinations")
		const publicId = idOf(listed, W.unusedDestination, /dest_[A-Za-z0-9]+/)
		expect(publicId).toBeDefined()

		await run("manage_alert_destination", { action: "update", destination: publicId, name: "archive" })
		expect(rowOf(await text("list_alert_destinations"), "archive")).toContain(publicId)

		await run("manage_alert_destination", {
			action: "update",
			destination: publicId,
			name: W.unusedDestination,
		})
	})

	it("reports a delivered test, and a refused one as the result with its reason", async () => {
		delivered.length = 0
		webhookStatus = 200
		const sent = await run("manage_alert_destination", { action: "test", destination: W.destination })
		expect(sent.isError).not.toBe(true)
		expect(markdown(sent)).toContain("Destination test passed")
		// The transport's own words say a message went out; the headline never claims it.
		expect(markdown(sent)).toContain("Test notification sent")
		expect(delivered).toEqual(["https://hooks.example.com/maple/ops"])

		webhookStatus = 500
		const failed = await run("manage_alert_destination", { action: "test", destination: W.destination })
		expect(failed.isError).not.toBe(true)
		expect(markdown(failed)).toContain("Destination test failed")
		// The failure is recorded on the destination, where the next list shows it.
		expect(rowOf(await text("list_alert_destinations"), W.destination)).not.toMatch(/\| - \|$/)
		webhookStatus = 200
	})

	it("refuses to delete a destination a rule still uses, and names the rule", async () => {
		const refused = await run("manage_alert_destination", {
			action: "delete",
			destination: W.destination,
			confirm: true,
		})
		expect(refused.isError).toBe(true)
		expect(markdown(refused)).toContain(W.rule)
		expect(markdown(refused)).toContain("remove_destination_ids")
		expect(await text("list_alert_destinations")).toContain(W.destination)
	})

	it("says where the other destination types are created when email is unavailable", async () => {
		// The eval deployment has no auth provider, so there is no member directory to email.
		const created = await run("manage_alert_destination", {
			action: "create",
			name: "On-call email",
			type: "email",
		})
		expect(created.isError).toBe(true)
		expect(markdown(created)).toContain("Alerts > Destinations")
		expect(await text("list_alert_destinations")).not.toContain("On-call email")
	})

	it("offers only the destination type that needs no credential", async () => {
		const refused = await run("manage_alert_destination", {
			action: "create",
			name: "Pager",
			type: "pagerduty",
		})
		expect(refused.isError).toBe(true)
		expect(await text("list_alert_destinations")).not.toContain("Pager")
	})

	it("deletes an unused destination only when confirmed", async () => {
		const unconfirmed = await run("manage_alert_destination", {
			action: "delete",
			destination: W.unusedDestination,
			confirm: false,
		})
		expect(unconfirmed.isError).toBe(true)
		expect(await text("list_alert_destinations")).toContain(W.unusedDestination)

		const deleted = await text("manage_alert_destination", {
			action: "delete",
			destination: W.unusedDestination,
			confirm: true,
		})
		expect(deleted).toContain("Alert destination deleted")
		expect(await text("list_alert_destinations")).not.toContain(W.unusedDestination)
	})

	it("tells a member they may not delete before asking them to confirm", async () => {
		const refused = await run(
			"manage_alert_destination",
			{ action: "delete", destination: W.destination, confirm: false },
			member,
		)
		expect(refused.isError).toBe(true)
		expect(markdown(refused)).not.toContain("not confirmed")
		expect(markdown(refused)).toContain(Policy.denialFor("alerts:manage").message)
	})

	it("refuses a member, who may not manage alerts", async () => {
		const refused = await run(
			"manage_alert_destination",
			{ action: "update", destination: W.destination, enabled: false },
			member,
		)
		expect(refused.isError).toBe(true)
		expect(await text("list_alert_destinations", { enabled_only: true })).toContain(W.destination)
	})
})

describe("manage_maintenance_window action=update", () => {
	const windowId = async () => {
		const id = idOf(await text("list_maintenance_windows"), W.window, UUID)
		if (id === undefined) throw new Error("the seeded maintenance window is not listed")
		return id
	}

	it("lengthens a weekly window and keeps its days, start and matchers", async () => {
		const updated = await text("manage_maintenance_window", {
			action: "update",
			maintenance_window_id: await windowId(),
			duration_minutes: 120,
		})
		expect(updated).toContain("weekly thu 14:00 UTC for 120m")
		expect(updated).toContain("services: checkout")
	})

	it("moves a weekly window to another day in place, leaving one window", async () => {
		await run("manage_maintenance_window", {
			action: "update",
			maintenance_window_id: await windowId(),
			days: ["fri"],
		})
		const listed = await text("list_maintenance_windows")
		expect(rowOf(listed, W.window)).toContain("weekly fri 14:00 UTC")
		expect(listed.split("\n").filter((line) => line.includes(W.window))).toHaveLength(1)
	})

	it("replaces only the matcher that was passed", async () => {
		const updated = await text("manage_maintenance_window", {
			action: "update",
			maintenance_window_id: await windowId(),
			environments: ["production"],
		})
		expect(updated).toContain("services: checkout AND environments: production")

		const cleared = await text("manage_maintenance_window", {
			action: "update",
			maintenance_window_id: await windowId(),
			environments: [],
		})
		expect(cleared).toContain("services: checkout")
		expect(cleared).not.toContain("environments:")
	})

	it("refuses to remove the last matcher, or to turn a weekly window into a one-off", async () => {
		const id = await windowId()
		const noMatcher = await run("manage_maintenance_window", {
			action: "update",
			maintenance_window_id: id,
			services: [],
		})
		expect(noMatcher.isError).toBe(true)
		expect(markdown(noMatcher)).toContain("at least one matcher")

		const oneOff = await run("manage_maintenance_window", {
			action: "update",
			maintenance_window_id: id,
			ends_at: new Date(Date.now() + 3_600_000).toISOString(),
		})
		expect(oneOff.isError).toBe(true)
		expect(markdown(oneOff)).toContain("repeats weekly")
		expect(rowOf(await text("list_maintenance_windows"), W.window)).toContain("services: checkout")
	})

	it("turns a window off without deleting it", async () => {
		const off = await text("manage_maintenance_window", {
			action: "update",
			maintenance_window_id: await windowId(),
			enabled: false,
		})
		expect(off).toMatch(/Enabled.*no/)
		expect(await text("list_maintenance_windows")).toContain(W.window)
	})

	it("moves a one-off window's start and keeps its length", async () => {
		// Window bounds are kept to the second.
		const start = Math.floor(Date.now() / 1000) * 1000 + 24 * 3_600_000
		const created = await run("manage_maintenance_window", {
			action: "create",
			name: "Database migration",
			schedule_type: "once",
			starts_at: new Date(start).toISOString(),
			duration_minutes: 90,
			services: ["checkout"],
		})
		const id = markdown(created).match(UUID)?.[0]
		expect(id).toBeDefined()

		const later = start + 2 * 3_600_000
		const moved = await text("manage_maintenance_window", {
			action: "update",
			maintenance_window_id: id,
			starts_at: new Date(later).toISOString(),
		})
		expect(moved).toContain(
			`once ${new Date(later).toISOString()} to ${new Date(later + 90 * 60_000).toISOString()}`,
		)
	})
})

describe("delete_dashboard", () => {
	const dashboardId = async (name: string) => {
		const id = idOf(await text("list_dashboards"), name, UUID)
		if (id === undefined) throw new Error(`dashboard "${name}" is not listed`)
		return id
	}

	it("keeps the dashboard when the deletion is not confirmed", async () => {
		const refused = await run("delete_dashboard", {
			dashboard_id: await dashboardId(W.staleDashboard),
			confirm: false,
		})
		expect(refused.isError).toBe(true)
		expect(await text("list_dashboards")).toContain(W.staleDashboard)
	})

	it("deletes the named dashboard and leaves the others", async () => {
		const deleted = await text("delete_dashboard", {
			dashboard_id: await dashboardId(W.staleDashboard),
			confirm: true,
		})
		expect(deleted).toContain(`Deleted "${W.staleDashboard}"`)
		const listed = await text("list_dashboards")
		expect(listed).not.toContain(W.staleDashboard)
		expect(listed).toContain(W.dashboard)
	})

	it("answers not found for a dashboard that is already gone", async () => {
		const missing = await run("delete_dashboard", {
			dashboard_id: "0e1d2c3b-4a59-4687-9a0b-1c2d3e4f5a6b",
			confirm: true,
		})
		expect(missing.isError).toBe(true)
		expect(markdown(missing)).toContain("list_dashboards")
	})
})
