/**
 * `/features.md`: the features index, serialized: the pillars, then the rest, one line per
 * feature with its own page's twin.
 */
import type { APIRoute } from "astro"
import { featureBySlug, features } from "../lib/features"
import { isPillar, PILLARS } from "../lib/feature-pillars"
import { absolute, blocks, docHeader, markdown } from "../lib/page-markdown"
import * as m from "../paraglide/messages.js"
import { Array as Arr } from "effect"

/** The document; `GET` serves it, the test reads it. */
export const featuresMarkdown = (site: URL | undefined): string => {
	const line = (slug: string) => {
		const feature = featureBySlug(slug)
		return feature === undefined
			? []
			: [`- [${feature.navLabel()}](${absolute(site, `/features/${slug}.md`)}): ${feature.navDesc()}`]
	}
	return blocks(
		docHeader(m.feat_index_title(), m.feat_index_lede()),
		`## ${m.feat_index_core()}`,
		Arr.join(
			Arr.flatMap(PILLARS, ({ slug }) => line(slug)),
			"\n",
		),
		`## ${m.nav_also_in_maple()}`,
		Arr.join(
			Arr.flatMap(features, (feature) => (isPillar(feature.slug) ? [] : line(feature.slug))),
			"\n",
		),
	)
}

export const GET: APIRoute = ({ site }) => markdown(featuresMarkdown(site))
