import type { ChatConnectorManifest } from "@maple/chat-platform/manifests"
import type { Html, HtmlBuilder } from "foldkit/html"

/** `chatConnectorIcon`: one `<svg>` from a manifest's path data; `monochrome` drops the brand fills. */
export const manifestGlyph = <M>(
	h: HtmlBuilder<M>,
	manifestIcon: ChatConnectorManifest["icon"],
	size: number,
	options: Readonly<{ className?: string; monochrome?: boolean }> = {},
): Html =>
	h.svg(
		[
			h.Attribute("xmlns", "http://www.w3.org/2000/svg"),
			h.Attribute("viewBox", manifestIcon.viewBox),
			h.Attribute("width", String(size)),
			h.Attribute("height", String(size)),
			...(options.className === undefined ? [] : [h.Class(options.className)]),
			h.Attribute("fill", "currentColor"),
			h.AriaHidden(true),
		],
		manifestIcon.paths.map((path) =>
			h.path([
				h.Attribute("d", path.d),
				...(options.monochrome === true || path.fill === undefined
					? []
					: [h.Attribute("fill", path.fill)]),
			]),
		),
	)
