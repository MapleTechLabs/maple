/**
 * Every guide, grouped by category. The header's Guides menu, the `/guides`
 * index and `llms.txt` all read this list, so a new guide only needs an entry
 * here to show up everywhere.
 *
 * Guides are English-only except `/opentelemetry`, which has ja/ko pages;
 * `localized` marks the ones whose href takes the locale prefix.
 */

export type Guide = {
	href: string
	title: string
	/** One line for the header menu. */
	navDesc: string
	/** The longer pitch on the `/guides` index. */
	description: string
	label: string
	read: string
	localized?: boolean
}

export type GuideCategory = {
	id: string
	title: string
	description: string
	guides: Guide[]
}

export const guideCategories: GuideCategory[] = [
	{
		id: "fundamentals",
		title: "Fundamentals",
		description:
			"What the terms mean and how the signals fit together. None of them assume a vendor or stack.",
		guides: [
			{
				href: "/guides/what-is-apm",
				label: "APM",
				title: "What is APM?",
				navDesc: "How service metrics, traces and errors lead you to the cause.",
				description:
					"How application performance monitoring uses service metrics, traces, errors, and logs to get you from “users are waiting” to “this dependency caused it.”",
				read: "12 min",
			},
			{
				href: "/observability",
				label: "Foundation",
				title: "What is observability?",
				navDesc: "Traces, logs and metrics, and why correlation matters.",
				description:
					"Understand traces, logs, and metrics, and why correlation matters more than collecting each signal in isolation.",
				read: "8 min",
			},
			{
				href: "/opentelemetry",
				label: "Open standard",
				title: "What is OpenTelemetry?",
				navDesc: "Vendor-neutral instrumentation that keeps telemetry portable.",
				description:
					"Learn how vendor-neutral instrumentation keeps telemetry portable across languages, collectors, and backends.",
				read: "7 min",
				localized: true,
			},
		],
	},
	{
		id: "monitoring",
		title: "Metrics & alerting",
		description: "Which numbers to watch, and how to alert on them before users notice.",
		guides: [
			{
				href: "/guides/what-is-apdex",
				label: "Metric",
				title: "What is Apdex?",
				navDesc: "One satisfaction score from response times, and how to pick T.",
				description:
					"How Apdex turns response times into one satisfaction score, how to pick its target T, and when it beats a p95 alert.",
				read: "10 min",
			},
			{
				href: "/guides/prometheus-metrics",
				label: "Metrics",
				title: "Prometheus metrics, explained",
				navDesc: "The four metric types and the handful worth watching.",
				description:
					"The four metric types with examples, the handful worth watching, and how to collect and chart them.",
				read: "7 min",
			},
			{
				href: "/guides/uptime-monitoring",
				label: "Availability",
				title: "Uptime monitoring",
				navDesc: "Alerts from traces, plus HTTP checks for what traces miss.",
				description:
					"Alert on error rate, throughput and Apdex from the traces you already send, add Collector HTTP checks for endpoints and certificates, and see which failures each one catches.",
				read: "7 min",
			},
		],
	},
	{
		id: "investigations",
		title: "Investigations",
		description: "Hands-on walkthroughs of a production problem, from the first signal to the cause.",
		guides: [
			{
				href: "/guides/api-latency",
				label: "API performance",
				title: "When API p99 jumps but p50 doesn't",
				navDesc: "Trace a tail-latency regression to its release and operation.",
				description:
					"Measure the right latency clock, isolate the slow requests, and trace a regression to the release and operation responsible.",
				read: "14 min",
			},
		],
	},
	{
		id: "tools",
		title: "Tools & pricing",
		description: "Choosing an observability stack, and what it costs.",
		guides: [
			{
				href: "/best-open-source-observability-tools",
				label: "Field guide",
				title: "Best open-source observability tools",
				navDesc: "The open-source options by signals, license and cost.",
				description:
					"Compare the leading open-source options by architecture, signals, license, operating cost, and best fit.",
				read: "14 min",
			},
			{
				href: "/guides/dynatrace-pricing",
				label: "Pricing",
				title: "Dynatrace pricing, explained",
				navDesc: "The DPS rate card and a worked monthly bill.",
				description:
					"The DPS rate card, cost per host and per GiB, what OpenTelemetry data costs, and a worked monthly bill for a small fleet.",
				read: "9 min",
			},
		],
	},
]

export const allGuides: Guide[] = guideCategories.flatMap((category) => category.guides)

export const guideHref = (guide: Guide, locale: string) =>
	guide.localized && locale !== "en" ? `/${locale}${guide.href}` : guide.href
