/**
 * `/llms-full.txt`: every doc concatenated into one file, in sidebar order.
 *
 * The single-fetch counterpart to walking `/docs.md` link by link. This is what
 * `/llms.txt` points at as "the full documentation".
 */
import type { APIRoute } from "astro"
import { getDocGroups } from "../lib/docs-order"
import { absolute, plainText } from "../lib/page-markdown"
import { Array as Arr } from "effect"

export const GET: APIRoute = async ({ site }) => {
	const groups = await getDocGroups()

	const sections = Arr.flatMap(groups, ({ group, docs }) =>
		Arr.map(docs, (doc) =>
			Arr.join(
				[
					`# ${doc.data.title}`,
					"",
					`> ${group} · ${absolute(site, `/docs/${doc.id}`)}`,
					"",
					doc.data.description,
					"",
					(doc.body ?? "").trim(),
				],
				"\n",
			),
		),
	)

	return plainText(
		Arr.join(
			[
				"# Maple Documentation",
				"",
				"> Every Maple doc, concatenated. Source: https://maple.dev/docs",
				"",
				Arr.join(sections, "\n\n---\n\n"),
			],
			"\n",
		),
	)
}
