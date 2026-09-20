/**
 * The pieces every chart card is built from.
 *
 * Pure: no wasm, no I/O, so the layout decisions stay testable as plain
 * objects. Shared by the alert card and the agent-reply card because the two
 * are the same object seen twice — a plot with type composed around it — and a
 * second copy of the base64 chunking or the takumi flex workaround is a second
 * place for them to drift.
 *
 * **Why the plot is an image inside the card.** takumi decodes SVG, so the plot
 * geometry comes straight from `@maple/widgets`' renderer — but the usvg font
 * database behind that decoder is not the one `registerFont` fills, so every
 * glyph inside an SVG renders as nothing. All type is therefore composed as
 * takumi nodes, around the plot rather than inside it. This is not a stylistic
 * split; an SVG with `<text>` in it silently loses the text.
 */
import { container, text, type Node } from "@takumi-rs/helpers"
import { PLOT_WIDTH } from "@maple/widgets/chart/static-chart"

/** Registered by `render.ts`; the chart cards are monospace throughout. */
export const MONO_FONT = "Geist Mono"

export const CARD_PADDING = 16
export const CHART_CARD_WIDTH = PLOT_WIDTH + CARD_PADDING * 2
export const ROW_WIDTH = CHART_CARD_WIDTH - CARD_PADDING * 2

export const COLOR = {
	/** A step below `--card`, so the plot's own surface reads as an object on it. */
	ground: "#17140f",
	ink: "#e8e0d6",
	muted: "#8a7f72",
	/** `--destructive`, matching the threshold rule the plot draws. */
	danger: "#ef2e43",
} as const

/**
 * Bytes to base64, in chunks.
 *
 * `String.fromCharCode(...bytes)` on a 20 KB SVG spreads twenty thousand
 * arguments onto the stack, which is a RangeError waiting for a busy chart.
 */
export const toBase64 = (bytes: Uint8Array): string => {
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
export const svgDataUri = (svg: string): string =>
	`data:image/svg+xml;base64,${toBase64(new TextEncoder().encode(svg))}`

/**
 * A row whose children sit at the two ends.
 *
 * `display: "flex"` is not decoration — takumi ignores `justifyContent`,
 * `gap` and `alignItems` entirely without it, and lays the children out
 * stacked at the origin instead. Explicit `width` for the same reason:
 * `space-between` has nothing to distribute across an auto-width box.
 */
export const spread = (children: ReadonlyArray<Node>): Node =>
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

export const label = (value: string, size: number, color: string, weight?: number): Node =>
	text(value, {
		fontFamily: MONO_FONT,
		fontSize: size,
		color,
		...(weight === undefined ? undefined : { fontWeight: weight }),
		lineClamp: 1,
	})
