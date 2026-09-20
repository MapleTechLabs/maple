/**
 * The chart image an alert notification links to, as a takumi node tree.
 *
 * Pure: no wasm, no I/O. `alert-chart.ts` rasterises whatever this returns,
 * which keeps the layout decisions testable as a plain object. The pieces it is
 * built from — the palette, the rows, the SVG-to-`src` encoding, and why no
 * type may go inside the plot — are in `chart-card.ts`.
 *
 * **It is read small.** A chat client renders an image block at roughly half
 * this width, and on a phone less. That rules out an axis: four tick labels
 * become four smudges. What survives is the shape of the line, the threshold
 * rule, and four pieces of type — what it is, what it is now, what the limit
 * is, and when.
 */
import { container, image, type Node } from "@takumi-rs/helpers"
import {
	PLOT_HEIGHT,
	PLOT_WIDTH,
	renderPlotSvg,
	type StaticChartSpec,
} from "@maple/widgets/chart/static-chart"
import { CARD_PADDING, CHART_CARD_WIDTH, COLOR, label, spread, svgDataUri } from "./chart-card"

export const ALERT_CARD_WIDTH = CHART_CARD_WIDTH
/** Plot, plus one header row and one footer row with their gaps. */
export const ALERT_CARD_HEIGHT = PLOT_HEIGHT + CARD_PADDING * 2 + 56

/**
 * The card for one alert chart.
 *
 * Throws only where {@link renderPlotSvg} does — on an empty series, which the
 * caller has already excluded by the time it gets here.
 */
export const alertChartCardNode = (spec: StaticChartSpec): Node => {
	const plot = renderPlotSvg(spec)

	return container({
		style: {
			display: "flex",
			width: ALERT_CARD_WIDTH,
			height: ALERT_CARD_HEIGHT,
			backgroundColor: COLOR.ground,
			flexDirection: "column",
			padding: CARD_PADDING,
			gap: 10,
		},
		children: [
			// What it is, and what it is now — the two things a reader glancing at a
			// re-notification is actually checking.
			spread([label(plot.title, 17, COLOR.ink, 600), label(plot.latest, 17, COLOR.ink, 600)]),
			image({ src: svgDataUri(plot.svg), width: PLOT_WIDTH, height: PLOT_HEIGHT }),
			spread([
				label(plot.start, 12, COLOR.muted),
				// Dashes stand in for the rule's own dash pattern, since a legend
				// swatch would cost a nested flex row for two pixels of ink.
				label(
					plot.threshold === null ? "" : `- - threshold ${plot.threshold.text}`,
					12,
					COLOR.danger,
				),
				label(plot.end, 12, COLOR.muted),
			]),
		],
	})
}
