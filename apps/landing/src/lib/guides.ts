/**
 * Every guide, grouped by category. The `/guides` index and `llms.txt` both
 * read this list, so a new guide only needs an entry here to show up in both.
 */

export type Guide = {
	href: string
	title: string
	description: string
	label: string
	read: string
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
				description:
					"How application performance monitoring uses service metrics, traces, errors, and logs to get you from “users are waiting” to “this dependency caused it.”",
				read: "12 min",
			},
			{
				href: "/observability",
				label: "Foundation",
				title: "What is observability?",
				description:
					"Understand traces, logs, and metrics, and why correlation matters more than collecting each signal in isolation.",
				read: "8 min",
			},
			{
				href: "/opentelemetry",
				label: "Open standard",
				title: "What is OpenTelemetry?",
				description:
					"Learn how vendor-neutral instrumentation keeps telemetry portable across languages, collectors, and backends.",
				read: "7 min",
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
				description:
					"How Apdex turns response times into one satisfaction score, how to pick its target T, and when it beats a p95 alert.",
				read: "10 min",
			},
			{
				href: "/guides/prometheus-metrics",
				label: "Metrics",
				title: "Prometheus metrics, explained",
				description:
					"The four metric types with examples, the handful worth watching, and how to collect and chart them.",
				read: "7 min",
			},
			{
				href: "/guides/uptime-monitoring",
				label: "Availability",
				title: "Uptime monitoring",
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
				description:
					"Compare the leading open-source options by architecture, signals, license, operating cost, and best fit.",
				read: "14 min",
			},
			{
				href: "/guides/dynatrace-pricing",
				label: "Pricing",
				title: "Dynatrace pricing, explained",
				description:
					"The DPS rate card, cost per host and per GiB, what OpenTelemetry data costs, and a worked monthly bill for a small fleet.",
				read: "9 min",
			},
		],
	},
]

export const allGuides: Guide[] = guideCategories.flatMap((category) => category.guides)
