import type { Attribute, Html, HtmlBuilder } from "foldkit/html"

// Copied from packages/ui/src/components/icons/*.tsx (.tsx modules, not importable here).
// Same attribute order as the React icons: xmlns, viewBox, width, height, class, fill, aria-hidden.

export const CHEVRON_RIGHT_PATHS = [
	"M16.99 12H17",
	"M14.99 10H15",
	"M14.99 14H15",
	"M12.99 16H13",
	"M12.99 8H13",
	"M10.99 6H11",
	"M10.99 18H11",
	"M8.99 20H9",
	"M8.99 4H9",
]

export const CHEVRON_LEFT_PATHS = [
	"M7.01001 12H7.00001",
	"M9.01001 10H9.00001",
	"M9.01001 14H9.00001",
	"M11.01 16H11",
	"M11.01 8H11",
	"M13.01 6H13",
	"M13.01 18H13",
	"M15.01 20H15",
	"M15.01 4H15",
]

export const DOTS_PATHS = ["M5 12L5 12.01", "M12 12L12 12.01", "M19 12L19 12.01"]

export const COPY_PATHS = [
	"M19 21L9 21",
	"M5 15H5.0001",
	"M21 11L21 19",
	"M7 11L7 19",
	"M19 9L9 9",
	"M17 5L17 7",
	"M3 5L3 13",
	"M15 3L5 3",
]

export interface StrokeIconOptions<Message> {
	readonly size?: number
	readonly className?: string
	readonly strokeWidth?: string
	readonly attributes?: ReadonlyArray<Attribute<Message>>
}

/** A dotted-outline house icon: one stroked `path` per `d`, `aria-hidden` by default. */
export const strokeIcon = <Message>(
	h: HtmlBuilder<Message>,
	paths: ReadonlyArray<string>,
	options: StrokeIconOptions<Message> = {},
): Html => {
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
				h.Attribute("stroke-width", options.strokeWidth ?? "2"),
				h.Attribute("stroke-linecap", "square"),
			]),
		),
	)
}
