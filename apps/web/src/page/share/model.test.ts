import { redactForShare } from "@maple/widgets/dashboard"
import { Schema, Array as Arr } from "effect"
import { describe, expect, it } from "vitest"
import { SharedDashboard } from "./model"

const decode = Schema.decodeUnknownSync(SharedDashboard)

const productWidget = (id: string, visualization: string, display: Record<string, unknown>) => ({
	id,
	visualization,
	display,
	layout: { x: 0, y: 0, w: 6, h: 4 },
	dataSource: { kind: "route", endpoint: "product_events_paths", params: {} },
})

describe("SharedDashboard", () => {
	it("decodes the redacted funnel, sparkline and paths displays a share publishes", () => {
		const redacted = redactForShare({
			id: "dash-1",
			name: "Product",
			timeRange: { type: "relative", value: "7d" },
			widgets: [
				productWidget("w-funnel", "funnel", {
					title: "Signup",
					funnel: { variant: "dropoff", steps: [{ kind: "event", eventName: "signed_up" }] },
				}),
				{
					...productWidget("w-stat", "stat", {
						title: "Requests",
						sparkline: {
							enabled: true,
							dataSource: { kind: "query", resultShape: "timeseries", queries: [{ id: "q1" }] },
						},
					}),
					dataSource: { kind: "static" },
				},
				productWidget("w-paths", "paths", {
					title: "After signup",
					paths: {
						anchor: { kind: "event", eventName: "signed_up" },
						direction: "before",
						depth: 3,
					},
				}),
			],
		})

		const share = decode({
			mode: "public",
			scope: "dashboard",
			embeddable: false,
			dashboard: { ...redacted, sections: [] },
		})

		expect(Arr.map(share.dashboard.widgets, (widget) => widget.display)).toEqual([
			{ title: "Signup", funnel: { variant: "dropoff" } },
			{
				title: "Requests",
				sparkline: { enabled: true, dataSource: { kind: "query", resultShape: "timeseries" } },
			},
			{ title: "After signup", paths: { direction: "before" } },
		])
	})
})
