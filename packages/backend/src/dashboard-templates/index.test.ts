import { describe, expect, it } from "@effect/vitest"
import { DashboardTemplatePreviewKind, type PortableDashboardDocument } from "@maple/domain/http"
import { DASHBOARD_TEMPLATES, buildTemplatePreview, listTemplateMetadata } from "./index"
import type { WidgetDef } from "./types"

const PREVIEW_KINDS = new Set<string>(DashboardTemplatePreviewKind.literals)

/** The root canvas plus each section's first tab: what a viewer sees on opening. */
const firstTabWidgets = ({ widgets, sections = [] }: PortableDashboardDocument) =>
	widgets.filter(
		(w) =>
			w.sectionId === undefined ||
			w.tabId === sections.find((section) => section.id === w.sectionId)?.tabs[0]?.id,
	)

function expectGaplessRows(templateId: string, widgets: ReadonlyArray<WidgetDef>) {
	const rows = new Map<number, Array<WidgetDef>>()
	for (const widget of widgets) {
		rows.set(widget.layout.y, [...(rows.get(widget.layout.y) ?? []), widget])
	}

	let expectedY = 0
	for (const [y, row] of [...rows].sort(([a], [b]) => a - b)) {
		expect(y, `${templateId}: row starts at ${y}, expected ${expectedY}`).toBe(expectedY)

		const heights = new Set(row.map((w) => w.layout.h))
		expect(heights.size, `${templateId}: row y=${y} mixes heights`).toBe(1)

		const width = row.reduce((sum, w) => sum + w.layout.w, 0)
		expect(width, `${templateId}: row y=${y} spans ${width} of 12 columns`).toBe(12)

		const spans = [...row].sort((a, b) => a.layout.x - b.layout.x)
		spans.reduce((edge, w) => {
			expect(w.layout.x, `${templateId}: row y=${y} overlaps at x=${w.layout.x}`).toBe(edge)
			return edge + w.layout.w
		}, 0)

		expectedY += row[0].layout.h
	}
}

describe("dashboard template previews", () => {
	it("derives one preview widget per widget on the first tab, for every template", () => {
		for (const template of DASHBOARD_TEMPLATES) {
			const preview = buildTemplatePreview(template)
			const built = template.build({})
			expect(preview.length, template.id).toBe(firstTabWidgets(built).length)
			for (const widget of preview) {
				expect(PREVIEW_KINDS.has(widget.kind), `${template.id}: ${widget.kind}`).toBe(true)
				expect(widget.w, template.id).toBeGreaterThan(0)
				expect(widget.h, template.id).toBeGreaterThan(0)
				expect(widget.x, template.id).toBeGreaterThanOrEqual(0)
				expect(widget.y, template.id).toBeGreaterThanOrEqual(0)
			}
		}
	})

	// Template `y` coordinates are hand-authored and have to be recomputed by hand
	// whenever a widget's height changes. The grid's vertical compactor papers over
	// a mistake on the canvas, but the preview SVG does not — it would render
	// tiles stacked on top of each other.
	it("lays every template out as gapless, non-overlapping full-width rows", () => {
		for (const template of DASHBOARD_TEMPLATES) {
			// `layout.y` is relative to the widget's container: the root canvas or one tab.
			const containers = new Map<string, Array<WidgetDef>>()
			for (const widget of template.build({}).widgets) {
				const key = `${widget.sectionId ?? ""}/${widget.tabId ?? ""}`
				containers.set(key, [...(containers.get(key) ?? []), widget])
			}
			for (const widgets of containers.values()) expectGaplessRows(template.id, widgets)
		}
	})

	it("stacks a tabbed template's preview below the root canvas, first tab only", () => {
		const gcp = DASHBOARD_TEMPLATES.find((t) => t.id === "gcp")!
		const built = gcp.build({})
		const preview = buildTemplatePreview(gcp)
		const firstTab = built.sections?.[0]?.tabs[0]?.id
		expect(preview.map((w) => w.title)).toEqual(
			built.widgets.filter((w) => w.tabId === firstTab).map((w) => w.display.title),
		)
	})

	it("exposes previews through listTemplateMetadata", () => {
		const metadata = listTemplateMetadata()
		expect(metadata.length).toBe(DASHBOARD_TEMPLATES.length)
		for (const meta of metadata) {
			const template = DASHBOARD_TEMPLATES.find((t) => t.id === meta.id)
			expect(template).toBeDefined()
			expect(meta.preview.length, meta.id).toBe(firstTabWidgets(template!.build({})).length)
		}
	})

	it("maps chart display ids to line/area/bar kinds", () => {
		const postgres = DASHBOARD_TEMPLATES.find((t) => t.id === "postgres-overview")!
		const kinds = buildTemplatePreview(postgres).map((w) => w.kind)
		expect(kinds).toContain("line")
		expect(kinds).toContain("area")
	})

	// `seriesStats` is opt-in, so an omitted flag silently means "no Min/Max/Mean/
	// Last table". Templates state it outright instead, both to keep exported
	// dashboards self-describing and to force a new template author to make the
	// call: on for line charts (levels — the answer is a number), off for area/bar
	// (stacked rates and breakdowns read for shape).
	it("states seriesStats explicitly on every chart widget, per chart kind", () => {
		const EXPECTED: Record<string, boolean> = {
			"query-builder-line": true,
			"query-builder-area": false,
			"query-builder-bar": false,
		} satisfies Record<string, boolean>

		let checked = 0
		for (const template of DASHBOARD_TEMPLATES) {
			for (const widget of template.build({}).widgets) {
				if (widget.visualization !== "chart") continue
				const chartId = widget.display.chartId
				const expected = chartId ? EXPECTED[chartId] : undefined
				if (expected === undefined) continue // pie/histogram/heatmap ignore the flag

				expect(
					widget.display.chartPresentation?.seriesStats,
					`${template.id}/${widget.id} (${chartId}) must state seriesStats`,
				).toBe(expected)
				checked += 1
			}
		}
		expect(checked, "expected chart widgets to check").toBeGreaterThan(0)
	})

	// Templates chart whole fleets, so one series with an isolated spike would
	// trip the sparse-data heuristic and stipple every dense series in the same
	// chart with permanent point markers. Line/area state the preference so the
	// heuristic never gets the casting vote.
	it("turns point markers off on every line and area widget", () => {
		let checked = 0
		for (const template of DASHBOARD_TEMPLATES) {
			for (const widget of template.build({}).widgets) {
				const chartId = widget.display.chartId
				if (chartId !== "query-builder-line" && chartId !== "query-builder-area") continue

				expect(
					widget.display.chartPresentation?.showPoints,
					`${template.id}/${widget.id} (${chartId}) must state showPoints`,
				).toBe(false)
				checked += 1
			}
		}
		expect(checked, "expected line/area widgets to check").toBeGreaterThan(0)
	})
})

describe("dashboard template requirements", () => {
	// The picker states the requirement twice: a short `missing` beside the
	// template name and the `collector` in the detail panel. Both are authored
	// here rather than recovered from prose by the client, so both have to hold
	// for every template or a row renders a blank status lane.
	it("states a requirement on every template but blank", () => {
		for (const template of DASHBOARD_TEMPLATES) {
			if (template.id === "blank") {
				expect(template.requirement, "blank needs nothing").toBeUndefined()
				continue
			}
			expect(template.requirement, template.id).toBeDefined()
			expect(template.requirement!.label.length, template.id).toBeGreaterThan(0)
			expect(template.requirement!.collector.length, template.id).toBeGreaterThan(0)
		}
	})

	it("pairs each requirement kind with the gate it actually checks", () => {
		for (const template of DASHBOARD_TEMPLATES) {
			const requirement = template.requirement
			if (!requirement) continue
			const prefixes = template.requiredMetricPrefixes ?? []

			if (requirement.kind === "telemetry") {
				// Never gated, so it needs no short label and no call to action.
				expect(prefixes, `${template.id} is telemetry but declares prefixes`).toEqual([])
				continue
			}

			// Gated kinds must be reachable: something to check, a short status for
			// the row, and a noun for the "Set up …" button.
			expect(
				prefixes.length,
				`${template.id} is ${requirement.kind} but has no prefixes`,
			).toBeGreaterThan(0)
			expect(requirement.setupLabel, `${template.id} needs a setupLabel`).toBeDefined()

			// The gate is metric recency, never the connection itself, so an
			// integration template must not claim "not connected": it reads that way
			// for a connected integration that has been quiet for a day.
			if (requirement.kind === "integration") {
				expect(prefixes, `${template.id} needs a real prefix to derive its status`).not.toContain("")
				expect(requirement.missing, `${template.id} must derive its status`).toBeUndefined()
			}
			// `metrics` may omit `missing`; the picker derives `no <prefix>*`. It may
			// not omit it when the prefix is the "any metric" sentinel, which would
			// derive the meaningless "no *".
			if (requirement.kind === "metrics" && prefixes.includes("")) {
				expect(
					requirement.missing,
					`${template.id} uses the "" prefix and must state missing`,
				).toBeDefined()
			}
		}
	})

	it("derives the public requirements array from the structured requirement", () => {
		for (const meta of listTemplateMetadata()) {
			const template = DASHBOARD_TEMPLATES.find((t) => t.id === meta.id)!
			expect(meta.requirement, meta.id).toEqual(template.requirement ?? null)
			expect(meta.requirements, meta.id).toEqual(
				template.requirement ? [template.requirement.label] : [],
			)
		}
	})
})
