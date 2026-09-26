import type { APIRoute } from "astro"
import { getCollection, render } from "astro:content"
import { splitSections, type SearchDoc } from "../../lib/docs-search"

/**
 * Prebuilt search index for the docs ⌘K palette. Emitted as a static
 * `/docs/search-index.json` at build (and served live under `astro dev`); the
 * client fetches it once on first idle/open and searches it per section.
 */
export const GET: APIRoute = async () => {
	const docs = await getCollection("docs", ({ data }) => !data.draft)

	const records: SearchDoc[] = await Promise.all(
		docs.map(async (doc) => {
			// Astro's own heading slugs, so section links match the rendered ids.
			const { headings } = await render(doc)
			const { intro, sections } = splitSections(doc.body ?? "", headings)
			return {
				id: doc.id,
				url: `/docs/${doc.id}`,
				title: doc.data.title,
				description: doc.data.description,
				group: doc.data.group,
				sdk: doc.data.sdk,
				intro,
				sections,
			}
		}),
	)

	return new Response(JSON.stringify(records), {
		headers: { "Content-Type": "application/json" },
	})
}
