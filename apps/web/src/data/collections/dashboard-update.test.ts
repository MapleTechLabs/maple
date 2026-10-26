import { describe, expect, it } from "vitest"
import { DashboardDocument, DashboardId, IsoDateTimeString } from "@maple/domain/http"
import { dashboardUpdateRequest } from "./dashboard-update"

const document = (overrides: Partial<DashboardDocument> = {}) =>
	new DashboardDocument({
		id: DashboardId.make("dash-1"),
		name: "Operations",
		timeRange: { type: "relative", value: "12h" },
		widgets: [],
		createdAt: IsoDateTimeString.make("2026-01-01T00:00:00.000Z"),
		updatedAt: IsoDateTimeString.make("2026-01-01T00:00:00.000Z"),
		...overrides,
	})

describe("dashboard update intent", () => {
	it("sends only the name when a stale client renames a dashboard", () => {
		const stale = document()
		expect(dashboardUpdateRequest(stale, document({ name: "Production" }))).toEqual({
			name: "Production",
		})
	})

	it("does not send an older name when changing the layout or metadata", () => {
		const before = document()
		const after = document({
			description: "Updated by another editor",
			timeRange: { type: "relative", value: "1h" },
		})
		expect(dashboardUpdateRequest(before, after)).toEqual({
			description: after.description,
			timeRange: after.timeRange,
		})
	})

	it("encodes explicit clears while treating missing/default fields and timestamps as unchanged", () => {
		const before = document({ description: "Old", tags: ["prod"], refreshIntervalSeconds: 30 })
		expect(dashboardUpdateRequest(before, document())).toEqual({
			description: null,
			tags: [],
			refreshIntervalSeconds: null,
		})
		expect(
			dashboardUpdateRequest(
				document(),
				document({
					tags: [],
					sections: [],
					variables: [],
					updatedAt: IsoDateTimeString.make("2026-01-02T00:00:00.000Z"),
				}),
			),
		).toEqual({})
	})

	it("keeps widget replacement intent, including deleting the last widget", () => {
		const widget: DashboardDocument["widgets"][number] = {
			id: "w1",
			visualization: "chart",
			display: {},
			dataSource: { kind: "query", resultShape: "timeseries", queries: [] },
			layout: { x: 0, y: 0, w: 3, h: 3 },
		}
		expect(dashboardUpdateRequest(document({ widgets: [widget] }), document())).toEqual({ widgets: [] })
		expect(dashboardUpdateRequest(document(), document({ widgets: [widget] }))).toEqual({
			widgets: [widget],
		})
	})
})
