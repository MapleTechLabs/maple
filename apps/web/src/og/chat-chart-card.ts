/**
 * The chart an agent drew inside a reply, as a takumi node tree.
 *
 * Pure: no wasm, no I/O. `chat-chart.ts` rasterises whatever this returns. The
 * palette, the rows and the SVG-to-`src` encoding are in `chart-card.ts`, along
 * with the reason no type may go inside the plot.
 *
 * Two cards, because the two chart kinds are not the same drawing:
 *
 *   - A **timeseries** is a plot with a legend. The alert card can name its one
 *     series in the header; this one carries several, so the legend is where a
 *     reader learns which colour is which — and it prints each series' latest
 *     value, which is the magnitude a card with no y axis otherwise loses.
 *   - A **ranking** is drawn here rather than in SVG at all. Its bars are
 *     labelled with category names, and those are type — the one thing the plot
 *     renderer cannot put on a canvas. Composing the whole thing as nodes is
 *     less code than half an SVG plus a column of positioned labels.
 *
 * Both return their own height: a three-bar ranking in a twelve-bar box is
 * mostly floor, and a legend that wrapped onto a third row needs the card to
 * have grown with it or the footer renders past the bottom edge.
 */
import { container, image, text, type Node } from "@takumi-rs/helpers"
import {
	formatValue,
	PLOT_HEIGHT,
	PLOT_WIDTH,
	renderSeriesPlotSvg,
	unitColor,
	type ChartUnit,
	type LegendEntry,
	type SeriesChartSpec,
} from "@maple/widgets/chart/static-chart"
import {
	CARD_PADDING,
	CHART_CARD_WIDTH,
	COLOR,
	label,
	MONO_FONT,
	ROW_WIDTH,
	spread,
	svgDataUri,
} from "./chart-card"

export const CHAT_CARD_WIDTH = CHART_CARD_WIDTH

const GAP = 10
/** Type rows, at takumi's ~1.25 line height. */
const TITLE_ROW = 21
const SMALL_ROW = 15

/** A rendered card and the box to raster it in. */
export interface ChartCard {
	readonly node: Node
	readonly width: number
	readonly height: number
}

export interface ChatTimeseriesCard {
	readonly kind: "line" | "area" | "bar"
	readonly title: string
	readonly unit: ChartUnit
	readonly series: SeriesChartSpec["series"]
}

export interface ChatRankedCard {
	readonly title: string
	readonly unit: ChartUnit
	readonly points: ReadonlyArray<{ readonly name: string; readonly value: number }>
}

// ── legend ──────────────────────────────────────────────────────────────────

const LEGEND_COLUMN_GAP = 16
const LEGEND_ROW_GAP = 4
/** The chip and the gap after it, which every entry pays before its text. */
const LEGEND_CHIP = 16
/**
 * One character of Geist Mono at the legend's 12px, rounded up.
 *
 * takumi lays the legend out; this only has to predict how many rows that will
 * take, and erring wide costs an unused row of card rather than a clipped one.
 */
const LEGEND_CHAR = 7.3
/**
 * The longest entry drawn. Past this a service name is not being read anyway,
 * and an uncapped one could push the legend to any number of rows.
 */
const LEGEND_MAX_CHARS = 44

const legendText = (entry: LegendEntry): string => {
	const full = `${entry.name} ${entry.latest}`
	return full.length <= LEGEND_MAX_CHARS ? full : `${full.slice(0, LEGEND_MAX_CHARS - 1)}…`
}

interface LegendChip {
	readonly color: string
	readonly text: string
}

/** How many rows the legend wraps onto, so the card can be tall enough for it. */
export const legendRows = (entries: ReadonlyArray<LegendChip>): number => {
	let rows = 1
	let used = 0
	for (const entry of entries) {
		const width = LEGEND_CHIP + entry.text.length * LEGEND_CHAR
		const extended = used === 0 ? width : used + LEGEND_COLUMN_GAP + width
		if (extended > ROW_WIDTH) {
			rows += 1
			used = width
		} else {
			used = extended
		}
	}
	return rows
}

/**
 * A legend entry: a colour chip and the series it stands for.
 *
 * The chip is a bare 10px box rather than a glyph — the fonts registered here
 * carry no dependable filled square, and a missing glyph is an invisible legend.
 */
const legendEntry = (entry: LegendChip): Node =>
	container({
		style: { display: "flex", flexDirection: "row", alignItems: "center", gap: 6 },
		children: [
			container({ style: { width: 10, height: 10, backgroundColor: entry.color, borderRadius: 2 } }),
			label(entry.text, 12, COLOR.ink),
		],
	})

// ── cards ───────────────────────────────────────────────────────────────────

/**
 * The card for a timeseries an agent drew.
 *
 * Throws only where {@link renderSeriesPlotSvg} does — on a spec with no points
 * at all, which the caller has already excluded.
 */
export const chatTimeseriesCard = (card: ChatTimeseriesCard): ChartCard => {
	const plot = renderSeriesPlotSvg({ kind: card.kind, unit: card.unit, series: card.series })
	const entries = plot.legend.map((entry) => ({ color: entry.color, text: legendText(entry) }))
	const rows = legendRows(entries)
	const height =
		PLOT_HEIGHT +
		CARD_PADDING * 2 +
		TITLE_ROW +
		SMALL_ROW * (rows + 1) +
		LEGEND_ROW_GAP * (rows - 1) +
		GAP * 3

	const node = container({
		style: {
			display: "flex",
			width: CHAT_CARD_WIDTH,
			height,
			backgroundColor: COLOR.ground,
			flexDirection: "column",
			padding: CARD_PADDING,
			gap: GAP,
		},
		children: [
			spread([
				label(card.title, 17, COLOR.ink, 600),
				// Named rather than silent: a chart that quietly drops the sixth
				// service is a chart a reader can draw a wrong conclusion from.
				label(plot.hidden === 0 ? "" : `+${plot.hidden} more`, 12, COLOR.muted),
			]),
			image({ src: svgDataUri(plot.svg), width: PLOT_WIDTH, height: PLOT_HEIGHT }),
			container({
				style: {
					display: "flex",
					width: ROW_WIDTH,
					flexDirection: "row",
					flexWrap: "wrap",
					alignItems: "center",
					columnGap: LEGEND_COLUMN_GAP,
					rowGap: LEGEND_ROW_GAP,
				},
				children: entries.map(legendEntry),
			}),
			spread([label(plot.start, 12, COLOR.muted), label(plot.end, 12, COLOR.muted)]),
		],
	})

	return { node, width: CHAT_CARD_WIDTH, height }
}

const RANKED_BAR_ROW = 18
const RANKED_ROW_GAP = 8
/** A category name's column, leaving the rest of the row to the bar and its value. */
const NAME_WIDTH = 220
const BAR_TRACK = ROW_WIDTH - NAME_WIDTH - GAP
/** The longest a bar may draw, so the value beside it always has room. */
const BAR_MAX = BAR_TRACK - 110

/** The card for a ranking: one labelled bar per category, in the order it was written. */
export const chatRankedCard = (card: ChatRankedCard): ChartCard => {
	const color = unitColor(card.unit)
	// A ranking of zeroes still draws its labels; the bars are simply hairlines.
	const largest = Math.max(...card.points.map((point) => Math.abs(point.value)), 0)
	const barWidth = (value: number): number =>
		largest === 0 ? 2 : Math.max(2, Math.round((Math.abs(value) / largest) * BAR_MAX))

	const height =
		CARD_PADDING * 2 +
		TITLE_ROW +
		GAP +
		card.points.length * RANKED_BAR_ROW +
		Math.max(0, card.points.length - 1) * RANKED_ROW_GAP

	const node = container({
		style: {
			display: "flex",
			width: CHAT_CARD_WIDTH,
			height,
			backgroundColor: COLOR.ground,
			flexDirection: "column",
			padding: CARD_PADDING,
			gap: GAP,
		},
		children: [
			label(card.title, 17, COLOR.ink, 600),
			container({
				style: { display: "flex", flexDirection: "column", gap: RANKED_ROW_GAP },
				children: card.points.map((point) =>
					container({
						style: {
							display: "flex",
							width: ROW_WIDTH,
							flexDirection: "row",
							alignItems: "center",
							gap: GAP,
						},
						children: [
							text(point.name, {
								fontFamily: MONO_FONT,
								fontSize: 13,
								color: COLOR.ink,
								width: NAME_WIDTH,
								lineClamp: 1,
							}),
							container({
								style: {
									display: "flex",
									width: BAR_TRACK,
									flexDirection: "row",
									alignItems: "center",
									gap: 8,
								},
								children: [
									container({
										style: {
											width: barWidth(point.value),
											height: 12,
											backgroundColor: color,
											borderRadius: 3,
										},
									}),
									label(formatValue(point.value, card.unit), 12, COLOR.muted),
								],
							}),
						],
					}),
				),
			}),
		],
	})

	return { node, width: CHAT_CARD_WIDTH, height }
}
