import type { Html, HtmlBuilder } from "foldkit/html"
// `uqr` is apps/web's dependency (QrCode there encodes with it); the same package, not a copy.
import { encode } from "../../../../../../web/node_modules/uqr/dist/index.mjs"

// `QrCode` (apps/web/src/components/account/qr-code.tsx): one `<path>` in `currentColor`, a
// 1x1 square per dark module, so the code inherits the theme's foreground.

export const qrCode = <M>(h: HtmlBuilder<M>, value: string, className?: string): Html => {
	const result = encode(value, { border: 1 })
	const path = result.data.flatMap((row, y) => row.map((isDark, x) => (isDark ? `M${x} ${y}h1v1h-1z` : ""))).join("")
	return h.svg(
		[
			h.Attribute("xmlns", "http://www.w3.org/2000/svg"),
			h.Attribute("viewBox", `0 0 ${result.size} ${result.size}`),
			...(className === undefined ? [] : [h.Class(className)]),
			h.Attribute("shape-rendering", "crispEdges"),
			h.Role("img"),
			h.AriaLabel("Two-factor setup QR code"),
		],
		[h.path([h.Attribute("d", path), h.Attribute("fill", "currentColor")], [])],
	)
}
