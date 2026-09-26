import { McpInvalidInputError, type McpToolRegistrar } from "./types"
import { Effect, Schema } from "effect"
import { ReorderDashboardWidgetsOutput } from "@maple/domain/mcp-outputs"
import { toDashboardRow, withDashboardMutation } from "../lib/dashboard-mutations"
import * as P from "../lib/params"
import { doc } from "../lib/tool-doc"

const TOOL = "reorder_dashboard_widgets"

// Web canvas grid is 12 columns wide. Heights are unbounded vertically but
// must be at least 1 row. Anything outside these bounds will render off the
// grid or with negative dimensions, so reject it server-side rather than
// letting a malformed layout corrupt the dashboard.
const GRID_COLS = 12

const LayoutEntrySchema = Schema.Struct({
	widget_id: Schema.String,
	x: Schema.Finite,
	y: Schema.Finite,
	w: Schema.Finite,
	h: Schema.Finite,
	minW: Schema.optionalKey(Schema.Finite),
	minH: Schema.optionalKey(Schema.Finite),
	maxW: Schema.optionalKey(Schema.Finite),
	maxH: Schema.optionalKey(Schema.Finite),
})

type LayoutEntry = typeof LayoutEntrySchema.Type

const validateLayoutGeometry = (entries: ReadonlyArray<LayoutEntry>): string[] => {
	const errors: string[] = []
	for (const entry of entries) {
		if (!Number.isInteger(entry.x) || entry.x < 0) {
			errors.push(`${entry.widget_id}: x must be an integer >= 0 (got ${entry.x})`)
		}
		if (!Number.isInteger(entry.y) || entry.y < 0) {
			errors.push(`${entry.widget_id}: y must be an integer >= 0 (got ${entry.y})`)
		}
		if (!Number.isInteger(entry.w) || entry.w < 1 || entry.w > GRID_COLS) {
			errors.push(
				`${entry.widget_id}: w must be an integer between 1 and ${GRID_COLS} (got ${entry.w})`,
			)
		}
		if (!Number.isInteger(entry.h) || entry.h < 1) {
			errors.push(`${entry.widget_id}: h must be an integer >= 1 (got ${entry.h})`)
		}
		if (
			Number.isInteger(entry.x) &&
			Number.isInteger(entry.w) &&
			entry.x >= 0 &&
			entry.w >= 1 &&
			entry.x + entry.w > GRID_COLS
		) {
			errors.push(
				`${entry.widget_id}: x+w must not exceed ${GRID_COLS} (got x=${entry.x} w=${entry.w})`,
			)
		}
	}
	return errors
}

export function registerReorderDashboardWidgetsTool(server: McpToolRegistrar) {
	server.define({
		name: TOOL,
		description:
			"Move or resize widgets on a dashboard. Only the listed widget ids change; the rest keep their layout.",
		parameters: Schema.Struct({
			dashboard_id: P.text("Dashboard ID (ids from list_dashboards)"),
			layouts_json: P.json(
				Schema.Array(LayoutEntrySchema),
				`Layout per widget, as JSON text: [{ widget_id, x, y, w, h, minW?, minH?, maxW?, maxH? }, ...]. Integers on a ${GRID_COLS}-column grid: x, y >= 0, 1 <= w <= ${GRID_COLS}, x + w <= ${GRID_COLS}, h >= 1.`,
			),
		}),
		output: ReorderDashboardWidgetsOutput,
		hints: { readOnly: false, destructive: false, idempotent: true },
		phrases: ["Reordering widgets"],
		handler: Effect.fn("McpTool.reorderDashboardWidgets")(function* ({
			dashboard_id,
			layouts_json: layouts,
		}) {
			if (layouts.length === 0) {
				return yield* new McpInvalidInputError({
					message: "layouts_json must contain at least one layout entry.",
					parameter: "layouts_json",
				})
			}

			const geometryErrors = validateLayoutGeometry(layouts)
			if (geometryErrors.length > 0) {
				return yield* new McpInvalidInputError({
					message: `Invalid layout geometry:\n- ${geometryErrors.join("\n- ")}`,
					parameter: "layouts_json",
				})
			}

			const dashboard = yield* withDashboardMutation(dashboard_id, TOOL, (existingWidgets) => {
				const layoutById = new Map(layouts.map((entry) => [entry.widget_id, entry] as const))

				const unknownIds = layouts
					.filter((entry) => !existingWidgets.some((w) => w.id === entry.widget_id))
					.map((entry) => entry.widget_id)

				if (unknownIds.length > 0) {
					return Effect.fail(
						new McpInvalidInputError({
							message: `Unknown widget ids in layouts_json: ${unknownIds.join(", ")}. Use get_dashboard to see existing widget ids.`,
							parameter: "layouts_json",
						}),
					)
				}

				return Effect.succeed(
					existingWidgets.map((widget) => {
						const update = layoutById.get(widget.id)
						if (!update) return widget
						return {
							...widget,
							layout: {
								x: update.x,
								y: update.y,
								w: update.w,
								h: update.h,
								minW: update.minW,
								minH: update.minH,
								maxW: update.maxW,
								maxH: update.maxH,
							},
						}
					}),
				)
			})

			return {
				dashboard: toDashboardRow(dashboard),
				updatedWidgetIds: layouts.map((entry) => entry.widget_id),
			}
		}),
		render: (output) => ({
			title: "Widgets Reordered",
			blocks: [
				doc.fields([
					["Dashboard", `${output.dashboard.name} (${output.dashboard.id})`],
					["Widgets updated", output.updatedWidgetIds.length],
					["Total widgets", output.dashboard.widgetCount],
					["Updated", output.dashboard.updatedAt.slice(0, 19)],
				]),
			],
		}),
	})
}
