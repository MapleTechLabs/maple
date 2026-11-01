import type { PushSourcePlatform } from "@maple/domain/primitives"
import type { Html, HtmlBuilder } from "foldkit/html"
import { type DocsPage, docsUrl } from "../../../lib/docs"
import { ingestUrl } from "../../../lib/services/common/ingest-url"
import { flowRail, type RailItem } from "../../kit/connect-flow"
import { platformMeta } from "../kit/platforms"
import type { Message } from "./message"

// The push flow's rails: how a push source works beside the name step, where its data shows up
// beside the send step.

type H = HtmlBuilder<Message>

const DOCS_PAGE = {
	opentelemetry: "instrumentation",
	nodejs: "instrumentation",
	python: "instrumentation",
	go: "instrumentation",
	java: "instrumentation",
	dotnet: "instrumentation",
	ruby: "instrumentation",
	php: "instrumentation",
	rust: "instrumentation",
	browser: "browserSdk",
	kubernetes: "kubernetes",
	docker: "docker",
	host: "hosts",
	cloudflare_ai_gateway: "instrumentation",
	claude_code: "agentSessions",
} satisfies Record<PushSourcePlatform, DocsPage>

const docsOf = (platform: PushSourcePlatform) => ({
	label: `${platformMeta(platform).label} setup docs`,
	href: docsUrl(DOCS_PAGE[platform]),
})

/** The first place this platform's data lands. */
const LANDS_IN = {
	browser: { icon: "GlobeIcon", title: "Web Analytics", detail: "Sessions, replays and events" },
	claude_code: { icon: "ClaudeIcon", title: "Agent sessions", detail: "Each session with its usage" },
	kubernetes: { icon: "ServerIcon", title: "Infrastructure", detail: "Nodes, pods and containers" },
	docker: { icon: "ServerIcon", title: "Infrastructure", detail: "Containers on each host" },
	host: { icon: "ServerIcon", title: "Infrastructure", detail: "CPU, memory, disk and network" },
} satisfies Partial<Record<PushSourcePlatform, RailItem>>

const landsIn = (platform: PushSourcePlatform): RailItem =>
	platform === "browser" ||
	platform === "claude_code" ||
	platform === "kubernetes" ||
	platform === "docker" ||
	platform === "host"
		? LANDS_IN[platform]
		: { icon: "LayersIcon", title: "Services", detail: "One row per service.name" }

export const howItWorksRail = (h: H, platform: PushSourcePlatform): Html =>
	flowRail(h, {
		eyebrow: "How this source works",
		items: [
			{
				icon: "PaperPlaneIcon",
				title: "Your app pushes to Maple",
				detail: "Maple never calls into your network",
			},
			{ icon: "GlobeIcon", title: "Endpoint", detail: ingestUrl },
			{ icon: "ConnectionIcon", title: "OTLP over HTTP", detail: "Traces, logs and metrics" },
		],
		trust: "The token can only write to this source, never read. Roll it on the source page to replace it.",
		timeNote: "Takes about 3 minutes",
		docs: docsOf(platform),
	})

export const showsUpRail = (h: H, platform: PushSourcePlatform): Html =>
	flowRail(h, {
		eyebrow: "Where it shows up",
		items: [
			landsIn(platform),
			{
				icon: "ChartLineIcon",
				title: "Explore",
				detail: "Traces, logs and metrics as soon as they arrive",
			},
			{ icon: "GearIcon", title: "Source page", detail: "Rules, Roll token, Pause" },
		],
		timeNote: "Usually under 1 minute",
		docs: docsOf(platform),
	})
