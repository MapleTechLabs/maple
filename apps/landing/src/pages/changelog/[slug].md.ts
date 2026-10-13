/**
 * `/changelog/<slug>.md` — one changelog entry, verbatim.
 */
import type { APIRoute, GetStaticPaths } from "astro"
import { getSortedReleases } from "../../lib/changelog"
import { CATEGORY_LABELS } from "../../lib/changelog-meta"
import { blocks, docHeader, markdown } from "../../lib/page-markdown"
import { isoDate } from "../../lib/blog"
import type { Release } from "../../lib/changelog"

export const getStaticPaths: GetStaticPaths = async () => {
	const releases = await getSortedReleases()
	return releases.map((release) => ({ params: { slug: release.id }, props: { release } }))
}

export const GET: APIRoute = ({ props }) => {
	const { release } = props as { release: Release }
	const { title, description, date, category, breaking } = release.data

	return markdown(
		blocks(
			docHeader(title, description),
			`${isoDate(date)} · ${CATEGORY_LABELS[category]}${breaking ? " · **Contains breaking changes.**" : ""}`,
			release.body ?? "",
		),
	)
}
