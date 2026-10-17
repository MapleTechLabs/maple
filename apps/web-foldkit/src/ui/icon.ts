import type { Attribute, Html, HtmlBuilder } from "foldkit/html"

/**
 * The house icon set (packages/ui/src/components/icons/*.tsx): a 24 grid of square-capped
 * strokes. Those modules are `.tsx`, so their path lists are copied here per icon.
 */
export type IconOptions<Message> = Readonly<{
	size?: number
	className?: string
	attributes?: ReadonlyArray<Attribute<Message>>
}>

export const strokeIcon =
	(paths: ReadonlyArray<string>) =>
	<Message>(h: HtmlBuilder<Message>, options: IconOptions<Message> = {}): Html => {
		const size = String(options.size ?? 24)
		return h.svg(
			[
				h.Attribute("xmlns", "http://www.w3.org/2000/svg"),
				h.Attribute("viewBox", "0 0 24 24"),
				h.Attribute("width", size),
				h.Attribute("height", size),
				...(options.className === undefined ? [] : [h.Attribute("class", options.className)]),
				h.Attribute("fill", "none"),
				h.Attribute("aria-hidden", "true"),
				...(options.attributes ?? []),
			],
			paths.map((d) =>
				h.path([
					h.Attribute("d", d),
					h.Attribute("stroke", "currentColor"),
					h.Attribute("stroke-width", "2"),
					h.Attribute("stroke-linecap", "square"),
				]),
			),
		)
	}

// plus.tsx
export const plusIcon = strokeIcon(["M3 12H10", "M14 12H21", "M12 14V21", "M12 3V10"])

// trash.tsx
export const trashIcon = strokeIcon([
	"M17 22L7 22",
	"M19 10V20",
	"M5 10V20",
	"M21 6H3",
	"M16 4H16.01",
	"M8.00001 4H8.01001",
	"M14 2H10",
])

// bell.tsx
export const bellIcon = strokeIcon([
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
])

// filter.tsx
export const filterIcon = strokeIcon([
	"M10 14V21H12",
	"M14 14V19",
	"M9 12L9 12.01",
	"M15 12L15 12.01",
	"M7 10L7 10.01",
	"M17 10L17 10.01",
	"M5 8L5 8.01",
	"M19 8L19 8.01",
	"M3 6V3H21V6",
])

// magnifier.tsx
export const magnifierIcon = strokeIcon([
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

// xmark.tsx
export const xmarkIcon = strokeIcon([
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

// copy.tsx
export const copyIcon = strokeIcon([
	"M19 21L9 21",
	"M5 15H5.0001",
	"M21 11L21 19",
	"M7 11L7 19",
	"M19 9L9 9",
	"M17 5L17 7",
	"M3 5L3 13",
	"M15 3L5 3",
])

// arrow-rotate-anticlockwise.tsx
export const arrowRotateAnticlockwiseIcon = strokeIcon([
	"M20 6L20 6.01",
	"M18 4L18 4.01",
	"M3.98999 6L3.99999 6",
	"M5.98999 4L5.99999 4",
	"M3.98999 18L3.99999 18",
	"M5.98999 20L5.99999 20",
	"M17.99 20L18 20",
	"M19.99 18L20 18",
	"M22 8L22 16",
	"M16 2L8 2",
	"M16 22L8 22",
	"M2 8V4",
])

// chevron-expand-y.tsx
export const chevronExpandYIcon = strokeIcon([
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

// check.tsx
export const checkIcon = strokeIcon([
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
