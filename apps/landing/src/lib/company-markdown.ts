import type { CompanyPage } from "./company"
import { blocks, docHeader, markdown } from "./page-markdown"
import { Array as Arr } from "effect"

/** Absolutise root-relative links so the twin reads correctly when fetched on its own. */
const absolutise = (text: string, site: URL | undefined) =>
	text.replace(
		/\]\((\/[^)]*)\)/g,
		(_match, path: string) => `](${new URL(path, site ?? "https://maple.dev")})`,
	)

export const companyPageMarkdown = (page: CompanyPage, site: URL | undefined): Response =>
	markdown(
		blocks(
			docHeader(page.title, page.description),
			...Arr.map(page.sections, (section) =>
				blocks(
					`## ${section.heading}`,
					...Arr.map(section.paragraphs, (paragraph) => absolutise(paragraph, site)),
					section.bullets
						? Arr.join(
								Arr.map(section.bullets, (bullet) => `- ${absolutise(bullet, site)}`),
								"\n",
							)
						: "",
				),
			),
		),
	)
