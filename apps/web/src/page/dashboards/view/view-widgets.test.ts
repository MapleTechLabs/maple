import { DashboardDocument } from "@maple/domain/http"
import { Schema } from "effect"
import { describe, expect, test } from "vitest"
import { stableWidget } from "./view-widgets"

const decodeBoard = (name: string, unit: string) =>
	Schema.decodeSync(DashboardDocument)({
		id: "dash_memo",
		name,
		timeRange: { type: "relative", value: "1h" },
		widgets: [
			{
				id: "errors",
				visualization: "stat",
				dataSource: { kind: "route", endpoint: "errors_summary" },
				display: { title: "Errors", unit },
				layout: { x: 0, y: 0, w: 3, h: 2 },
			},
		],
		createdAt: "2026-09-19T12:00:00.000Z",
		updatedAt: "2026-09-28T12:00:00.000Z",
		schemaVersion: 3,
	}).widgets[0]

describe("a tile's widget across store updates", () => {
	test("a re-decoded but unchanged widget draws as the object the tile last drew", () => {
		const first = decodeBoard("Board", "number")
		const renamed = decodeBoard("Board v2", "number")
		expect(renamed).not.toBe(first)
		expect(first === undefined ? undefined : stableWidget(first)).toBe(first)
		expect(renamed === undefined ? undefined : stableWidget(renamed)).toBe(first)
	})

	test("a changed widget draws as the new object", () => {
		const first = decodeBoard("Board", "number")
		const changed = decodeBoard("Board", "percent")
		if (first !== undefined) stableWidget(first)
		expect(changed === undefined ? undefined : stableWidget(changed)).toBe(changed)
	})
})
