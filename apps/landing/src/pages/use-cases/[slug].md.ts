/**
 * `/use-cases/<slug>.md` — the use-case registry, serialized.
 *
 * English-only for the same reason as `features/[slug].md.ts` — see the note
 * there before changing how messages are resolved.
 *
 * The story is the argument on these pages, so each step keeps its surface,
 * route and elapsed clock: "T+0:40 · /traces" is the claim about how little
 * time it took, and it survives the loss of the screenshots.
 */
import type { APIRoute, GetStaticPaths } from "astro"
import type { UseCase } from "../../lib/page-registry"
import { featureBySlug } from "../../lib/features"
import { useCaseBySlug, useCases } from "../../lib/use-cases"
import { absolute, blocks, docHeader, markdown } from "../../lib/page-markdown"
import { Array as Arr } from "effect"

export const getStaticPaths: GetStaticPaths = () =>
	Arr.map(useCases, (useCase) => ({ params: { slug: useCase.slug }, props: { useCase } }))

export const GET: APIRoute = ({ props, site }) => {
	const { useCase } = props as { useCase: UseCase }

	const story = blocks(
		`## ${useCase.storyTitle()}`,
		useCase.storyLede(),
		`Signal: ${useCase.signal}. ${useCase.constantLabel}: ${useCase.constant}.`,
		...Arr.map(
			useCase.steps,
			(step) =>
				`### ${step.elapsed} · ${step.surface} (${step.route}): ${step.title()}\n\n${step.body()}`,
		),
		useCase.outcomeLine(),
		Arr.join(
			Arr.map(useCase.outcomeMetrics, (metric) => `- **${metric.value}** ${metric.label()}`),
			"\n",
		),
	)

	const related = blocks(
		"## Related",
		Arr.join(
			[
				...Arr.map(
					useCase.related,
					(slug) =>
						`- [${useCaseBySlug(slug)?.navLabel() ?? slug}](${absolute(site, `/use-cases/${slug}.md`)})`,
				),
				...Arr.map(
					useCase.relatedFeatures,
					(slug) =>
						`- [${featureBySlug(slug)?.navLabel() ?? slug}](${absolute(site, `/features/${slug}.md`)})`,
				),
			],
			"\n",
		),
	)

	return markdown(
		blocks(
			docHeader(useCase.heroTitle(), useCase.heroLede()),
			story,
			`## ${useCase.capTitle()}`,
			...Arr.map(useCase.capabilities, (cap) => `### ${cap.op}: ${cap.title()}\n\n${cap.body()}`),
			related,
		),
	)
}
