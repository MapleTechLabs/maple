import type { Html, HtmlBuilder } from "foldkit/html"

/** A Nucleo pixel icon: square-capped 2px strokes on a 24 grid, as the `.tsx` icons render them. */
const strokeIcon =
	(paths: ReadonlyArray<string>) =>
	<Message>(h: HtmlBuilder<Message>, size: number, className?: string): Html =>
		h.svg(
			[
				h.Attribute("xmlns", "http://www.w3.org/2000/svg"),
				h.Attribute("viewBox", "0 0 24 24"),
				h.Attribute("width", String(size)),
				h.Attribute("height", String(size)),
				...(className === undefined ? [] : [h.Attribute("class", className)]),
				h.Attribute("fill", "none"),
				h.Attribute("aria-hidden", "true"),
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

// Paths copied from packages/ui/src/components/icons/*.tsx and apps/web/src/components/icons/*.tsx.
export const chevronRightIcon = strokeIcon([
	"M16.99 12H17",
	"M14.99 10H15",
	"M14.99 14H15",
	"M12.99 16H13",
	"M12.99 8H13",
	"M10.99 6H11",
	"M10.99 18H11",
	"M8.99 20H9",
	"M8.99 4H9",
])
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
export const linkIcon = strokeIcon([
	"m19.014 11.943 1.021 1.021c1.953 1.953 1.953 5.118 0 7.071-1.953 1.953-5.118 1.953-7.071 0l-3.121-3.121c-1.953-1.953-1.953-5.118 0-7.071.366-.366.775-.664 1.21-.892",
	"m12.934 15.056c.44-.23.853-.529 1.223-.899 1.953-1.953 1.953-5.118 0-7.071l-3.121-3.121c-1.953-1.953-5.118-1.953-7.071 0-1.953 1.953-1.953 5.118 0 7.071l1.021 1.021",
])
export const pulseIcon = strokeIcon([
	"M6 18.01L6 18",
	"M18 7.01001L18 7.00001",
	"M8 20.01L8 20",
	"M2 16L4 16",
	"M14 9L16 9",
	"M20 5L22 5",
	"M10 16L10 18",
	"M12 11L12 14",
])
export const externalLinkIcon = strokeIcon([
	"M14 3L21 3L21 10",
	"M19 21L5 21",
	"M3 19L3 5",
	"M21 19L21 15",
	"M9 3L5 3",
	"M13 11L13 11.01",
	"M15 9L15 9.01",
	"M17 7L17 7.01",
	"M19 5L19 5.01",
])
export const plusIcon = strokeIcon(["M3 12H10", "M14 12H21", "M12 14V21", "M12 3V10"])
export const arrowUpIcon = strokeIcon(["M12 21V6", "M6 12L12 6L18 12"])
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
export const chevronDownIcon = strokeIcon([
	"M12 16.99L12 17",
	"M10 14.99L10 15",
	"M14 14.99L14 15",
	"M16 12.99L16 13",
	"M8 12.99L8 13",
	"M6 10.99L6 11",
	"M18 10.99L18 11",
	"M20 8.98999L20 8.99999",
	"M4 8.98999L4 8.99999",
])

/** `MediaPauseIcon` is filled, not stroked. */
export const mediaPauseIcon = <Message>(h: HtmlBuilder<Message>, size: number): Html =>
	h.svg(
		[
			h.Attribute("xmlns", "http://www.w3.org/2000/svg"),
			h.Attribute("viewBox", "0 0 24 24"),
			h.Attribute("width", String(size)),
			h.Attribute("height", String(size)),
			h.Attribute("fill", "currentColor"),
			h.Attribute("aria-hidden", "true"),
		],
		[h.path([h.Attribute("d", "M5 4H9V20H5V4Z")]), h.path([h.Attribute("d", "M15 4H19V20H15V4Z")])],
	)

/** `MinusIcon` draws a `<line>`, not paths. */
export const minusIcon = <Message>(h: HtmlBuilder<Message>, size: number): Html =>
	h.svg(
		[
			h.Attribute("xmlns", "http://www.w3.org/2000/svg"),
			h.Attribute("viewBox", "0 0 24 24"),
			h.Attribute("width", String(size)),
			h.Attribute("height", String(size)),
			h.Attribute("fill", "none"),
			h.Attribute("aria-hidden", "true"),
		],
		[
			h.line([
				h.Attribute("x1", "21"),
				h.Attribute("y1", "12"),
				h.Attribute("x2", "3"),
				h.Attribute("y2", "12"),
				h.Attribute("stroke", "currentColor"),
				h.Attribute("stroke-linecap", "square"),
				h.Attribute("stroke-miterlimit", "10"),
				h.Attribute("stroke-width", "2"),
			]),
		],
	)
