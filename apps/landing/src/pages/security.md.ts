/** `/security.md`: the agent-readable twin of `/security`. */
import type { APIRoute } from "astro"
import { Array as Arr } from "effect"
import { complianceMarkdown } from "../lib/compliance"
import { blocks, docHeader, markdown } from "../lib/page-markdown"
import { securityFaqs, securitySections } from "../lib/security-page"
import * as m from "../paraglide/messages.js"

export const GET: APIRoute = async ({ site }) => {
	const url = (path: string) => new URL(path, site ?? "https://maple.dev").toString()
	const link = (href: string) => (href.startsWith("http") ? href : url(href))

	return markdown(
		blocks(
			docHeader(
				"Maple security and compliance",
				"How Maple handles access, encryption, data residency and audits. SOC 2 Type II and ISO 27001 audits are in progress; a data processing agreement is available on request.",
			),

			`## ${m.compliance_title()}`,
			complianceMarkdown(),

			...Arr.flatMap(securitySections, (section) => [
				`## ${section.title}`,
				Arr.join(
					Arr.map(
						section.facts,
						(fact) =>
							`- **${fact.title}.** ${fact.body}${fact.href && fact.link ? ` [${fact.link}](${link(fact.href)})` : ""}`,
					),
					"\n",
				),
			]),

			"## FAQ",
			...Arr.flatMap(securityFaqs, (item) => [`### ${item.question}`, item.answer]),

			"## Links",
			Arr.join(
				[
					`- [Security (HTML)](${url("/security")})`,
					`- [EU hosting](${url("/eu.md")})`,
					`- [Pricing](${url("/pricing.md")})`,
				],
				"\n",
			),
		),
	)
}
