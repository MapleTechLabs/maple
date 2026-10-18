import type { ChatConnectorManifest } from "@maple/chat-platform/manifests"
import type { Html, HtmlBuilder } from "foldkit/html"
import { icon } from "../../ui/icon"
import { type IntegrationBrand, integrationIconPlate } from "../infra-integrations/kit/integration-empty"
import type { CatalogEntry } from "./catalog"

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

/** The entry's mark at `size` (`<entry.icon size className />`). */
export const entryGlyph = <M>(
	h: HtmlBuilder<M>,
	entry: CatalogEntry,
	size: number | undefined,
	options: Readonly<{ className?: string; monochrome?: boolean }> = {},
): Html =>
	entry.icon._tag === "Named"
		? icon(h, entry.icon.name, { size, className: options.className })
		: manifestGlyph(h, entry.icon.icon, size ?? 24, options)

export const entryBrand = <M>(h: HtmlBuilder<M>, entry: CatalogEntry): IntegrationBrand => {
	const entryIcon = entry.icon
	return entryIcon._tag === "Named"
		? { icon: entryIcon.name, accent: entry.accent, iconClassName: entry.iconClassName }
		: {
				icon: "GridIcon",
				accent: entry.accent,
				iconClassName: entry.iconClassName,
				glyph: (size) => manifestGlyph(h, entryIcon.icon, size),
			}
}

/** `IntegrationIconPlate` for a catalog entry. */
export const entryPlate = <M>(
	h: HtmlBuilder<M>,
	entry: CatalogEntry,
	options: Readonly<{ size?: number; plateClassName?: string }>,
): Html => integrationIconPlate(h, entryBrand(h, entry), options)
