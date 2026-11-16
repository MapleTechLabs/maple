/**
 * `/features/<slug>.md` — the feature registry, serialized.
 *
 * English-only and un-prefixed, unlike the `ja/` and `ko/` HTML twins. The
 * registry stores copy as uncalled `Msg` thunks; an endpoint runs outside the
 * per-render AsyncLocalStorage Paraglide resolves against, so calling one here
 * yields the source locale. That is what we want — `page-registry.ts` documents
 * the same behaviour as a hazard for `getStaticPaths`, so don't "fix" it.
 *
 * Screenshots are dropped: their `alt` text describes a capture rather than
 * making the argument, which is noise in a text-only representation. Extra
 * sections are kept, since some carry the install commands themselves.
 */
import type { APIRoute, GetStaticPaths } from "astro"
import { featureBySlug, features } from "../../lib/features"
import type { Feature } from "../../lib/page-registry"
import { useCaseBySlug } from "../../lib/use-cases"
import { absolute, blocks, docHeader, markdown } from "../../lib/page-markdown"
import { planRows } from "../../lib/feature-plan"
import { sectionMarkdown } from "../../lib/feature-sections"
import { getOffer } from "../../lib/pricing-offer"
import { scaleProofMarkdown } from "../../lib/scale-proof"
import * as m from "../../paraglide/messages.js"
import { Array as Arr } from "effect"

export const getStaticPaths: GetStaticPaths = () =>
	Arr.map(features, (feature) => ({ params: { slug: feature.slug }, props: { feature } }))

export const GET: APIRoute = async ({ props, site }) => {
	const { feature } = props as { feature: Feature }

	const facts = feature.panel
		? blocks(
				`## ${feature.panel.title()}`,
				feature.panel.lede(),
				Arr.join(
					Arr.map(feature.panel.facts, ({ key, value }) => `- **${key}**: ${value}`),
					"\n",
				),
			)
		: undefined

	const plan = blocks(
		`## ${m.feat_plan_title()}`,
		Arr.join(
			Arr.map(planRows(feature.plan, await getOffer()), ({ key, value }) => `- **${key}**: ${value}`),
			"\n",
		),
		scaleProofMarkdown(site),
		Arr.join(
			[
				...(feature.plan.docs
					? [`- [${m.feat_plan_docs()}](${absolute(site, `${feature.plan.docs}.md`)})`]
					: []),
				`- [${m.feat_plan_pricing()}](${absolute(site, "/pricing.md")})`,
			],
			"\n",
		),
	)

	const related = blocks(
		"## Related",
		Arr.join(
			[
				...Arr.map(
					feature.related,
					(slug) =>
						`- [${featureBySlug(slug)?.navLabel() ?? slug}](${absolute(site, `/features/${slug}.md`)})`,
				),
				...Arr.map(
					feature.relatedUseCases,
					(slug) =>
						`- [${useCaseBySlug(slug)?.navLabel() ?? slug}](${absolute(site, `/use-cases/${slug}.md`)})`,
				),
			],
			"\n",
		),
	)

	return markdown(
		blocks(
			docHeader(feature.heroTitle(), feature.heroLede()),
			facts,
			plan,
			...Arr.map(feature.extraSections, (id) => sectionMarkdown(id, site)),
			`## ${feature.capTitle()}`,
			...Arr.map(feature.capabilities, (cap) => `### ${cap.op}: ${cap.title()}\n\n${cap.body()}`),
			related,
		),
	)
}
