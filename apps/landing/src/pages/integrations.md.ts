/**
 * `/integrations.md`: the integrations hub, serialized: one section per
 * category, one line per tile with the page it links to.
 */
import type { APIRoute } from "astro"
import { HUB_CATEGORIES, text } from "../lib/integrations-hub"
import { absolute, blocks, docHeader, markdown } from "../lib/page-markdown"
import * as m from "../paraglide/messages.js"

export const GET: APIRoute = ({ site }) => {
	const sections = HUB_CATEGORIES.map((category) =>
		blocks(
			`## ${category.title()}`,
			category.lede(),
			category.tiles
				.map((tile) => `- [${text(tile.name)}](${absolute(site, tile.href)}): ${text(tile.hint)}`)
				.join("\n"),
		),
	)

	return markdown(
		blocks(
			docHeader(m.intg_title(), m.intg_lede()),
			...sections,
			`## ${m.intg_otel_title()}`,
			`${m.intg_otel_body()} [${m.intg_otel_link()}](${absolute(site, "/docs/getting-started/quickstart")})`,
		),
	)
}
