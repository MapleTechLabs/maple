/**
 * Every guide, grouped by category. The `/guides` index and `llms.txt` both
 * read this list, so a new guide only needs an entry here to show up in both.
 */

import type { IconName } from "@maple/views/ui/icons.generated"
import { alternativesPages, alternativesPath } from "./alternatives"
import { Array as Arr } from "effect"

export type Guide = {
	href: string
	icon: IconName
	title: string
	description: string
}

export type GuideCategory = {
	id: string
	icon: IconName
	title: string
	description: string
	guides: Guide[]
}

export const guideCategories: GuideCategory[] = [
	{
		id: "fundamentals",
		icon: "UiLayersIcon",
		title: "Fundamentals",
		description: "What the terms mean and how the signals fit together.",
		guides: [
			{
				href: "/guides/what-is-apm",
				icon: "SquareActivityChartIcon",
				title: "What is APM?",
				description:
					"How metrics, traces, errors and logs get you from “users are waiting” to the dependency that caused it.",
			},
			{
				href: "/observability",
				icon: "EyeIcon",
				title: "What is observability?",
				description:
					"Traces, logs and metrics, and why correlating them matters more than collecting each one.",
			},
			{
				href: "/opentelemetry",
				icon: "NetworkNodesIcon",
				title: "What is OpenTelemetry?",
				description:
					"How vendor-neutral instrumentation keeps telemetry portable across languages and backends.",
			},
			{
				href: "/guides/what-is-apdex",
				icon: "GaugeIcon",
				title: "What is Apdex?",
				description: "How Apdex turns response times into one score, and when it beats a p95 alert.",
			},
		],
	},
	{
		// A series: guide-series.ts holds the reading order.
		id: "opentelemetry",
		icon: "NetworkNodesIcon",
		title: "OpenTelemetry",
		description: "Running OpenTelemetry in production, in five parts.",
		guides: [
			{
				href: "/guides/opentelemetry-collector",
				icon: "LayersIcon",
				title: "The OpenTelemetry Collector",
				description:
					"Receivers, processors and exporters, a config that runs, and when to deploy an agent or a gateway.",
			},
			{
				href: "/guides/otlp",
				icon: "ArrowRightFromLineIcon",
				title: "OTLP explained",
				description:
					"gRPC or HTTP, ports 4317 and 4318, protobuf or JSON, auth headers, and the export errors you will hit.",
			},
			{
				href: "/guides/opentelemetry-sampling",
				icon: "FilterIcon",
				title: "OpenTelemetry sampling",
				description:
					"Head and tail sampling, parent-based ratios, a tail sampling config, and what sampling does to metrics and cost.",
			},
			{
				href: "/guides/opentelemetry-context-propagation",
				icon: "LinkIcon",
				title: "Context propagation and trace IDs in logs",
				description:
					"How traceparent and baggage cross services, and how to put trace_id and span_id on every log line.",
			},
			{
				href: "/guides/metric-cardinality",
				icon: "ChartBarTrendUpIcon",
				title: "Metric cardinality",
				description:
					"What a time series is, how one attribute multiplies a bill, and how to find and fix it.",
			},
		],
	},
	{
		id: "monitoring",
		icon: "BellIcon",
		title: "Monitoring & alerting",
		description: "Which numbers to watch, and how to alert before users notice.",
		guides: [
			{
				href: "/guides/prometheus-metrics",
				icon: "ChartLineIcon",
				title: "Prometheus metrics, explained",
				description:
					"The four metric types, the handful worth watching, and how to collect and chart them.",
			},
			{
				href: "/guides/uptime-monitoring",
				icon: "PulseIcon",
				title: "Uptime monitoring with checks and traces",
				description:
					"Which failures a probe catches and which only traces see, with hosted checks, trace alerts and Collector probes.",
			},
			{
				href: "/guides/remote-server-monitoring",
				icon: "ServerIcon",
				title: "Remote server monitoring with OpenTelemetry",
				description:
					"Agent vs agentless, a Collector setup for host metrics and logs, and alerts for quiet servers.",
			},
			{
				href: "/guides/windows-server-monitoring",
				icon: "ComputerIcon",
				title: "Windows server monitoring tools",
				description:
					"The signals worth an alert, the tools compared, and an OpenTelemetry setup for Windows.",
			},
		],
	},
	{
		id: "logging",
		icon: "FileIcon",
		title: "Logging",
		description: "Getting structured logs out of your code and into one place.",
		guides: [
			{
				href: "/guides/pino-logger",
				icon: "NodejsIcon",
				title: "Pino logger for Node.js",
				description:
					"Set up Pino for production, log HTTP requests, and tie every line to its trace.",
			},
			{
				href: "/guides/loguru",
				icon: "PythonIcon",
				title: "Loguru for Python",
				description:
					"Set the level, write files and JSON, add context, then send logs to OpenTelemetry.",
			},
			{
				href: "/guides/python-logging-levels",
				icon: "PythonIcon",
				title: "Python logging levels and how to set them",
				description:
					"The five levels, why info() prints nothing by default, and how to set the level.",
			},
			{
				href: "/guides/log-parsing",
				icon: "BracketsCurlyIcon",
				title: "Log parsing: from raw lines to structured fields",
				description: "A tested Collector config for nginx, JSON, logfmt, multiline and syslog logs.",
			},
		],
	},
	{
		id: "troubleshooting",
		icon: "MagnifierIcon",
		title: "Troubleshooting",
		description: "Walkthroughs of a production problem, from the first signal to the fix.",
		guides: [
			{
				href: "/guides/api-latency",
				icon: "StopwatchIcon",
				title: "When API p99 jumps but p50 doesn't",
				description:
					"Isolate the slow requests and trace a latency regression to the release responsible.",
			},
			{
				href: "/guides/incident-response",
				icon: "AlertWarningIcon",
				title: "Incident response, step by step",
				description:
					"A process for small teams: preparation, the response steps, and lightweight postmortems.",
			},
		],
	},
	{
		id: "tools",
		icon: "BoxIcon",
		title: "Tools & pricing",
		description: "Choosing an observability stack, and what it costs.",
		guides: [
			{
				href: "/best-open-source-observability-tools",
				icon: "PuzzlePieceIcon",
				title: "Best open-source observability tools",
				description:
					"The leading options compared by architecture, signals, license and operating cost.",
			},
			...Arr.map(alternativesPages, (page) => ({
				href: alternativesPath(page.slug),
				icon: "UnorderedListIcon" as const,
				title: `${page.vendor} alternatives`,
				description: page.blurb,
			})),
			{
				href: "/guides/new-relic-pricing",
				icon: "CreditCardIcon",
				title: "New Relic pricing, explained",
				description:
					"How users and gigabytes add up to a monthly bill, and what a 12-person team pays.",
			},
			{
				href: "/guides/sentry-pricing",
				icon: "CreditCardIcon",
				title: "Sentry pricing in 2026",
				description:
					"Plans, per-unit rates for errors, spans and replays, and two worked monthly bills.",
			},
			{
				href: "/guides/dynatrace-pricing",
				icon: "CreditCardIcon",
				title: "Dynatrace pricing, explained",
				description:
					"The DPS rate card, cost per host and per GiB, and a worked bill for a small fleet.",
			},
			{
				href: "/guides/datadog-pricing",
				icon: "CreditCardIcon",
				title: "Datadog pricing, explained",
				description:
					"Per-host prices, log ingest and indexing, custom metric billing, and three worked monthly bills.",
			},
			{
				href: "/guides/honeycomb-pricing",
				icon: "CreditCardIcon",
				title: "Honeycomb pricing in 2026",
				description:
					"The free plan, the new $3.00 per million Pro rate, what counts as an event, and three worked bills.",
			},
			{
				href: "/guides/grafana-cloud-pricing",
				icon: "CreditCardIcon",
				title: "Grafana Cloud pricing, explained",
				description:
					"Free tier limits, Pro rates for series, gigabytes and users, and how DPM multiplies a metrics bill.",
			},
			{
				href: "/guides/posthog-pricing",
				icon: "CreditCardIcon",
				title: "PostHog pricing, explained",
				description:
					"The monthly free tier and the per-unit bands for events, recordings, exceptions and logs.",
			},
		],
	},
]

export const allGuides: Guide[] = Arr.flatMap(guideCategories, (category) => category.guides)
