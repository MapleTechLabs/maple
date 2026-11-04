import { DashboardDocument, IsoDateTimeString } from "@maple/domain/http"
import { Schema } from "effect"
import { describe, expect, test } from "vitest"
import { withClone } from "./layout"

const tile = (id: string, y: number, group?: { sectionId: string; tabId: string }) => ({
	id,
	visualization: "stat",
	dataSource: { kind: "static" },
	display: { title: id },
	layout: { x: 0, y, w: 12, h: 2 },
	...group,
})

// `gone` still points at a group that was deleted; it draws on the root grid below `a`.
const board = Schema.decodeUnknownSync(DashboardDocument)({
	id: "dash_layout",
	name: "Layout",
	timeRange: { type: "relative", value: "6h" },
	widgets: [tile("a", 0), tile("gone", 2, { sectionId: "s_deleted", tabId: "t" })],
	createdAt: "2026-09-19T12:00:00.000Z",
	updatedAt: "2026-09-28T12:00:00.000Z",
	schemaVersion: 3,
})

describe("withClone", () => {
	test("a copy of a tile from a deleted group lands on the root grid, below what is there", () => {
		const cloned = withClone(board, "gone", "copy", IsoDateTimeString.make("2026-10-01T00:00:00.000Z"))
		const copy = cloned.widgets.find((widget) => widget.id === "copy")
		expect(copy?.sectionId).toBeUndefined()
		expect(copy?.layout.y).toBeGreaterThanOrEqual(4)
	})
})
