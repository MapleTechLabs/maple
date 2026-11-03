import rss from "@astrojs/rss"
import type { APIContext } from "astro"
import { getSortedReleases } from "../../lib/changelog"
import { CATEGORY_LABELS } from "../../lib/changelog-meta"
import { Array as Arr, String as Str } from "effect"

export async function GET(context: APIContext) {
	const releases = await getSortedReleases()

	// `context.site` is astro.config.mjs `site` — required for absolute links.
	const site = context.site ?? new URL("https://maple.dev")

	return rss({
		title: "Maple changelog",
		description: "New features, improvements and fixes in Maple.",
		site,
		items: Arr.map(releases, (release) => {
			// The cover leads the item body rather than riding as an <enclosure>:
			// enclosures require a byte length we'd have to keep in sync with the
			// file by hand, and readers render an inline <img> just as well.
			const cover = release.data.cover
				? `<p><img src="${escapeHtml(new URL(release.data.cover, site).toString())}" alt="${escapeHtml(release.data.coverAlt ?? "")}" /></p>`
				: ""
			return {
				title: release.data.title,
				pubDate: release.data.date,
				description: release.data.description,
				link: `/changelog/${release.id}`,
				categories: [CATEGORY_LABELS[release.data.category]],
				content: cover || undefined,
			}
		}),
		customData: "<language>en-us</language>",
	})
}

function escapeHtml(value: string): string {
	return Str.replace(
		/"/g,
		"&quot;",
	)(Str.replace(/>/g, "&gt;")(Str.replace(/</g, "&lt;")(Str.replace(/&/g, "&amp;")(value))))
}
