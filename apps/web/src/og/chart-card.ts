/**
 * A chart, as a takumi node tree.
 *
 * Pure: no wasm, no I/O, so the layout decisions stay testable as plain
 * objects. `chart-image.ts` rasterises whatever this returns.
 *
 * **Why the plot is an image inside the card.** takumi decodes SVG, so the plot
 * geometry comes straight from `@maple/widgets`' renderer — but the usvg font
 * database behind that decoder is not the one `registerFont` fills, so every
 * glyph inside an SVG renders as nothing. All type is therefore composed as
 * takumi nodes, around the plot rather than inside it. This is not a stylistic
 * split; an SVG with `<text>` in it silently loses the text.
 *
 * **It is read small,** which is a budget rather than a veto. A chat client
 * renders an image block at roughly half this width, so the question an axis
 * has to answer is how many labels fit. Four of the widest label the formatter
 * emits ("510.3 KiB", 9 characters of 12px Geist Mono at {@link MONO_CHAR} ≈
 * 66px) take 264px of the plot's 696px along the bottom, and four 15px rows sit
 * 85px apart up a {@link AXIS_WIDTH}px gutter. It fits with room to spare; what
 * does not is the five-plus labels a dashboard draws at full size, so
 * `renderChartSvg` thins them to four.
 *
 * Earlier this file said an axis was ruled out. It was, and a chart of a 0.031%
 * error rate then had one number on it — the header value — with nothing to
 * read it against, which is what sent this back for a second look.
 *
 * One card serves both sources. An alert chart is a chart with a single series
 * and a threshold, so it takes the single-series layout — the one value in the
 * header, where a legend of one would only repeat the title — and the threshold
 * chip below the time axis. Neither is a branch on "is this an alert", and both
 * cards carry the same axis: a threshold rule is easier to read against a
 * labelled grid, not harder.
 */
import { container, image, text, type Node } from "@takumi-rs/helpers"
import {
	formatValue,
	PLOT_HEIGHT,
	PLOT_PAD,
	PLOT_WIDTH,
	renderChartSvg,
	unitColor,
	type ChartSpec,
	type ChartUnit,
	type LegendEntry,
	type PlotLabel,
	type TimeLabel,
} from "@maple/widgets/chart/static-chart"

/** Registered by `render.ts`; the chart cards are monospace throughout. */
const MONO_FONT = "Geist Mono"

const CARD_PADDING = 16
/**
 * The y axis' gutter, and the gap between it and the plot.
 *
 * Nine characters at {@link MONO_CHAR}, which is the widest label
 * {@link formatValue} emits — nice ticks in bytes reach "510.3 KiB" and
 * nothing goes past it.
 */
const AXIS_WIDTH = 66
const AXIS_GAP = 8
export const CHART_CARD_WIDTH = AXIS_WIDTH + AXIS_GAP + PLOT_WIDTH + CARD_PADDING * 2
const ROW_WIDTH = CHART_CARD_WIDTH - CARD_PADDING * 2

const GAP = 10
/** Type rows, at takumi's ~1.25 line height. */
const TITLE_ROW = 21
const SMALL_ROW = 15

const COLOR = {
	/** A step below `--card`, so the plot's own surface reads as an object on it. */
	ground: "#17140f",
	ink: "#e8e0d6",
	muted: "#8a7f72",
	/** `--destructive`, matching the threshold rule the plot draws. */
	danger: "#ef2e43",
} as const

/** A rendered card and the box to raster it in. */
export interface ChartCard {
	readonly node: Node
	readonly width: number
	readonly height: number
}

// ── primitives ──────────────────────────────────────────────────────────────

/**
 * Bytes to base64, in chunks.
 *
 * `String.fromCharCode(...bytes)` on a 20 KB SVG spreads twenty thousand
 * arguments onto the stack, which is a RangeError waiting for a busy chart.
 */
const toBase64 = (bytes: Uint8Array): string => {
	const CHUNK = 0x8000
	let binary = ""
	for (let i = 0; i < bytes.length; i += CHUNK) {
		binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
	}
	return btoa(binary)
}

/**
 * An SVG string as a `src` takumi can decode without a network fetch.
 *
 * Inlined rather than referenced: the renderer resolves external images through
 * a loader, and a chart that needs a fetch to draw itself would be a second way
 * for the endpoint behind it to fail.
 *
 * `btoa` is Latin-1 only and a title can be any UTF-8, so the SVG is encoded to
 * bytes first. (The old `btoa(unescape(encodeURIComponent(…)))` trick does the
 * same thing via a function deprecated for two decades.)
 */
const svgDataUri = (svg: string): string =>
	`data:image/svg+xml;base64,${toBase64(new TextEncoder().encode(svg))}`

/**
 * A row whose children sit at the two ends.
 *
 * `display: "flex"` is not decoration — takumi ignores `justifyContent`,
 * `gap` and `alignItems` entirely without it, and lays the children out
 * stacked at the origin instead. Explicit `width` for the same reason:
 * `space-between` has nothing to distribute across an auto-width box.
 */
const spread = (children: ReadonlyArray<Node>): Node =>
	container({
		style: {
			display: "flex",
			width: ROW_WIDTH,
			flexDirection: "row",
			justifyContent: "space-between",
			alignItems: "center",
		},
		children: [...children],
	})

const label = (value: string, size: number, color: string, weight?: number): Node =>
	text(value, {
		fontFamily: MONO_FONT,
		fontSize: size,
		color,
		...(weight === undefined ? undefined : { fontWeight: weight }),
		lineClamp: 1,
	})

// ── legend ──────────────────────────────────────────────────────────────────

const LEGEND_COLUMN_GAP = 16
const LEGEND_ROW_GAP = 4
/** The chip and the gap after it, which every entry pays before its text. */
const LEGEND_CHIP = 16
/**
 * One character of Geist Mono at the small type's 12px, rounded up.
 *
 * takumi lays the text out; this only has to predict how wide it will come out
 * — how many rows the legend wraps onto, and where an axis label's centre
 * falls. Erring wide costs an unused row of card rather than a clipped one.
 */
const MONO_CHAR = 7.3
/**
 * The longest entry drawn. Past this a service name is not being read anyway,
 * and an uncapped one could push the legend to any number of rows.
 */
const LEGEND_MAX_CHARS = 44

interface LegendChip {
	readonly color: string
	readonly text: string
}

const legendChip = (entry: LegendEntry): LegendChip => {
	const full = `${entry.name} ${entry.latest}`
	return {
		color: entry.color,
		text: full.length <= LEGEND_MAX_CHARS ? full : `${full.slice(0, LEGEND_MAX_CHARS - 1)}…`,
	}
}

/** How many rows the legend wraps onto, so the card can be tall enough for it. */
export const legendRows = (entries: ReadonlyArray<LegendChip>): number => {
	let rows = 1
	let used = 0
	for (const entry of entries) {
		const width = LEGEND_CHIP + entry.text.length * MONO_CHAR
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

// ── axes ────────────────────────────────────────────────────────────────────

/** Where a plot fraction lands inside the rasterised image, in card pixels. */
const plotY = (fraction: number): number => PLOT_PAD + fraction * (PLOT_HEIGHT - PLOT_PAD * 2)
const plotX = (fraction: number): number => PLOT_PAD + fraction * (PLOT_WIDTH - PLOT_PAD * 2)

/**
 * The value scale, in a gutter beside the plot.
 *
 * Absolutely positioned rather than distributed, because the fractions come
 * from the scales the marks were drawn with: a label sits on its grid line
 * because it was told where the line is, not because the ticks happened to be
 * evenly spaced.
 */
const yAxisGutter = (labels: ReadonlyArray<PlotLabel>): Node =>
	container({
		style: { display: "flex", position: "relative", width: AXIS_WIDTH, height: PLOT_HEIGHT },
		children: labels.map((tick) =>
			container({
				style: {
					display: "flex",
					position: "absolute",
					left: 0,
					top: plotY(tick.yFraction) - SMALL_ROW / 2,
					width: AXIS_WIDTH,
					flexDirection: "row",
					justifyContent: "flex-end",
				},
				children: [label(tick.text, 12, COLOR.muted)],
			}),
		),
	})

/**
 * The time scale, under the plot.
 *
 * Each label is centred on its tick and then pulled back inside the plot's
 * edges, so the ends read as the ends of the range rather than hanging off the
 * card. The width is predicted from {@link MONO_CHAR}; being a pixel out moves
 * a label a pixel, which is why an estimate is enough here and would not be in
 * the gutter.
 */
const xAxisRow = (labels: ReadonlyArray<TimeLabel>): Node =>
	container({
		style: { display: "flex", position: "relative", width: PLOT_WIDTH, height: SMALL_ROW },
		children: labels.map((tick) => {
			const width = tick.text.length * MONO_CHAR
			const centred = plotX(tick.xFraction) - width / 2
			return container({
				style: {
					display: "flex",
					position: "absolute",
					top: 0,
					left: Math.max(0, Math.min(PLOT_WIDTH - width, centred)),
				},
				children: [label(tick.text, 12, COLOR.muted)],
			})
		}),
	})

// ── cards ───────────────────────────────────────────────────────────────────

/**
 * The card for one chart over a time axis.
 *
 * Throws only where {@link renderChartSvg} does — on a spec with no points at
 * all, which the caller has already excluded.
 */
export const chartCard = (title: string, spec: ChartSpec): ChartCard => {
	// Empty series are dropped up front so "is this a chart of one thing" has a
	// single answer. The renderer drops them too, and asking the question on
	// either side of that would let a two-series spec with one empty series take
	// the solo layout in the palette's colour.
	const series = spec.series.filter((entry) => entry.points.length > 0)

	// A chart about one measured quantity takes that unit's semantic colour —
	// latency amber, error-rate red — rather than "the first slot in the
	// palette", which only means anything next to a second slot. The same rule
	// decides the header below, and it is what makes an alert's chart look like
	// an alert's chart without anything here knowing what an alert is.
	const plot = renderChartSvg({
		...spec,
		series,
		...(series.length === 1 ? { color: spec.color ?? unitColor(spec.unit) } : undefined),
	})

	// One series needs no legend: its colour distinguishes it from nothing, and
	// its name is the title. Its value goes where the legend would have been
	// read from — beside the title, in the same weight.
	const solo = plot.legend.length === 1 ? plot.legend[0] : undefined
	const entries = solo === undefined ? plot.legend.map(legendChip) : []
	const rows = solo === undefined ? legendRows(entries) : 0

	// Padding, the title, the plot, the time axis, and a row each for a legend
	// and a threshold when the chart has one.
	const height =
		CARD_PADDING * 2 +
		TITLE_ROW +
		GAP +
		PLOT_HEIGHT +
		GAP +
		SMALL_ROW +
		(solo === undefined ? GAP + SMALL_ROW * rows + LEGEND_ROW_GAP * (rows - 1) : 0) +
		(plot.threshold === null ? 0 : GAP + SMALL_ROW)

	const node = container({
		style: {
			display: "flex",
			width: CHART_CARD_WIDTH,
			height,
			backgroundColor: COLOR.ground,
			flexDirection: "column",
			padding: CARD_PADDING,
			gap: GAP,
		},
		children: [
			spread([
				label(title, 17, COLOR.ink, 600),
				solo === undefined
					? // Named rather than silent: a chart that quietly drops the sixth
						// service is a chart a reader can draw a wrong conclusion from.
						label(plot.hidden === 0 ? "" : `+${plot.hidden} more`, 12, COLOR.muted)
					: // What it is, and what it is now — the two things a reader glancing
						// at a re-notification is actually checking.
						label(solo.latest, 17, COLOR.ink, 600),
			]),
			// The plot and its time axis share a column, so the axis inherits the
			// plot's left edge instead of being told about the gutter twice.
			container({
				style: { display: "flex", width: ROW_WIDTH, flexDirection: "row", gap: AXIS_GAP },
				children: [
					yAxisGutter(plot.yAxis),
					container({
						style: { display: "flex", width: PLOT_WIDTH, flexDirection: "column", gap: GAP },
						children: [
							image({ src: svgDataUri(plot.svg), width: PLOT_WIDTH, height: PLOT_HEIGHT }),
							xAxisRow(plot.xAxis),
						],
					}),
				],
			}),
			...(solo === undefined
				? [
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
					]
				: []),
			// Dashes stand in for the rule's own dash pattern, since a legend swatch
			// would cost a nested flex row for two pixels of ink. Its own row rather
			// than the time axis' middle, which the interior ticks now occupy.
			...(plot.threshold === null
				? []
				: [label(`- - threshold ${plot.threshold.text}`, 12, COLOR.danger)]),
		],
	})

	return { node, width: CHART_CARD_WIDTH, height }
}

const RANKED_BAR_ROW = 18
const RANKED_ROW_GAP = 8
/** A category name's column, leaving the rest of the row to the bar and its value. */
const NAME_WIDTH = 220
const BAR_TRACK = ROW_WIDTH - NAME_WIDTH - GAP
/** The longest a bar may draw, so the value beside it always has room. */
const BAR_MAX = BAR_TRACK - 110

export interface RankedCard {
	readonly title: string
	readonly unit: ChartUnit
	readonly points: ReadonlyArray<{ readonly name: string; readonly value: number }>
}

/**
 * The card for a ranking: one labelled bar per category, in the order it was
 * written.
 *
 * Drawn here rather than in SVG at all, unlike every other chart: its bars are
 * labelled with category names, and those are type — the one thing the plot
 * renderer cannot put on a canvas. Composing the whole thing as nodes is less
 * code than half an SVG plus a column of positioned labels.
 *
 * Sized to its content: a three-bar ranking in a twelve-bar box is mostly floor.
 */
export const rankedCard = (card: RankedCard): ChartCard => {
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
			width: CHART_CARD_WIDTH,
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

	return { node, width: CHART_CARD_WIDTH, height }
}
