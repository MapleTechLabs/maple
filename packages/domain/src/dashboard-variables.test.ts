import { describe, expect, it } from "vitest"
import { Schema } from "effect"

import { DashboardDocument, DashboardVariableSchema } from "./http/dashboards"

const decodeVariable = Schema.decodeUnknownSync(DashboardVariableSchema)
const decodeDocument = Schema.decodeUnknownSync(DashboardDocument)
const encodeDocument = Schema.encodeSync(DashboardDocument)

const baseDocument = {
	id: "dash-1",
	name: "Test",
	timeRange: { type: "relative", value: "12h" },
	widgets: [],
	createdAt: "2026-01-01T00:00:00.000Z",
	updatedAt: "2026-01-01T00:00:00.000Z",
}

describe("DashboardVariableSchema", () => {
	it.each(["__x", "1x", "a-b", "", "a b", "$x"])("rejects invalid name %j", (name) => {
		expect(() => decodeVariable({ name, type: "textbox" })).toThrow()
	})

	it("rejects unknown facets and scopes", () => {
		expect(() =>
			decodeVariable({ name: "x", type: "query", source: { kind: "facet", facet: "bogus" } }),
		).toThrow()
		expect(() =>
			decodeVariable({
				name: "x",
				type: "query",
				source: { kind: "attribute", scope: "metric", attributeKey: "k" },
			}),
		).toThrow()
	})
})

describe("DashboardDocument with variables", () => {
	it("round-trips a document without variables (back-compat)", () => {
		const decoded = decodeDocument(baseDocument)
		expect(decoded.variables).toBeUndefined()
		expect("variables" in encodeDocument(decoded)).toBe(false)
	})
})

const widget = (id: string, membership: Record<string, string> = {}) => ({
	id,
	visualization: "chart",
	dataSource: { kind: "query", resultShape: "timeseries", queries: [] },
	display: {},
	layout: { x: 0, y: 0, w: 4, h: 4 },
	...membership,
})

describe("DashboardDocument with sections", () => {
	it("round-trips a document without sections (back-compat)", () => {
		const decoded = decodeDocument({ ...baseDocument, widgets: [widget("w1")] })
		expect(decoded.sections).toBeUndefined()
		const encoded = encodeDocument(decoded)
		expect("sections" in encoded).toBe(false)
		expect("sectionId" in encoded.widgets[0]!).toBe(false)
	})

	// This is the entire back-compat story for an older client reading a newer
	// document: `Schema.Struct` ignores excess properties, so sections are
	// dropped on decode and the board renders flat rather than failing to load.
	// It currently rests on an implicit Effect default, so pin it.
	it("ignores unknown keys rather than failing the read", () => {
		const decoded = decodeDocument({
			...baseDocument,
			widgets: [widget("w1")],
			somethingFromTheFuture: { nested: true },
		})
		expect(decoded.name).toBe("Test")
		expect("somethingFromTheFuture" in encodeDocument(decoded)).toBe(false)
	})

	// The invariants are repaired by `sanitizeDashboardSections` on write, never
	// by schema checks — an orphaned widget must not fail the whole read.
	it("decodes a widget pointing at a section that does not exist", () => {
		const decoded = decodeDocument({
			...baseDocument,
			widgets: [widget("w1", { sectionId: "gone", tabId: "t1" })],
			sections: [{ id: "s1", title: "Overview", tabs: [{ id: "t1", title: "T" }] }],
		})
		expect(decoded.widgets[0]?.sectionId).toBe("gone")
	})

	it("rejects a section with no tabs", () => {
		expect(() =>
			decodeDocument({ ...baseDocument, sections: [{ id: "s1", title: "S", tabs: [] }] }),
		).toThrow()
	})
})
