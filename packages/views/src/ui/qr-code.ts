import type { Html, HtmlBuilder } from "foldkit/html"
import { encode } from "uqr"
import { Array as Arr } from "effect"

/** `QrCode`: a value as a QR code, one `<path>` in `currentColor` so it takes the theme's foreground;
 * `label` is its accessible name and `className` its size. */
export const qrCode = <M>(
	h: HtmlBuilder<M>,
	options: Readonly<{ value: string; label: string; className?: string }>,
): Html => {
	const result = encode(options.value, { border: 1 })
	// A 1x1 square per dark module.
	const path = Arr.join(
		Arr.flatMap(result.data, (row, y) =>
			Arr.map(row, (isDark, x) => (isDark ? `M${x} ${y}h1v1h-1z` : "")),
		),
		"",
	)
	return h.svg(
		[
			h.Attribute("xmlns", "http://www.w3.org/2000/svg"),
			h.Attribute("viewBox", `0 0 ${result.size} ${result.size}`),
			...(options.className === undefined ? [] : [h.Class(options.className)]),
			h.Attribute("shape-rendering", "crispEdges"),
			h.Role("img"),
			h.AriaLabel(options.label),
		],
		[h.path([h.Attribute("d", path), h.Attribute("fill", "currentColor")], [])],
	)
}
