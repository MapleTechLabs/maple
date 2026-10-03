/**
 * `/changelog.md` — every entry as a flat list, newest first.
 */
import type { APIRoute } from "astro"
import { getSortedReleases } from "../lib/changelog"
import { CATEGORY_LABELS } from "../lib/changelog-meta"
import { absolute, blocks, docHeader, markdown } from "../lib/page-markdown"
import { isoDate } from "../lib/blog"

export const GET: APIRoute = async ({ site }) => {
	const releases = await getSortedReleases()

	return markdown(
		blocks(
			docHeader(
				"Maple Changelog",
				"New features, improvements and fixes in Maple, newest first. Append `.md` to any changelog URL, or send `Accept: text/markdown`, to receive the raw markdown source.",
			),
			...releases.map((release) =>
				blocks(
					`## ${release.data.title}`,
					`${isoDate(release.data.date)} · ${CATEGORY_LABELS[release.data.category]} · [${absolute(site, `/changelog/${release.id}.md`)}](${absolute(site, `/changelog/${release.id}.md`)})${release.data.breaking ? " · **breaking**" : ""}`,
					release.data.description,
				),
			),
		),
	)
}
