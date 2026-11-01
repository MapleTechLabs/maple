/**
 * Every guide, grouped by category. The `/guides` index and `llms.txt` both
 * read this list, so a new guide only needs an entry here to show up in both.
 */

import type { IconComponent } from "@maple/ui/components/icons/icon"
import { AlertWarningIcon } from "@maple/ui/components/icons/alert-warning"
import { BellIcon } from "@maple/ui/components/icons/bell"
import { BoxIcon } from "@maple/ui/components/icons/box"
import { BracketsCurlyIcon } from "@maple/ui/components/icons/brackets-curly"
import { ChartLineIcon } from "@maple/ui/components/icons/chart-line"
import { ComputerIcon } from "@maple/ui/components/icons/computer"
import { CreditCardIcon } from "@maple/ui/components/icons/credit-card"
import { EyeIcon } from "@maple/ui/components/icons/eye"
import { FileIcon } from "@maple/ui/components/icons/file"
import { GaugeIcon } from "@maple/ui/components/icons/gauge"
import { LayersIcon } from "@maple/ui/components/icons/layers"
import { MagnifierIcon } from "@maple/ui/components/icons/magnifier"
import { NetworkNodesIcon } from "@maple/ui/components/icons/network-nodes"
import { NodejsIcon } from "@maple/ui/components/icons/nodejs"
import { PulseIcon } from "@maple/ui/components/icons/pulse"
import { PuzzlePieceIcon } from "@maple/ui/components/icons/puzzle-piece"
import { PythonIcon } from "@maple/ui/components/icons/python"
import { ServerIcon } from "@maple/ui/components/icons/server"
import { SquareActivityChartIcon } from "@maple/ui/components/icons/square-activity-chart"
import { StopwatchIcon } from "@maple/ui/components/icons/stopwatch"

export type Guide = {
	href: string
	icon: IconComponent
	title: string
	description: string
}

export type GuideCategory = {
	id: string
	icon: IconComponent
	title: string
	description: string
	guides: Guide[]
}

export const guideCategories: GuideCategory[] = [
	{
		id: "fundamentals",
		icon: LayersIcon,
		title: "Fundamentals",
		description: "What the terms mean and how the signals fit together.",
		guides: [
			{
				href: "/guides/what-is-apm",
				icon: SquareActivityChartIcon,
				title: "What is APM?",
				description:
					"How metrics, traces, errors and logs get you from “users are waiting” to the dependency that caused it.",
			},
			{
				href: "/observability",
				icon: EyeIcon,
				title: "What is observability?",
				description:
					"Traces, logs and metrics, and why correlating them matters more than collecting each one.",
			},
			{
				href: "/opentelemetry",
				icon: NetworkNodesIcon,
				title: "What is OpenTelemetry?",
				description:
					"How vendor-neutral instrumentation keeps telemetry portable across languages and backends.",
			},
			{
				href: "/guides/what-is-apdex",
				icon: GaugeIcon,
				title: "What is Apdex?",
				description: "How Apdex turns response times into one score, and when it beats a p95 alert.",
			},
		],
	},
	{
		id: "monitoring",
		icon: BellIcon,
		title: "Monitoring & alerting",
		description: "Which numbers to watch, and how to alert before users notice.",
		guides: [
			{
				href: "/guides/prometheus-metrics",
				icon: ChartLineIcon,
				title: "Prometheus metrics, explained",
				description:
					"The four metric types, the handful worth watching, and how to collect and chart them.",
			},
			{
				href: "/guides/uptime-monitoring",
				icon: PulseIcon,
				title: "Uptime monitoring with traces and HTTP checks",
				description:
					"Alert on error rate, throughput and Apdex from your traces, plus HTTP checks for endpoints.",
			},
			{
				href: "/guides/remote-server-monitoring",
				icon: ServerIcon,
				title: "Remote server monitoring with OpenTelemetry",
				description:
					"Agent vs agentless, a Collector setup for host metrics and logs, and alerts for quiet servers.",
			},
			{
				href: "/guides/windows-server-monitoring",
				icon: ComputerIcon,
				title: "Windows server monitoring tools",
				description:
					"The signals worth an alert, the tools compared, and an OpenTelemetry setup for Windows.",
			},
		],
	},
	{
		id: "logging",
		icon: FileIcon,
		title: "Logging",
		description: "Getting structured logs out of your code and into one place.",
		guides: [
			{
				href: "/guides/pino-logger",
				icon: NodejsIcon,
				title: "Pino logger for Node.js",
				description:
					"Set up Pino for production, log HTTP requests, and tie every line to its trace.",
			},
			{
				href: "/guides/loguru",
				icon: PythonIcon,
				title: "Loguru for Python",
				description:
					"Set the level, write files and JSON, add context, then send logs to OpenTelemetry.",
			},
			{
				href: "/guides/python-logging-levels",
				icon: PythonIcon,
				title: "Python logging levels and how to set them",
				description:
					"The five levels, why info() prints nothing by default, and how to set the level.",
			},
			{
				href: "/guides/log-parsing",
				icon: BracketsCurlyIcon,
				title: "Log parsing: from raw lines to structured fields",
				description: "A tested Collector config for nginx, JSON, logfmt, multiline and syslog logs.",
			},
		],
	},
	{
		id: "troubleshooting",
		icon: MagnifierIcon,
		title: "Troubleshooting",
		description: "Walkthroughs of a production problem, from the first signal to the fix.",
		guides: [
			{
				href: "/guides/api-latency",
				icon: StopwatchIcon,
				title: "When API p99 jumps but p50 doesn't",
				description:
					"Isolate the slow requests and trace a latency regression to the release responsible.",
			},
			{
				href: "/guides/incident-response",
				icon: AlertWarningIcon,
				title: "Incident response, step by step",
				description:
					"A process for small teams: preparation, the response steps, and lightweight postmortems.",
			},
		],
	},
	{
		id: "tools",
		icon: BoxIcon,
		title: "Tools & pricing",
		description: "Choosing an observability stack, and what it costs.",
		guides: [
			{
				href: "/best-open-source-observability-tools",
				icon: PuzzlePieceIcon,
				title: "Best open-source observability tools",
				description:
					"The leading options compared by architecture, signals, license and operating cost.",
			},
			{
				href: "/guides/new-relic-pricing",
				icon: CreditCardIcon,
				title: "New Relic pricing, explained",
				description:
					"How users and gigabytes add up to a monthly bill, and what a 12-person team pays.",
			},
			{
				href: "/guides/sentry-pricing",
				icon: CreditCardIcon,
				title: "Sentry pricing in 2026",
				description:
					"Plans, per-unit rates for errors, spans and replays, and two worked monthly bills.",
			},
			{
				href: "/guides/dynatrace-pricing",
				icon: CreditCardIcon,
				title: "Dynatrace pricing, explained",
				description:
					"The DPS rate card, cost per host and per GiB, and a worked bill for a small fleet.",
			},
		],
	},
]

export const allGuides: Guide[] = guideCategories.flatMap((category) => category.guides)
