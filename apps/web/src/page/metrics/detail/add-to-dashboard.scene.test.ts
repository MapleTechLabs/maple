import { Result, Array as Arr } from "effect"
import { describe, expect, test } from "vitest"
import { toLoadFailure } from "@maple/views/data/load-failure"
import * as AddToDashboard from "./add-to-dashboard"

const draft = null
const timeRange = { type: "relative" as const, value: "7d" }
const context = { orgId: "org_acme", draft, timeRange }
const names = (commands: ReadonlyArray<{ readonly name: string }> | undefined) =>
	Arr.map(commands ?? [], ({ name }) => name)

const cpu = {
	id: "q1",
	name: "A",
	dataSource: "metrics" as const,
	aggregation: "avg",
	metricName: "cpu",
}

describe("add to dashboard", () => {
	test("a blank name creates nothing", () => {
		const model = { ...AddToDashboard.init(), newName: "   " }
		expect(
			names(AddToDashboard.update(model, AddToDashboard.Message.ClickedCreate(), context).commands),
		).toEqual([])
	})

	test("dashboards synced for another org are dropped", () => {
		const updated = AddToDashboard.update(
			AddToDashboard.init(),
			AddToDashboard.Message.UpdatedDashboards({
				orgId: "org_other",
				dashboards: [{ id: "d1", name: "A", widgetCount: 0 }],
			}),
			context,
		)
		expect(updated.model.dashboards).toEqual([])
	})

	test("a widget that landed closes the dialog and opens its dashboard", () => {
		const added = AddToDashboard.update(
			{ ...AddToDashboard.init(), isCreating: true },
			AddToDashboard.Message.CompletedCreateDashboard({ result: Result.succeed("dash_1") }),
			context,
		)
		expect(added.outMessage).toEqual(AddToDashboard.OutMessage.OpenedDashboard({ dashboardId: "dash_1" }))
		expect(added.model.isCreating).toBe(false)
	})

	test("a second pick while the first add is in flight adds and navigates once", () => {
		const withDraft = {
			orgId: "org_acme",
			timeRange,
			draft: {
				id: "q1",
				name: "A",
				dataSource: "metrics" as const,
				aggregation: "avg",
				metricName: "cpu",
			},
		}
		const pick = (dashboardId: string) => AddToDashboard.Message.ClickedDashboard({ dashboardId })
		const first = AddToDashboard.update(AddToDashboard.init(), pick("dash_1"), withDraft)
		expect(names(first.commands)).toEqual(["AddMetricWidgetToDashboard"])
		expect(names(AddToDashboard.update(first.model, pick("dash_1"), withDraft).commands)).toEqual([])
		expect(names(AddToDashboard.update(first.model, pick("dash_2"), withDraft).commands)).toEqual([])
		const done = (dashboardId: string) =>
			AddToDashboard.Message.CompletedAddWidget({ dashboardId, result: Result.void })
		expect(AddToDashboard.update(first.model, done("dash_2"), withDraft).outMessage).toBeUndefined()
		const landed = AddToDashboard.update(first.model, done("dash_1"), withDraft)
		expect(landed.outMessage).toEqual(
			AddToDashboard.OutMessage.OpenedDashboard({ dashboardId: "dash_1" }),
		)
		expect(AddToDashboard.update(landed.model, done("dash_1"), withDraft).outMessage).toBeUndefined()
	})

	test("a failed create keeps the dialog open with the error", () => {
		const failed = AddToDashboard.update(
			{ ...AddToDashboard.init(), isCreating: true },
			AddToDashboard.Message.CompletedCreateDashboard({
				result: Result.fail(toLoadFailure(new Error("boom"))),
			}),
			context,
		)
		expect(failed.outMessage).toBeUndefined()
		expect(failed.model.error?.title).toBe("Couldn't create dashboard")
	})

	test("a new dashboard opens on the explorer's window, an absolute one included", () => {
		expect(AddToDashboard.explorerTimeRangeOf({ timePreset: "7d" }, "24h")).toEqual(timeRange)
		expect(AddToDashboard.explorerTimeRangeOf({}, "24h")).toEqual({ type: "relative", value: "24h" })
		expect(
			AddToDashboard.explorerTimeRangeOf(
				{ startTime: "2026-10-01T00:00:00.000Z", endTime: "2026-10-02T00:00:00.000Z" },
				"24h",
			).type,
		).toBe("absolute")
		const created = AddToDashboard.update(
			{ ...AddToDashboard.init(), newName: "Latency" },
			AddToDashboard.Message.ClickedCreate(),
			{ ...context, draft: cpu },
		)
		expect(created.commands?.[0]?.args).toMatchObject({ timeRange })
	})

	test("the widget carries the unit inferred from the metric", () => {
		const latency = { ...cpu, metricName: "http.server.duration" }
		expect(AddToDashboard.widgetOf(latency, "q").display).toMatchObject({ unit: "duration_ms" })
	})

	test("picking a dashboard after a failure clears the old error", () => {
		const failed = {
			...AddToDashboard.init(),
			error: { title: "Couldn't add widget", failure: toLoadFailure(new Error("boom")) },
		}
		const picked = AddToDashboard.update(
			failed,
			AddToDashboard.Message.ClickedDashboard({ dashboardId: "dash_1" }),
			{ ...context, draft: cpu },
		)
		expect(picked.model.error).toBeNull()
	})

	test("a failed add stays in the dialog with its error instead of navigating", () => {
		const adding = { ...AddToDashboard.init(), addingTo: "dash_1" }
		const failed = AddToDashboard.update(
			adding,
			AddToDashboard.Message.CompletedAddWidget({
				dashboardId: "dash_1",
				result: Result.fail(toLoadFailure(new Error("write rejected"))),
			}),
			context,
		)
		expect(failed.outMessage).toBeUndefined()
		expect(failed.model.error?.title).toBe("Couldn't add widget")
	})
})
