import { ruleY, text, type ChartValue } from "@tanstack/charts"
import { decorative } from "@tanstack/charts/mark/decorative"
import type { TimeseriesAxisSpec } from "../chart-spec"

// `thresholdRules` (packages/ui/src/components/plot/threshold-rules.ts): one dashed `ruleY` for every
// threshold and, anchored at `labelX`, their labels. Colours arrive resolved (`axisSpecOf`).

type Threshold = TimeseriesAxisSpec["thresholds"][number]

const THRESHOLD_STROKE_WIDTH = 1.5
const THRESHOLD_LABEL_FONT_SIZE = 10
const THRESHOLD_LABEL_DX = -4
const THRESHOLD_LABEL_DY = -6

export const thresholdMarks = (thresholds: ReadonlyArray<Threshold>, labelX: ChartValue | undefined) => {
	const valid = thresholds.filter((threshold) => Number.isFinite(threshold.value))
	if (valid.length === 0) return []
	const rules = ruleY(valid, {
		y: (threshold: Threshold) => threshold.value,
		stroke: (threshold: Threshold) => threshold.color,
		strokeOpacity: 1,
		strokeWidth: THRESHOLD_STROKE_WIDTH,
		strokeDasharray: "4 4",
	})
	const labelled =
		labelX === undefined ? [] : valid.filter((threshold) => threshold.label !== null && threshold.label !== "")
	if (labelX === undefined || labelled.length === 0) return [rules]
	return [
		rules,
		decorative(
			text(labelled, {
				x: () => labelX,
				y: (threshold: Threshold) => threshold.value,
				text: (threshold: Threshold) => threshold.label ?? "",
				fill: (threshold: Threshold) => threshold.color,
				anchor: "end",
				dx: THRESHOLD_LABEL_DX,
				dy: THRESHOLD_LABEL_DY,
				fontSize: THRESHOLD_LABEL_FONT_SIZE,
			}),
		),
	]
}
