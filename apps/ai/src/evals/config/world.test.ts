/**
 * The configuration world answers the probes its tasks open with. A task whose rule, source or
 * dashboard is missing measures the fixture, so this fails before an eval run does.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { installFakeWarehouse, restoreWarehouse } from "../../mcp/__evals__/fake-warehouse"
import {
	asCaller,
	makeEvalRuntime,
	markdown,
	runToolDirect,
	type EvalRuntime,
} from "../../mcp/__evals__/eval-runtime"
import { ADMIN_CALLER, CONFIG_WORLD, seedConfigWorld } from "./world"

let rt: EvalRuntime

beforeAll(async () => {
	installFakeWarehouse([], undefined, "empty")
	const base = makeEvalRuntime()
	await seedConfigWorld(base)
	rt = asCaller(base, ADMIN_CALLER)
})

afterAll(async () => {
	restoreWarehouse()
	await rt.dispose()
})

const listed = async (tool: string, params: unknown = {}) => markdown(await runToolDirect(rt, tool, params))

describe("configuration world", () => {
	it("lists both destinations", async () => {
		const text = await listed("list_alert_destinations")
		expect(text).toContain(CONFIG_WORLD.destination)
		expect(text).toContain(CONFIG_WORLD.unusedDestination)
	})

	it("lists the token sources beside the default one", async () => {
		const text = await listed("list_ingest_sources")
		expect(text).toContain(CONFIG_WORLD.source)
		expect(text).toContain(CONFIG_WORLD.otherSource)
		expect(text).toContain(CONFIG_WORLD.pausedSource)
	})

	it("lists the alert rules, the window and the silence", async () => {
		const rules = await listed("list_alert_rules")
		expect(rules).toContain(CONFIG_WORLD.rule)
		expect(rules).toContain(CONFIG_WORLD.otherRule)
		expect(await listed("list_maintenance_windows")).toContain(CONFIG_WORLD.window)
		expect(await listed("list_alert_silences")).toContain(CONFIG_WORLD.silenceReason)
	})

	it("lists the ingest rules and the dashboards", async () => {
		const rules = await listed("list_ingest_rules")
		expect(rules).toContain(CONFIG_WORLD.dropRule)
		expect(rules).toContain(CONFIG_WORLD.redactRule)
		const dashboards = await listed("list_dashboards")
		expect(dashboards).toContain(CONFIG_WORLD.dashboard)
		expect(dashboards).toContain(CONFIG_WORLD.staleDashboard)
	})
})
