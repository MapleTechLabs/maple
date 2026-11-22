/**
 * `/alternatives/<slug>.md`: the roundup in `lib/alternatives.ts`, serialized
 * in the HTML page's order, so an answer engine reads the same disclosure,
 * table, entries, "when to stay" and sources.
 */
import type { APIRoute, GetStaticPaths } from "astro"
import { type AlternativesPage, alternativesPages } from "../../lib/alternatives"
import { comparePath } from "../../lib/competitors"
import { absolute, blocks, docHeader, markdown, table } from "../../lib/page-markdown"
import { Array as Arr, String as Str } from "effect"

export const getStaticPaths: GetStaticPaths = () =>
	Arr.map(alternativesPages, (page) => ({ params: { slug: page.slug }, props: { page } }))

const monthLabel = (iso: string) =>
	new Date(`${iso.slice(0, 7)}-15T00:00:00Z`).toLocaleDateString("en-US", {
		month: "long",
		year: "numeric",
		timeZone: "UTC",
	})

/** Pipes inside a cell would break the row. */
const cell = (text: string) => Str.replaceAll("|", "\\|")(text)

const bullets = (items: readonly string[]) =>
	Arr.join(
		Arr.map(items, (item) => `- ${item}`),
		"\n",
	)

export const GET: APIRoute = ({ props, site }) => {
	const { page } = props as { page: AlternativesPage }

	const glance = table(
		["Tool", "Pick it if", "Pricing", "License", page.keyColumn],
		[
			[
				page.baseline.name,
				"The tool you are replacing",
				cell(page.baseline.pricing),
				cell(page.baseline.openSource),
				cell(page.baseline.keyFact),
			],
			...Arr.map(page.alternatives, (alt) => [
				alt.ours ? `${alt.name} (ours)` : alt.name,
				cell(alt.pickIf),
				cell(alt.pricing),
				cell(alt.openSource),
				cell(alt.keyFact),
			]),
		],
	)

	const entries = Arr.map(page.alternatives, (alt) =>
		blocks(
			`### ${alt.name}${alt.ours ? " (built by us)" : ""}`,
			`**Pick it if:** ${alt.pickIf}`,
			alt.summary,
			`**Strengths**\n\n${bullets(alt.pros)}`,
			`**Trade-offs**\n\n${bullets(alt.cons)}`,
			`${alt.pricing} · ${alt.openSource} · [${alt.url}](${alt.url})${
				alt.compareSlug
					? ` · [Full comparison](${absolute(site, `${comparePath("en", alt.compareSlug)}.md`)})`
					: ""
			}`,
		),
	)

	return markdown(
		blocks(
			docHeader(page.seoTitle, page.lede),
			page.disclosure,
			page.method,
			`Updated ${monthLabel(page.updated)}.`,
			"## The short answer",
			bullets(Arr.map(page.quickAnswer, (row) => `**${row.team}:** ${row.pick}. ${row.why}`)),
			"## At a glance",
			glance,
			"## The alternatives",
			...entries,
			`## When to stay on ${page.vendor}`,
			bullets(page.stayIf),
			"## FAQ",
			...Arr.map(page.faqs, (faq) => blocks(`### ${faq.question}`, faq.answer)),
			"## Sources",
			Arr.join(
				Arr.map(
					page.sources,
					(source, i) =>
						`${i + 1}. [${source.label}](${source.url}), checked ${monthLabel(source.checked)}`,
				),
				"\n",
			),
		),
	)
}
