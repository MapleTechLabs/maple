/**
 * Every guide, grouped by category. The `/guides` index and `llms.txt` both
 * read this list, so a new guide only needs an entry here to show up in both.
 */

export type Guide = {
	href: string
	title: string
}

export type GuideCategory = {
	id: string
	title: string
	guides: Guide[]
}

export const guideCategories: GuideCategory[] = [
	{
		id: "fundamentals",
		title: "Fundamentals",
		guides: [
			{
				href: "/guides/what-is-apm",
				title: "What is APM?",
			},
			{
				href: "/observability",
				title: "What is observability?",
			},
			{
				href: "/opentelemetry",
				title: "What is OpenTelemetry?",
			},
		],
	},
	{
		id: "monitoring",
		title: "Metrics & alerting",
		guides: [
			{
				href: "/guides/what-is-apdex",
				title: "What is Apdex?",
			},
			{
				href: "/guides/prometheus-metrics",
				title: "Prometheus metrics, explained",
			},
			{
				href: "/guides/uptime-monitoring",
				title: "Uptime monitoring",
			},
		],
	},
	{
		id: "investigations",
		title: "Investigations",
		guides: [
			{
				href: "/guides/api-latency",
				title: "When API p99 jumps but p50 doesn't",
			},
		],
	},
	{
		id: "tools",
		title: "Tools & pricing",
		guides: [
			{
				href: "/best-open-source-observability-tools",
				title: "Best open-source observability tools",
			},
			{
				href: "/guides/dynatrace-pricing",
				title: "Dynatrace pricing, explained",
			},
		],
	},
]

export const allGuides: Guide[] = guideCategories.flatMap((category) => category.guides)
