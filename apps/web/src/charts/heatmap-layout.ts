// `solveHeatmapLayout` (packages/ui/src/components/charts/heatmap/query-builder-heatmap-chart.tsx):
// the bounded y gutter, the locked margins and the band padding, in one pass. Constants as there.

const MAX_CELL_W = 72
const MAX_CELL_H = 40
const CELL_GAP_WIDE = 2
const CELL_GAP_TIGHT = 1
const TIGHT_CELL_THRESHOLD = 14
const Y_LABEL_CHAR_PX = 6.3
const Y_LABEL_INSET_PX = 10
const Y_GUTTER_MIN = 36
const Y_GUTTER_MAX = 96
const X_AXIS_BAND_PX = 20
const PLOT_TOP_PAD = 2
export const LEGEND_BLOCK_H = 34
export const FOOTNOTE_BLOCK_H = 16
const UNMEASURED_PADDING_INNER = 0.05

export interface HeatmapMargin {
	readonly top: number
	readonly right: number
	readonly bottom: number
	readonly left: number
}

export interface HeatmapLayout {
	readonly margin: HeatmapMargin | null
	readonly paddingInnerX: number
	readonly paddingInnerY: number
	readonly radius: number
	readonly gutter: number
	readonly rightInset: number
	readonly yLabelChars: number
}

export interface HeatmapLayoutInput {
	readonly containerW: number
	readonly containerH: number
	readonly columns: number
	readonly rows: number
	readonly longestYLabelChars: number
	readonly hasFootnote: boolean
}

const clamp = (value: number, lo: number, hi: number): number =>
	Number.isFinite(value) ? Math.max(lo, Math.min(hi, value)) : lo

const seamPaddingInner = (length: number, count: number, gapPx: number): number =>
	clamp((gapPx * count) / (length + gapPx), 0, 1)

const cappedGridLength = (count: number, maxCellPx: number, gapPx: number): number =>
	count * maxCellPx + Math.max(0, count - 1) * gapPx

export const solveHeatmapLayout = (input: HeatmapLayoutInput): HeatmapLayout => {
	const { containerW, containerH, columns, rows, longestYLabelChars, hasFootnote } = input
	const gutter = clamp(longestYLabelChars * Y_LABEL_CHAR_PX + Y_LABEL_INSET_PX, Y_GUTTER_MIN, Y_GUTTER_MAX)
	const yLabelChars = Math.max(1, Math.floor((gutter - Y_LABEL_INSET_PX) / Y_LABEL_CHAR_PX))
	const chartBoxH = containerH - LEGEND_BLOCK_H - (hasFootnote ? FOOTNOTE_BLOCK_H : 0)
	const availW = containerW - gutter
	const availH = chartBoxH - PLOT_TOP_PAD - X_AXIS_BAND_PX
	if (!(availW > 0) || !(availH > 0) || columns <= 0 || rows <= 0)
		return {
			margin: null,
			paddingInnerX: UNMEASURED_PADDING_INNER,
			paddingInnerY: UNMEASURED_PADDING_INNER,
			radius: 2,
			gutter,
			rightInset: 0,
			yLabelChars,
		}
	const roughW = Math.min(availW / columns, MAX_CELL_W)
	const roughH = Math.min(availH / rows, MAX_CELL_H)
	const gap =
		roughW >= TIGHT_CELL_THRESHOLD && roughH >= TIGHT_CELL_THRESHOLD ? CELL_GAP_WIDE : CELL_GAP_TIGHT
	const gridW = Math.min(availW, cappedGridLength(columns, MAX_CELL_W, gap))
	const gridH = Math.min(availH, cappedGridLength(rows, MAX_CELL_H, gap))
	const cellW = (gridW - Math.max(0, columns - 1) * gap) / columns
	const cellH = (gridH - Math.max(0, rows - 1) * gap) / rows
	return {
		margin: {
			top: PLOT_TOP_PAD,
			right: Math.max(0, containerW - gutter - gridW),
			bottom: Math.max(X_AXIS_BAND_PX, chartBoxH - PLOT_TOP_PAD - gridH),
			left: gutter,
		},
		paddingInnerX: seamPaddingInner(gridW, columns, gap),
		paddingInnerY: seamPaddingInner(gridH, rows, gap),
		radius: cellW >= 10 && cellH >= 10 ? 2 : 1,
		gutter,
		rightInset: Math.max(0, containerW - gutter - gridW),
		yLabelChars,
	}
}
