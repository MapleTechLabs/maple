/**
 * Guide series: ordered runs of guides meant to be read in sequence. GuideBody
 * reads these to print "Part N of M" and the next part; a guide outside every
 * series gets a few related guides from its own category instead.
 */

import { type Guide, type GuideCategory, guideCategories } from "./guides"

export type GuideSeries = {
	id: string
	title: string
	/** Guide hrefs in reading order. Each must also be listed in guides.ts. */
	hrefs: readonly string[]
}

export const guideSeries: readonly GuideSeries[] = [
	{
		id: "opentelemetry",
		title: "OpenTelemetry in production",
		hrefs: [
			"/guides/opentelemetry-collector",
			"/guides/otlp",
			"/guides/opentelemetry-sampling",
			"/guides/opentelemetry-context-propagation",
			"/guides/metric-cardinality",
		],
	},
]

export type SeriesPosition = {
	series: GuideSeries
	parts: readonly Guide[]
	/** Zero-based index of the current guide in `parts`. */
	index: number
	previous: Guide | undefined
	next: Guide | undefined
}

/** `/guides/otlp/` and `/guides/otlp` name the same guide. */
export const normalizeGuideHref = (pathname: string): string =>
	pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname

const guidesIn = (categories: readonly GuideCategory[]): readonly Guide[] =>
	categories.flatMap((category) => category.guides)

/** Where a guide sits in its series, or undefined when it is in none. */
export const seriesPosition = (
	pathname: string,
	series: readonly GuideSeries[] = guideSeries,
	categories: readonly GuideCategory[] = guideCategories,
): SeriesPosition | undefined => {
	const href = normalizeGuideHref(pathname)
	const owner = series.find((candidate) => candidate.hrefs.includes(href))
	if (owner === undefined) return undefined
	const guides = guidesIn(categories)
	const parts = owner.hrefs.flatMap((partHref) => guides.filter((guide) => guide.href === partHref))
	const index = parts.findIndex((guide) => guide.href === href)
	if (index === -1) return undefined
	return { series: owner, parts, index, previous: parts[index - 1], next: parts[index + 1] }
}

/** Up to `count` other guides from the guide's own category, in listed order. */
export const relatedGuides = (
	pathname: string,
	count = 3,
	categories: readonly GuideCategory[] = guideCategories,
): readonly Guide[] => {
	const href = normalizeGuideHref(pathname)
	const category = categories.find((candidate) => candidate.guides.some((guide) => guide.href === href))
	if (category === undefined) return []
	return category.guides.filter((guide) => guide.href !== href).slice(0, count)
}
