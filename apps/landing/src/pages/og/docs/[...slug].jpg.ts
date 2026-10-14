import type { APIRoute, GetStaticPaths } from "astro"
import { getCollection, type CollectionEntry } from "astro:content"
import { renderDocsOg } from "../../../lib/docs-og"

export const getStaticPaths = (async () => {
	const docs = await getCollection("docs", ({ data }) => !data.draft)
	return docs.map((doc) => ({ params: { slug: doc.id }, props: { doc } }))
}) satisfies GetStaticPaths

export const GET: APIRoute<{ doc: CollectionEntry<"docs"> }> = async ({ props: { doc } }) => {
	const jpeg = await renderDocsOg({
		slug: doc.id,
		title: doc.data.title,
		description: doc.data.description,
		group: doc.data.group,
		sdk: doc.data.sdk,
		icon: doc.data.icon,
	})
	return new Response(jpeg, { headers: { "Content-Type": "image/jpeg" } })
}
