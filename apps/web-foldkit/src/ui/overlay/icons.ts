import type { Attribute, Html, HtmlBuilder } from "foldkit/html"

/**
 * The @maple/ui icons the overlay kit renders. Each is a 24px pixel-grid glyph of square-capped
 * 2px strokes; paths copied from `packages/ui/src/components/icons/<name>.tsx` (React modules).
 */
type PathSpec = string | readonly [d: string, opacity: string]

const pixelIcon =
	(paths: ReadonlyArray<PathSpec>) =>
	<Message>(
		h: HtmlBuilder<Message>,
		className?: string,
		attributes: ReadonlyArray<Attribute<Message>> = [],
	): Html =>
		h.svg(
			[
				h.Attribute("xmlns", "http://www.w3.org/2000/svg"),
				h.Attribute("viewBox", "0 0 24 24"),
				h.Attribute("width", "24"),
				h.Attribute("height", "24"),
				...(className === undefined ? [] : [h.Attribute("class", className)]),
				h.Attribute("fill", "none"),
				h.Attribute("aria-hidden", "true"),
				...attributes,
			],
			paths.map((path) =>
				h.path([
					h.Attribute("d", typeof path === "string" ? path : path[0]),
					...(typeof path === "string" ? [] : [h.Attribute("opacity", path[1])]),
					h.Attribute("stroke", "currentColor"),
					h.Attribute("stroke-width", "2"),
					h.Attribute("stroke-linecap", "square"),
				]),
			),
		)

// icons/xmark.tsx
export const xmarkIcon = pixelIcon([
	"M20.0001 20L20 20",
	"M4.00006 20L4.00006 20.0001",
	"M18.0001 18L18 18",
	"M6.00006 18L6.00006 18.0001",
	"M16.0001 16L16 16",
	"M8.00006 16L8.00006 16.0001",
	"M14.0001 14L14 14",
	"M10.0001 14L10.0001 14.0001",
	"M12.0001 12L12 12",
	"M14.0001 10L14.0001 10.0001",
	"M10.0001 10L10 10",
	"M16.0001 8L16.0001 8.0001",
	"M8.00012 8L8.00002 8",
	"M18.0001 6L18.0001 6.0001",
	"M6.00012 6L6.00002 6",
	"M20.0001 4L20.0001 4.0001",
	"M4.00012 4L4.00002 4",
])

// icons/magnifier.tsx
export const magnifierIcon = pixelIcon([
	"M15 19H7",
	"M15 3L7 3",
	"M3 15L3 7",
	"M19 15L19 7",
	"M19 19L19 19.01",
	"M21 21L21 21.01",
	"M5 17L5 17.01",
	"M17 17L17 17.01",
	"M17 5L17 5.01",
	"M5 5L5 5.01",
])

// icons/chevron-expand-y.tsx
export const chevronExpandYIcon = pixelIcon([
	"M12 2.01001L12 2.00001",
	"M12 22L12 22.01",
	"M10 4.01001L10 4.00001",
	"M10 20L10 20.01",
	"M14 4.01001L14 4.00001",
	"M14 20L14 20.01",
	"M16 6.01001L16 6.00001",
	"M16 18L16 18.01",
	"M18 8.01001L18 8.00001",
	"M18 16L18 16.01",
	"M8 6.01001L8 6.00001",
	"M8 18L8 18.01",
	"M6 8.01001L6 8.00001",
	"M6 16L6 16.01",
])

// icons/check.tsx
export const checkIcon = pixelIcon([
	"M9.99999 18H10.01",
	"M12 16H12.01",
	"M7.99999 16H8.00999",
	"M14 14H14.01",
	"M5.99999 14H6.00999",
	"M3.99999 12H4.00999",
	"M22 6H22.01",
	"M16 12H16.01",
	"M18 10H18.01",
	"M20 8H20.01",
])

const CIRCLE_RING = [
	"M8 2L16 2",
	"M8 22L16 22",
	"M2 8L2 16",
	"M22 8L22 16",
	"M6 4L6 4.01",
	"M4 6L4 6.01",
	"M18 4L18 4.01",
	"M20 6L20 6.01",
	"M6 20L6 20.01",
	"M4 18L4 18.01",
	"M18 20L18 20.01",
	"M20 18L20 18.01",
]

// icons/circle-check.tsx, icons/circle-xmark.tsx
export const circleCheckIcon = pixelIcon([...CIRCLE_RING, "M8 12L11 15L16 9"])
export const circleXmarkIcon = pixelIcon([...CIRCLE_RING, "M9 9L15 15", "M15 9L9 15"])

// icons/circle-info.tsx
export const circleInfoIcon = pixelIcon([
	"M8 22L16 22",
	"M18.01 20L18 20",
	"M6.01001 20L6.00001 20",
	"M20.01 18L20 18",
	"M4.01001 18L4.00001 18",
	"M12 16L12 12H10",
	"M22 8L22 16",
	"M12 8.01V8",
	"M2 8L2 16",
	"M20.01 6L20 6",
	"M4 6L4 6.01",
	"M18.01 4L18 4",
	"M6 4L6 4.01",
	"M8 2L16 2",
])

// icons/alert-warning.tsx
export const alertWarningIcon = pixelIcon([
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
])

// icons/loader.tsx
export const loaderIcon = pixelIcon([
	["M12 19V22", "0.5"],
	["M19.01 19L19 19", "0.63"],
	["M5.01001 19L5.00001 19", "0.38"],
	["M17.01 17L17 17", "0.63"],
	["M7.01001 17L7.00001 17", "0.38"],
	["M22.005 11.995L19.005 11.995", "0.75"],
	["M5.005 11.995L2.005 11.995", "0.25"],
	["M17.01 7L17 7", "0.88"],
	["M7.01001 7L7.00001 7", "0.13"],
	["M19.01 5L19 5", "0.88"],
	["M5.01001 5L5.00001 5", "0.13"],
	["M12 2V5", "1"],
])

/** combobox.tsx's item indicator: an inline round-capped check, not a pixel glyph. */
export const comboboxCheckIcon = <Message>(h: HtmlBuilder<Message>): Html =>
	h.svg(
		[
			h.Attribute("xmlns", "http://www.w3.org/2000/svg"),
			h.Attribute("width", "24"),
			h.Attribute("height", "24"),
			h.Attribute("viewBox", "0 0 24 24"),
			h.Attribute("fill", "none"),
			h.Attribute("stroke", "currentColor"),
			h.Attribute("stroke-width", "2"),
			h.Attribute("stroke-linecap", "round"),
			h.Attribute("stroke-linejoin", "round"),
			h.Attribute("aria-hidden", "true"),
		],
		[h.path([h.Attribute("d", "M5.252 12.7 10.2 18.63 18.748 5.37")])],
	)
