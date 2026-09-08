import { useMemo } from "react"
import { motion, useReducedMotion } from "motion/react"
import { cn } from "@maple/ui/lib/utils"

/**
 * Nucleo "Pixel Essential" glyphs (24-grid, 2px square-capped strokes) for the
 * onboarding cards — the same set as `components/icons/pixel-*.tsx` and the
 * landing's `pixel-icons.ts`, kept as path data because the reveal below needs
 * each segment on its own. Keys are the Nucleo names.
 */
export const PIXEL_GLYPHS = {
	"square-activity-chart": [
		"M19 21H5",
		"M19 3H5",
		"M3 19L3 5",
		"M21 19L21 5",
		"M5 12.01L5 12",
		"M9 17.01L9 17",
		"M13 11.01L13 11",
		"M15 9.01001L15 9.00001",
		"M11 15V13",
		"M7 15V14",
		"M17 7H19",
	],
	file: [
		"M8 18H16",
		"M8 14L11 14",
		"M12 4V10H8",
		"M4 20L4 10",
		"M20 20L20 4",
		"M12 2L18 2",
		"M6 22L18 22",
		"M6 8H6.01",
		"M8 6H8.01",
		"M10 4H10.01",
	],
	"chart-bar-trend-up": [
		"M10 14V20H14V14",
		"M18 10V20H22V10",
		"M2 18V20H6V18",
		"M4.01001 16L4.00001 16",
		"M12.01 12L12 12",
		"M2.01001 8L2.00001 8",
		"M4.01001 6L4.00001 6",
		"M6.01001 4L6.00001 4",
		"M8.01001 6L8.00001 6",
		"M10.01 8L10 8",
		"M12.01 6L12 6",
		"M14.01 4L14 4",
		"M20.01 8L20 8",
	],
	"triangle-warning": [
		"M4 21H20",
		"M22 17L22 19",
		"M12 17H12.01",
		"M2 17L2 19",
		"M20 13L20 15",
		"M4 13L4 15",
		"M18 9L18 11",
		"M12 13V9",
		"M6 9L6 11",
		"M16 5L16 7",
		"M8 5L8 7",
		"M10 3H14",
	],
	film: [
		"M16.5 21V16",
		"M7.5 8V3",
		"M7.5 21V16",
		"M16.5 8V3",
		"M3 8L21 8",
		"M3 16L21 16",
		"M12 21L12 3",
		"M3 5L3 19",
		"M21 5L21 19",
		"M5 3L19 3",
		"M5 21L19 21",
	],
	"nodes-3": [
		"M11 2.00001H13",
		"M11 8.00001H13",
		"M15 4L15 6",
		"M9 4L9 6",
		"M19 14H21",
		"M3.00002 14H5.00002",
		"M19 20H21",
		"M3.00002 20H5.00002",
		"M23 16L23 18",
		"M7 16L7 18",
		"M17 16L17 18",
		"M1 16L1 18",
		"M4.01003 10L4.00003 10",
		"M20 10L20.01 10",
		"M10 21L10.01 21",
		"M14 21L14.01 21",
		"M12 22L12.01 22",
		"M5.01003 8L5.00003 8",
		"M19 8L19.01 8",
	],
	"layers-3": [
		"M12.01 22L12 22",
		"M16 20L14 20",
		"M10 20L8 20",
		"M20 18L18 18",
		"M12.01 18L12 18",
		"M6 18L4 18",
		"M22.01 16L22 16",
		"M16 16L14 16",
		"M10 16L8 16",
		"M2.01001 16L2.00001 16",
		"M20 14L18 14",
		"M12.01 14L12 14",
		"M6 14L4 14",
		"M22.01 12L22 12",
		"M16 12L14 12",
		"M10 12L8 12",
		"M2.01001 12L2.00001 12",
		"M20 10L18 10",
		"M6 10L4 10",
		"M22.01 8L22 8",
		"M2.01001 8L2.00001 8",
		"M20 6L18 6",
		"M6 6L4 6",
		"M16 4L14 4",
		"M10 4L8 4",
		"M12.01 2L12 2",
	],
	bell: [
		"M9 20H9.01",
		"M15 20H15.01",
		"M16 4H16.01",
		"M8 4H8.01",
		"M11 22H13",
		"M10 2H14",
		"M21 16L21 14",
		"M3 16L3 14",
		"M18 5.99999L18 12L19 12",
		"M6 6L6 12L5 12",
		"M5 18H19",
	],
	"brackets-curly-dots": [
		"M12 16.01V16",
		"M16 16.01V16",
		"M8 16.01V16",
		"M7 3H6",
		"M17 3H18",
		"M7 21H6",
		"M17 21H18",
		"M2 12H1",
		"M22 12H23",
		"M4 10V5",
		"M20 10V5",
		"M4 19V14",
		"M20 19V14",
	],
	laptop: [
		"M3 21L21 21",
		"M3 17L6 17",
		"M18 17L21 17",
		"M8 18L16 18",
		"M23.01 19L23 19",
		"M1.01001 19L1.00001 19",
		"M3 5L3 13",
		"M21 5L21 13",
		"M19 3L5 3",
	],
	"gear-2": [
		"M12 23L12 23.0001",
		"M20 20L20 20.0001",
		"M16 20L8 20",
		"M4 20L4 20.0001",
		"M18 18H18.01",
		"M6 18H6.01",
		"M8 16L8 16.0001",
		"M10 14L10 14.0001",
		"M20 12.0001L12 12.0001",
		"M23.0051 11.9951L23.005 11.9951",
		"M1.005 11.9951L1.0049 11.9951",
		"M10 10L10 10.0001",
		"M20 16L20 8",
		"M8 8L8 8.0001",
		"M4 16L4 8",
		"M18 6H18.01",
		"M6 6H6.01",
		"M20 4L20 4.0001",
		"M16 4L8 4",
		"M4 4L4 4.0001",
		"M12 1L12 1.0001",
	],
	"users-2": [
		"M7 4H9",
		"M7 10H9",
		"M11 6L11 8",
		"M5 6L5 8",
		"M17.5 4H18.5",
		"M17.5 9H18.5",
		"M20.5 6L20.5 7",
		"M15.5 6L15.5 7",
		"M5 14H11",
		"M16 13H20",
		"M1 18V20H15V18",
		"M19 18H22V15",
		"M3 16H3.01",
		"M13 16H13.01",
	],
	rocket: [
		"M13 5H13.01",
		"M15 7H15.01",
		"M17 9H17.01",
		"M19 11H19.01",
		"M17 13H17.01",
		"M17 20H17.01",
		"M4 7H4.01",
		"M15 15H15.01",
		"M9 9H9.01",
		"M11 15H11.01",
		"M9 13H9.01",
		"M11 7H11.01",
		"M15 3H21V9",
		"M19 15V18",
		"M9 5L6 5",
		"M13 17V22H15",
		"M7 11L2 11L2 9",
		"M5 16H6",
		"M8 19L8 18",
		"M3 18V21H6",
	],
	"pen-writing": [
		"M5 15H5.01",
		"M7 13H7.01",
		"M9 11H9.01",
		"M11 9H11.01",
		"M13 7H13.01",
		"M15 5H15.01",
		"M17 3H17.01",
		"M19 5H19.01",
		"M9 19H9.01",
		"M11 17H11.01",
		"M13 21H21",
		"M13 15H13.01",
		"M15 13H15.01",
		"M17 11H17.01",
		"M19 9H19.01",
		"M21 7H21.01",
		"M3 17V21H7",
		"M15 9H15.01",
	],
} satisfies Record<string, readonly string[]>

export type PixelGlyphName = keyof typeof PIXEL_GLYPHS

/** Seconds between one segment lighting and the next. */
const SCAN_STEP = 0.02

/** Segments in raster order — top row first, left to right — so the reveal scans. */
function rasterOrder(segments: readonly string[]): string[] {
	const origin = (d: string) => {
		const [x = 0, y = 0] = d
			.slice(1)
			.trim()
			.split(/[\s,]+/)
			.map(Number)
		return { x, y }
	}
	return [...segments].sort((a, b) => {
		const p = origin(a)
		const q = origin(b)
		return p.y - q.y || p.x - q.x
	})
}

/**
 * The glyph at its native 24px in a tinted tile — the way the app shows these
 * (alerts empty state, sidebar rows) — in muted ink, with a primary-coloured
 * copy over it that lights up segment by segment on select and drops out at
 * once on deselect: the pixel set's own idiom for "on", instead of a bounce.
 */
export function PixelGlyph({ name, selected }: { name: PixelGlyphName; selected: boolean }) {
	const reduceMotion = useReducedMotion()
	const segments = useMemo(() => rasterOrder(PIXEL_GLYPHS[name]), [name])
	return (
		<span
			className={cn(
				"flex size-10 shrink-0 items-center justify-center rounded-lg transition-colors duration-200 motion-reduce:transition-none",
				selected ? "bg-primary/10" : "bg-muted/60 group-hover:bg-muted",
			)}
		>
			<svg aria-hidden="true" focusable="false" viewBox="0 0 24 24" width={24} height={24} fill="none">
				<g
					className={cn(
						"transition-colors duration-200 motion-reduce:transition-none",
						selected ? "text-primary/40" : "text-muted-foreground group-hover:text-foreground",
					)}
				>
					{segments.map((d) => (
						<path key={d} d={d} stroke="currentColor" strokeWidth="2" strokeLinecap="square" />
					))}
				</g>
				<g className="text-primary">
					{segments.map((d, index) => (
						<motion.path
							key={d}
							d={d}
							stroke="currentColor"
							strokeWidth="2"
							strokeLinecap="square"
							initial={false}
							animate={{ opacity: selected ? 1 : 0 }}
							transition={
								reduceMotion
									? { duration: 0 }
									: { duration: 0.12, delay: selected ? index * SCAN_STEP : 0 }
							}
						/>
					))}
				</g>
			</svg>
		</span>
	)
}
