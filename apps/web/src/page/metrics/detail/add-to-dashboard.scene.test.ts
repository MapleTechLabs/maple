import { Result } from "effect"
import { describe, expect, test } from "vitest"
import { toLoadFailure } from "../../../data/load-failure"
import * as AddToDashboard from "./add-to-dashboard"

const draft = null
const context = { orgId: "org_acme", draft }
const names = (commands: ReadonlyArray<{ readonly name: string }> | undefined) =>
	(commands ?? []).map(({ name }) => name)

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
		expect(failed.model.error?.title).toBe("Failed to create dashboard")
	})
})
