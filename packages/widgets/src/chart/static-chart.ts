/**
 * Chart rendering with no DOM, no React and no chart library — for images that
 * are rasterised server-side and pasted into Slack, Discord or an email.
 *
 * Two things make this different from the interactive charts in `@maple/ui`:
 *
 *   - **It emits an SVG string, not elements.** The consumers are Workers, not
 *     browsers. `apps/web` rasterises the string with the takumi wasm it
 *     already ships for OG cards.
 *   - **It draws no text.** takumi decodes SVG through usvg, whose font
 *     database is separate from the one `Renderer.registerFont` populates, so
 *     every glyph inside an SVG image node renders as nothing — registering a
 *     font changes the output not at all (verified: byte-identical PNGs).
 *     Type has to be composed as takumi nodes *around* this SVG, so
 *     {@link renderChartSvg} returns the strings to draw and where, and draws
 *     none of them itself.
 *
 * Fixed to the Maple dark theme: a PNG has no theme, and the product default
 * is dark. Colors are the `.dark` values from `styles/tokens.css`, converted
 * oklch → hex because usvg has no oklch parser.
 *
 * It lives in `@maple/widgets` rather than `@maple/ui` because both consumers
 * are Workers: `apps/api` needs {@link sparkline} for message text and
 * `apps/web` needs {@link renderChartSvg} for the image. `@maple/ui` peer-depends
 * on react, react-dom and tailwind, and no Worker in this repo imports it.
 *
 * A near-identical renderer lives at `apps/slack-agent/agent/lib/chart.ts`.
 * That app is deliberately outside the workspace (`"!apps/slack-agent"` in the
 * root `workspaces`) and so cannot import this; it also rasterises with
 * `@resvg/resvg-js`, which *does* carry fonts, so it keeps drawing its own
 * text and does not want this module's split. Treat the two as siblings, not
 * as a copy to keep in sync.
 */

export type ChartKind = "line" | "area" | "bar"

export type ChartUnit = "number" | "percent" | "duration_ms" | "bytes" | "requests_per_sec"

/** `[epochMillis, value]`. Rendering sorts, so order is not a precondition. */
export type ChartPoint = readonly [number, number]

/** Which side of the threshold counts as breaching, for the shaded band. */
export type BreachSide = "above" | "below" | "none"

/**
 * A string the caller must draw as its own text node, and where to put it.
 *
 * `yFraction` is a fraction of the plot height from the top, so a caller that
 * scales the SVG to a different box still lands the label on the rule.
 */
export interface PlotLabel {
	readonly text: string
	readonly yFraction: number
}

/** The same, along the time axis: a fraction of the plot width from the left. */
export interface TimeLabel {
	readonly text: string
	readonly xFraction: number
}

/** One named line/area/bar. A chart carries one or several. */
export interface NamedSeries {
	readonly name: string
	readonly points: ReadonlyArray<ChartPoint>
}

/**
 * One chart, whatever produced it.
 *
 * An alert chart is this with a single series and a threshold; a chart out of
 * an agent's reply is this with several and none. They were two renderers
 * once, which bought nothing: the threshold is the only thing a second series
 * cannot have, and it is already optional.
 */
export interface ChartSpec {
	readonly kind: ChartKind
	readonly unit: ChartUnit
	readonly series: ReadonlyArray<NamedSeries>
	/** Drawn as a dashed rule, and kept inside the y domain so it cannot fall off. */
	readonly threshold?: number | null
	/**
	 * Shades the breaching side of the threshold. `"none"` for comparators
	 * where "beyond" is not a half-plane (`between`, `eq`, …) — the rule still
	 * draws, the band does not.
	 */
	readonly breachSide?: BreachSide
	/**
	 * One colour for the whole chart, instead of the per-series palette.
	 *
	 * What makes an alert chart look like an alert chart: it is about a single
	 * measured quantity, so it takes that unit's semantic colour rather than
	 * "the first one in the palette".
	 */
	readonly color?: string
}

/** A series as the caller has to label it — the colour is drawn, the words are not. */
export interface LegendEntry {
	readonly name: string
	readonly color: string
	/** Latest value, formatted — where the series ended, which the axis cannot say. */
	readonly latest: string
}

export interface ChartRender {
	/** Self-contained SVG, `PLOT_WIDTH`×`PLOT_HEIGHT` viewBox, no `<text>`. */
	readonly svg: string
	/** One entry per drawn series, biggest first. */
	readonly legend: ReadonlyArray<LegendEntry>
	/** Series left undrawn by {@link MAX_PLOT_SERIES}, for the caller to note. */
	readonly hidden: number
	/** Threshold rule label, `null` when the spec carries no threshold. */
	readonly threshold: PlotLabel | null
	/** Value labels on the grid lines the plot drew, largest first. */
	readonly yAxis: ReadonlyArray<PlotLabel>
	/** Time labels across the range, earliest first. The last one names the zone. */
	readonly xAxis: ReadonlyArray<TimeLabel>
}

// Maple dark-theme tokens, oklch → hex (usvg has no oklch parser). Sources are
// the `.dark` values in `packages/ui/src/styles/tokens.css`.
const COLORS = {
	/** --card oklch(0.224 0.009 75) — charts sit on cards in the product. */
	surface: "#1e1b17",
	/** --border oklch(0.268 0.012 67); the grid uses it at 50% like the web. */
	border: "#2a2520",
	/** --destructive, for the threshold rule and its breach band. */
	danger: "#ef2e43",
} as const

/**
 * Series color per unit, mirroring the web dashboards' semantic tokens:
 * latency → --chart-p95 amber, throughput → --chart-throughput purple,
 * error-rate percent → --chart-error red, bytes → --chart-4 teal,
 * plain counts → --chart-p50 blue.
 */
const SERIES_COLORS: Record<ChartUnit, string> = {
	duration_ms: "#e8872a",
	requests_per_sec: "#9281e1",
	percent: "#ef2e43",
	bytes: "#00aa9a",
	number: "#4a9eff",
} satisfies Record<ChartUnit, string>

/**
 * Colors for a chart of several series, where the unit says nothing about which
 * line is which. The `--chart-1..5` dark slots in order, which is the same
 * sequence the web plots hand out.
 */
const SERIES_PALETTE = ["#e8872a", "#4a9eff", "#49a866", "#00aa9a", "#b589d6"] as const

/**
 * Series a multi-series plot draws before it starts hiding them.
 *
 * The palette's length, and about what a 720px card can carry: six lines share
 * one 280px box and the reader is left matching colours rather than reading a
 * chart. The ones dropped are the smallest, and the caller says how many.
 */
export const MAX_PLOT_SERIES = SERIES_PALETTE.length

/**
 * The color a single-series chart draws in, for callers that lay out their own
 * marks — a ranking's bars are takumi nodes, because its labels are type this
 * module cannot draw.
 */
export const unitColor = (unit: ChartUnit): string => SERIES_COLORS[unit]

export const PLOT_WIDTH = 720
export const PLOT_HEIGHT = 280

// No PAD_LEFT for the axis: its labels are type, so they are the caller's
// nodes in the caller's gutter, and the marks keep the whole box. A small inset
// keeps them off the card's stroke.
export const PLOT_PAD = 12

// ── formatting ──────────────────────────────────────────────────────────────

const round = (n: number, digits = 1): string => {
	const abs = Math.abs(n)
	// `toFixed` rounds anything under half a place to a flat zero, which is how
	// an axis of small values became a column of "0" and a 0.031% error rate a
	// header reading "0". Below that floor, decimals are added until the first
	// significant digit shows, capped so a denormal cannot mint a 300-character
	// label.
	if (abs !== 0 && abs < 0.5 / 10 ** digits) {
		return String(Number(n.toFixed(Math.min(6, Math.ceil(-Math.log10(abs)) + 1))))
	}
	const s = n.toFixed(digits)
	return s.endsWith(".0") ? s.slice(0, -2) : s
}

/** Formats a value for labels, unit-aware. */
export function formatValue(value: number, unit: ChartUnit): string {
	switch (unit) {
		case "percent":
			// Zero takes the coarse precision so a `0%` baseline reads beside `2%`
			// and `4%` rather than as `0.00%` under them.
			return `${round(value, value !== 0 && Math.abs(value) < 1 ? 2 : 1)}%`
		case "duration_ms":
			if (Math.abs(value) >= 60_000) return `${round(value / 60_000)} min`
			if (Math.abs(value) >= 1000) return `${round(value / 1000)} s`
			return `${round(value)} ms`
		case "bytes": {
			const abs = Math.abs(value)
			if (abs >= 1024 ** 3) return `${round(value / 1024 ** 3)} GiB`
			if (abs >= 1024 ** 2) return `${round(value / 1024 ** 2)} MiB`
			if (abs >= 1024) return `${round(value / 1024)} KiB`
			return `${round(value)} B`
		}
		case "requests_per_sec":
			return `${formatValue(value, "number")}/s`
		case "number": {
			const abs = Math.abs(value)
			if (abs >= 1_000_000) return `${round(value / 1_000_000)}M`
			if (abs >= 1000) return `${round(value / 1000)}k`
			return round(value, abs < 10 && !Number.isInteger(value) ? 1 : 0)
		}
	}
}

const pad2 = (n: number): string => String(n).padStart(2, "0")

export function formatTimestamp(ms: number, rangeMs: number): string {
	const d = new Date(ms)
	const hhmm = `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`
	if (rangeMs <= 36 * 3_600_000) return hhmm
	return `${d.getUTCMonth() + 1}/${d.getUTCDate()} ${hhmm}`
}

// ── scales ──────────────────────────────────────────────────────────────────

/** "Nice" tick values covering [0|min, max] — the grid, and the y domain. */
export function niceTicks(min: number, max: number, count = 4): number[] {
	const lo = Math.min(0, min)
	const hi = max <= lo ? lo + 1 : max
	const rawStep = (hi - lo) / count
	const mag = 10 ** Math.floor(Math.log10(rawStep))
	const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= rawStep) ?? 10 * mag
	const ticks: number[] = []
	const start = Math.floor(lo / step) * step
	const end = Math.ceil(hi / step) * step
	for (let t = start; t <= end + step * 1e-9; t += step) {
		ticks.push(Math.abs(t) < step * 1e-9 ? 0 : t)
	}
	return ticks
}

/**
 * Labels on an axis, at most this many.
 *
 * The plot is 696×256 and a chat client renders it at about half that, so
 * density is the whole question. Four labels of the widest thing the formatter
 * emits ("510.3 KiB", 9 characters of 7.3px Geist Mono ≈ 66px) occupy 264px of
 * 696px across the bottom, and four rows 15px tall sit 85px apart up the side.
 * Five would still fit and read as a texture; three or four read as a scale.
 */
const AXIS_LABELS = 4

/** The grid ticks that get a label: every one, thinned to {@link AXIS_LABELS}. */
const labelledTicks = (ticks: ReadonlyArray<number>): ReadonlyArray<number> => {
	const stride = Math.max(1, Math.ceil((ticks.length - 1) / (AXIS_LABELS - 1)))
	const kept = ticks.filter((_, index) => index % stride === 0)
	const top = ticks.at(-1)
	// The top of the domain is the one tick a reader needs most; the stride only
	// lands on it when it divides evenly.
	return top === undefined || kept.at(-1) === top ? kept : [...kept, top]
}

/**
 * Times across the range, evenly spaced.
 *
 * A short span formats several of them identically — four copies of `10:00`
 * say less than one does — so a repeat is dropped rather than drawn. The
 * surviving labels keep their true positions, so a gap in them is a gap.
 */
const timeAxis = (tMin: number, tMax: number, tRange: number): ReadonlyArray<TimeLabel> => {
	const count = tMax === tMin ? 1 : AXIS_LABELS
	const labels: Array<TimeLabel> = []
	for (let i = 0; i < count; i += 1) {
		const xFraction = count === 1 ? 0 : i / (count - 1)
		const text = formatTimestamp(tMin + xFraction * (tMax - tMin), tRange)
		if (labels.at(-1)?.text !== text) labels.push({ text, xFraction })
	}
	const last = labels.at(-1)
	// The zone is named once, on the label that ends the range.
	if (last !== undefined) labels[labels.length - 1] = { ...last, text: `${last.text} UTC` }
	return labels
}

/**
 * At most `max` points, keeping the first and last and the most extreme value
 * in each stride.
 *
 * Averaging would be the obvious downsample and is the wrong one here: the
 * whole reason to look at an alert chart is to see the excursion, and a mean
 * is exactly the operation that hides it. Which extreme to keep follows the
 * breaching side, so a spike survives on a `gt` rule and a collapse survives
 * on a `lt` one.
 */
export function downsample(
	points: ReadonlyArray<ChartPoint>,
	max: number,
	breachSide: BreachSide = "above",
): ReadonlyArray<ChartPoint> {
	if (points.length <= max || max < 3) return points
	const sorted = [...points].sort((a, b) => a[0] - b[0])
	const first = sorted[0]
	const last = sorted.at(-1)
	// `points.length <= max` returned above and `max >= 3`, so both ends exist.
	if (first === undefined || last === undefined) return points
	const inner = sorted.slice(1, -1)
	const buckets = max - 2
	const size = Math.ceil(inner.length / buckets)
	const kept: ChartPoint[] = [first]
	for (let i = 0; i < inner.length; i += size) {
		const slice = inner.slice(i, i + size)
		if (slice.length === 0) continue
		const pick = slice.reduce((best, p) =>
			breachSide === "below" ? (p[1] < best[1] ? p : best) : p[1] > best[1] ? p : best,
		)
		kept.push(pick)
	}
	kept.push(last)
	return kept
}

// ── rendering ───────────────────────────────────────────────────────────────

/** Where a value and a time land in the plot box, and the ticks the grid draws. */
interface PlotScales {
	readonly x: (t: number) => number
	readonly y: (v: number) => number
	readonly ticks: ReadonlyArray<number>
	readonly yMin: number
	readonly plotW: number
	readonly plotH: number
}

const plotScales = (domain: ReadonlyArray<number>, tMin: number, tRange: number): PlotScales => {
	const ticks = niceTicks(Math.min(...domain), Math.max(...domain))
	// `niceTicks` always returns at least a `[min, max]` pair.
	const yMin = ticks[0] ?? 0
	const yMax = ticks.at(-1) ?? yMin
	const plotW = PLOT_WIDTH - PLOT_PAD * 2
	const plotH = PLOT_HEIGHT - PLOT_PAD * 2
	return {
		x: (t) => PLOT_PAD + ((t - tMin) / tRange) * plotW,
		y: (v) => PLOT_PAD + plotH - ((v - yMin) / Math.max(1e-9, yMax - yMin)) * plotH,
		ticks,
		yMin,
		plotW,
		plotH,
	}
}

const SVG_OPEN = [
	`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${PLOT_WIDTH} ${PLOT_HEIGHT}" width="${PLOT_WIDTH}" height="${PLOT_HEIGHT}">`,
	// Card canvas: --radius 8px + hairline --border, like a dashboard widget. A
	// chat client composes PNGs on light and dark backdrops alike; the border
	// keeps the card edge legible on both.
	`<rect x="0.5" y="0.5" width="${PLOT_WIDTH - 1}" height="${PLOT_HEIGHT - 1}" rx="8" fill="${COLORS.surface}" stroke="${COLORS.border}"/>`,
] as const

/**
 * Web charts fill areas with a vertical series gradient (VerticalGradient in
 * packages/ui, 0.8 → 0.1), not a flat tint.
 */
const areaGradient = (id: string, color: string, top = 0.8, bottom = 0.1): string =>
	`<linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stop-color="${color}" stop-opacity="${top}"/><stop offset="95%" stop-color="${color}" stop-opacity="${bottom}"/></linearGradient>`

/**
 * Recessive gridlines (border at 50%, matching the web's stroke-border/50; the
 * baseline gets the full border). Their labels are the caller's nodes; this
 * draws the lines they sit on and reports them as `yAxis`.
 */
const gridLines = (scales: PlotScales): ReadonlyArray<string> =>
	scales.ticks.map((tick) => {
		const ty = scales.y(tick)
		const isBaseline = tick === scales.yMin
		return `<line x1="${PLOT_PAD}" y1="${ty}" x2="${PLOT_WIDTH - PLOT_PAD}" y2="${ty}" stroke="${COLORS.border}"${isBaseline ? "" : ' stroke-opacity="0.5"'} stroke-width="1"/>`
	})

/**
 * Where one series' bars sit: `slots` buckets across the plot, each split into
 * `bands` so several series stand side by side rather than on top of each other.
 */
interface BarPlacement {
	readonly slots: number
	readonly bands: number
	readonly band: number
}

/** A ≥2px surface gap between bars, and no overflow past the plot. */
const barMarks = (
	bars: ReadonlyArray<{ readonly slot: number; readonly value: number }>,
	color: string,
	scales: PlotScales,
	placement: BarPlacement,
): ReadonlyArray<string> => {
	const slot = scales.plotW / placement.slots
	const band = slot / placement.bands
	const barW = Math.max(1, Math.min(band - 2, 40))
	const baseline = scales.y(scales.yMin)
	return bars.map(({ slot: index, value }) => {
		const bx = PLOT_PAD + slot * index + band * (placement.band + 0.5) - barW / 2
		const by = scales.y(Math.max(value, scales.yMin))
		const bh = Math.max(1, baseline - by)
		const r = Math.min(4, barW / 2, bh)
		return `<path d="M ${bx.toFixed(1)} ${(by + bh).toFixed(1)} V ${(by + r).toFixed(1)} Q ${bx.toFixed(1)} ${by.toFixed(1)} ${(bx + r).toFixed(1)} ${by.toFixed(1)} H ${(bx + barW - r).toFixed(1)} Q ${(bx + barW).toFixed(1)} ${by.toFixed(1)} ${(bx + barW).toFixed(1)} ${(by + r).toFixed(1)} V ${(by + bh).toFixed(1)} Z" fill="${color}"/>`
	})
}

/**
 * One line, optionally filled, ending in a dot.
 *
 * The area closes on the series' own ends rather than the plot's, so a series
 * that starts late in a multi-series chart does not drag a fill back to the
 * left edge.
 */
const lineMarks = (
	points: ReadonlyArray<ChartPoint>,
	options: {
		readonly filled: boolean
		readonly color: string
		readonly fillId: string
		readonly scales: PlotScales
	},
): ReadonlyArray<string> => {
	const { color, scales } = options
	const first = points[0]
	const last = points.at(-1)
	if (first === undefined || last === undefined) return []

	const linePath = points
		.map(([t, v], i) => `${i === 0 ? "M" : "L"} ${scales.x(t).toFixed(1)} ${scales.y(v).toFixed(1)}`)
		.join(" ")
	const baseline = scales.y(scales.yMin).toFixed(1)
	return [
		...(options.filled
			? [
					`<path d="${linePath} L ${scales.x(last[0]).toFixed(1)} ${baseline} L ${scales.x(first[0]).toFixed(1)} ${baseline} Z" fill="url(#${options.fillId})"/>`,
				]
			: []),
		`<path d="${linePath}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`,
		// The latest value gets a dot with a 2px surface ring; its *number* is a
		// label the caller draws, because this SVG cannot.
		`<circle cx="${scales.x(last[0]).toFixed(1)}" cy="${scales.y(last[1]).toFixed(1)}" r="4" fill="${color}" stroke="${COLORS.surface}" stroke-width="2"/>`,
	]
}

const byTime = (a: ChartPoint, b: ChartPoint): number => a[0] - b[0]

/**
 * A chart as an SVG string, plus the type the caller has to draw.
 *
 * One function for both kinds of chart this repo draws. An alert's is a single
 * series with a threshold; an agent's is several with none — and the threshold
 * was already optional, so keeping them apart bought a second copy of the
 * scales, the grid and the marks in exchange for nothing.
 *
 * Series compete for the {@link MAX_PLOT_SERIES} slots on peak magnitude, so
 * what a reader loses on a crowded chart is the flattest lines on it. A chart
 * with one series loses nothing.
 *
 * Throws on a spec with nothing in it: a chart with no points is a bug at the
 * call site, and silently returning an empty card would ship it to a reader.
 */
export function renderChartSvg(spec: ChartSpec): ChartRender {
	const threshold = spec.threshold ?? null
	const breachSide = spec.breachSide ?? "none"

	const ranked = spec.series
		.flatMap((series) => {
			const points = [...series.points].sort(byTime)
			const last = points.at(-1)
			if (last === undefined) return []
			return [
				{
					name: series.name,
					points,
					latest: last[1],
					peak: points.reduce((max, [, v]) => Math.max(max, Math.abs(v)), 0),
				},
			]
		})
		.sort((a, b) => b.peak - a.peak)

	const drawn = ranked.slice(0, MAX_PLOT_SERIES).map((series, index) => ({
		...series,
		color: spec.color ?? SERIES_PALETTE[index] ?? SERIES_PALETTE[0],
	}))
	if (drawn.length === 0) throw new Error("renderChartSvg needs at least one data point.")

	const times = drawn.flatMap((series) => series.points.map((point) => point[0]))
	const tMin = Math.min(...times)
	const tMax = Math.max(...times)
	const tRange = Math.max(1, tMax - tMin)
	// The threshold joins the domain so its rule is always on the canvas — a
	// chart whose breach line sits off the top edge is worse than no chart.
	const values = drawn.flatMap((series) => series.points.map((point) => point[1]))
	const scales = plotScales(threshold === null ? values : [...values, threshold], tMin, tRange)

	// Bars stand side by side inside one bucket, so every series has to agree on
	// what the buckets are — the union of the times drawn, left to right.
	const buckets = [...new Set(times)].sort((a, b) => a - b)
	const slotOf = new Map(buckets.map((time, index) => [time, index]))

	const parts: string[] = [...SVG_OPEN]
	if (spec.kind === "area") {
		// Faint where several areas overlap: one series at the web's 0.8 top stop
		// paints over every series drawn under it.
		const [top, bottom] = drawn.length === 1 ? [0.8, 0.1] : [0.3, 0.04]
		parts.push(
			`<defs>${drawn.map((series, i) => areaGradient(`areaFill${i}`, series.color, top, bottom)).join("")}</defs>`,
		)
	}
	parts.push(...gridLines(scales))

	// Breach band under the threshold rule, so the eye finds the excursion
	// before it reads a single number.
	if (threshold !== null && breachSide !== "none") {
		const ty = scales.y(threshold)
		const bandTop = breachSide === "above" ? PLOT_PAD : ty
		const bandHeight =
			breachSide === "above" ? Math.max(0, ty - PLOT_PAD) : Math.max(0, PLOT_PAD + scales.plotH - ty)
		if (bandHeight > 0) {
			parts.push(
				`<rect x="${PLOT_PAD}" y="${bandTop.toFixed(1)}" width="${scales.plotW}" height="${bandHeight.toFixed(1)}" fill="${COLORS.danger}" fill-opacity="0.06"/>`,
			)
		}
	}

	for (const [index, series] of drawn.entries()) {
		parts.push(
			...(spec.kind === "bar"
				? barMarks(
						series.points.map(([time, value]) => ({ slot: slotOf.get(time) ?? 0, value })),
						series.color,
						scales,
						{ slots: buckets.length, bands: drawn.length, band: index },
					)
				: lineMarks(series.points, {
						filled: spec.kind === "area",
						color: series.color,
						fillId: `areaFill${index}`,
						scales,
					})),
		)
	}

	// Threshold rule last, so it reads above the marks.
	if (threshold !== null) {
		const ty = scales.y(threshold)
		parts.push(
			`<line x1="${PLOT_PAD}" y1="${ty.toFixed(1)}" x2="${PLOT_WIDTH - PLOT_PAD}" y2="${ty.toFixed(1)}" stroke="${COLORS.danger}" stroke-width="1.5" stroke-dasharray="6 4"/>`,
		)
	}

	parts.push("</svg>")

	return {
		svg: parts.join("\n"),
		legend: drawn.map((series) => ({
			name: series.name,
			color: series.color,
			latest: formatValue(series.latest, spec.unit),
		})),
		hidden: ranked.length - drawn.length,
		threshold:
			threshold === null
				? null
				: {
						text: formatValue(threshold, spec.unit),
						yFraction: (scales.y(threshold) - PLOT_PAD) / scales.plotH,
					},
		// Read off the scales the marks were drawn with rather than recomputed,
		// so a label cannot land anywhere but on the line it names.
		yAxis: labelledTicks(scales.ticks)
			.map((tick) => ({
				text: formatValue(tick, spec.unit),
				yFraction: (scales.y(tick) - PLOT_PAD) / scales.plotH,
			}))
			.reverse(),
		xAxis: timeAxis(tMin, tMax, tRange),
	}
}

// ── text-only fallback ──────────────────────────────────────────────────────

const SPARK_LEVELS = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"] as const

/**
 * Unicode sparkline, for the places an image cannot go: a phone's lock screen,
 * a push preview, and every degrade path where rendering or the series read
 * failed. Downsamples to at most `maxBuckets` by averaging — unlike
 * {@link downsample}, this one is smoothing 24 glyphs, not a plot.
 */
export function sparkline(values: readonly number[], maxBuckets = 24): string {
	if (values.length === 0) return ""
	const buckets: number[] = []
	const size = Math.ceil(values.length / maxBuckets)
	for (let i = 0; i < values.length; i += size) {
		const slice = values.slice(i, i + size)
		buckets.push(slice.reduce((a, b) => a + b, 0) / slice.length)
	}
	const min = Math.min(...buckets)
	const max = Math.max(...buckets)
	const range = max - min
	return buckets
		.map((v) => {
			const idx =
				range === 0
					? 3
					: Math.min(SPARK_LEVELS.length - 1, Math.floor(((v - min) / range) * SPARK_LEVELS.length))
			return SPARK_LEVELS[idx]
		})
		.join("")
}
