import type { SourcePlatform } from "@maple/primitives"
import type { Html, HtmlBuilder } from "foldkit/html"
import { icon, type IconName } from "@maple/views/ui/icon"
import { type ProviderId, PROVIDERS } from "../../kit/providers"

export interface PlatformMeta {
	readonly label: string
	readonly description: string
	readonly icon: IconName
}

/** An integration platform's tile: the provider's name and mark, with Sources' own line. */
const provider = (id: ProviderId, description: string): PlatformMeta => ({
	label: PROVIDERS[id].name,
	description,
	icon: PROVIDERS[id].icon,
})

export const PLATFORMS = {
	opentelemetry: {
		label: "OpenTelemetry",
		description: "Any SDK or collector",
		icon: "FrameworkOpenTelemetryIcon",
	},
	nodejs: { label: "Node.js", description: "OpenTelemetry Node SDK", icon: "FrameworkNodejsIcon" },
	python: { label: "Python", description: "OpenTelemetry Python SDK", icon: "FrameworkPythonIcon" },
	go: { label: "Go", description: "OpenTelemetry Go SDK", icon: "FrameworkGoIcon" },
	java: { label: "Java", description: "Java agent or SDK", icon: "OpenjdkIcon" },
	dotnet: { label: ".NET", description: "OpenTelemetry .NET SDK", icon: "CsharpIcon" },
	ruby: { label: "Ruby", description: "OpenTelemetry Ruby SDK", icon: "RubyIcon" },
	php: { label: "PHP", description: "OpenTelemetry PHP SDK", icon: "FileCodeIcon" },
	rust: { label: "Rust", description: "OpenTelemetry Rust SDK", icon: "RustIcon" },
	browser: { label: "Browser", description: "Sessions, replays and events", icon: "GlobeIcon" },
	kubernetes: { label: "Kubernetes", description: "Helm chart for a cluster", icon: "KubernetesIcon" },
	docker: { label: "Docker", description: "Agent container for a host", icon: "DockerIcon" },
	host: { label: "Host", description: "Host metrics with a collector", icon: "ServerIcon" },
	cloudflare_ai_gateway: {
		label: "Cloudflare AI Gateway",
		description: "OTLP export from a gateway",
		icon: "CloudflareBrandIcon",
	},
	claude_code: { label: "Claude Code", description: "Agent sessions and usage", icon: "ClaudeIcon" },
	prometheus: provider("prometheus", "Scrape a metrics endpoint"),
	cloudflare: provider("cloudflare", "Zone and Workers analytics"),
	gcp: provider("gcp", "Logs, metrics and resources"),
	aws: provider("aws", "A read-only role in an account"),
	railway: provider("railway", "Service metrics"),
	vercel: provider("vercel", "Logs, traces and deployments"),
	planetscale: provider("planetscale", "Database metrics"),
	github: provider("github", "Repositories, CI and deploys"),
	supabase: provider("supabase", "Project and Postgres metrics"),
} as const satisfies Record<SourcePlatform, PlatformMeta>

export const platformMeta = (platform: SourcePlatform): PlatformMeta => PLATFORMS[platform]

/** Source name prefilled on create: the platform label. */
export const defaultSourceName = (platform: SourcePlatform): string => PLATFORMS[platform].label

/** A source's mark in a small bordered tile, the same frame the integrations catalog uses. */
export const platformTile = <M>(h: HtmlBuilder<M>, meta: PlatformMeta, size: "sm" | "md" = "md"): Html =>
	h.span(
		[
			h.AriaHidden(true),
			h.Class(
				size === "sm"
					? "bg-card inline-flex size-7 shrink-0 items-center justify-center rounded-md border"
					: "bg-card inline-flex size-10 shrink-0 items-center justify-center rounded-lg border",
			),
		],
		[icon(h, meta.icon, { size: size === "sm" ? 14 : 18 })],
	)
