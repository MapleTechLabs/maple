import type { APIRoute } from "astro"
import { experimental_AstroContainer as AstroContainer } from "astro/container"
import { getCollection, render } from "astro:content"
import BrandMarkIcon from "../../components/BrandMarkIcon.astro"
import DocsCategoryIcon from "../../components/docs/DocsCategoryIcon.astro"
import LanguageLogo from "../../components/docs/LanguageLogo.astro"
import { isDocGroup } from "../../lib/docs-nav"
import { splitSections, type SearchDoc, type SearchIndexPayload } from "../../lib/docs-search"

const ICON_CLASS = "size-4 shrink-0"

/**
 * Prebuilt search index for the docs ⌘K palette. Emitted as a static
 * `/docs/search-index.json` at build (and served live under `astro dev`); the
 * client fetches it once on first idle/open and searches it per section.
 * Icons are the sidebar's own components rendered to SVG, deduped by key.
 */
export const GET: APIRoute = async () => {
	const docs = await getCollection("docs", ({ data }) => !data.draft)
	const container = await AstroContainer.create()
	const icons: Record<string, Promise<string>> = {}

	const groupIcon = (group: string) => {
		if (!isDocGroup(group)) return undefined
		const key = `group:${group}`
		icons[key] ??= container.renderToString(DocsCategoryIcon, {
			props: { name: group, class: ICON_CLASS },
		})
		return key
	}

	// Same precedence as DocsSidebar, with the group glyph as the fallback.
	const docIcon = ({ sdk, icon, group }: (typeof docs)[number]["data"]) => {
		if (sdk) {
			const key = `sdk:${sdk}`
			icons[key] ??= container.renderToString(LanguageLogo, { props: { id: sdk, class: ICON_CLASS } })
			return key
		}
		if (icon) {
			const key = `mark:${icon}`
			icons[key] ??= container.renderToString(BrandMarkIcon, { props: { id: icon, class: ICON_CLASS } })
			return key
		}
		return groupIcon(group)
	}

	const records: SearchDoc[] = await Promise.all(
		docs.map(async (doc) => {
			// Astro's own heading slugs, so section links match the rendered ids.
			const { headings } = await render(doc)
			const { intro, sections } = splitSections(doc.body ?? "", headings)
			groupIcon(doc.data.group)
			return {
				id: doc.id,
				url: `/docs/${doc.id}`,
				title: doc.data.title,
				description: doc.data.description,
				group: doc.data.group,
				sdk: doc.data.sdk,
				icon: docIcon(doc.data),
				intro,
				sections,
			}
		}),
	)

	const payload: SearchIndexPayload = {
		docs: records,
		icons: Object.fromEntries(
			await Promise.all(
				Object.entries(icons).map(async ([key, svg]) => [key, (await svg).trim()] as const),
			),
		),
	}

	return new Response(JSON.stringify(payload), {
		headers: { "Content-Type": "application/json" },
	})
}
