/** One placed item, in grid units. `x`/`y` are the top-left cell. */
export interface GridItem {
	readonly i: string
	readonly x: number
	readonly y: number
	readonly w: number
	readonly h: number
	readonly minW?: number
	readonly maxW?: number
	readonly minH?: number
	readonly maxH?: number
}

export type Layout = ReadonlyArray<GridItem>

/**
 * `vertical` floats every item up until it rests on another (the editable
 * canvas). `none` keeps positions as given (layouts generated for a narrower
 * width, which are already packed).
 */
export type Compaction = "vertical" | "none"

/** The pixel geometry a layout is drawn with. */
export interface GridGeometry {
	/** Container width in px. */
	readonly width: number
	readonly cols: number
	readonly rowHeight: number
	/** Gap between columns and between rows. */
	readonly gap: readonly [number, number]
	/** Padding inside the container, horizontal then vertical. */
	readonly padding: readonly [number, number]
}

export interface PixelRect {
	readonly left: number
	readonly top: number
	readonly width: number
	readonly height: number
}
