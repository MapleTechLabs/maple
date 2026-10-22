import type { PushSourcePlatform, SourcePlatform } from "@maple/domain/primitives"
import { PUSH_SOURCE_PLATFORMS } from "@maple/domain/primitives"
import type { Html, HtmlBuilder } from "foldkit/html"
import { icon, type IconName } from "../../../ui/icon"

// `PLATFORMS`, `PlatformTile`.

export interface PlatformMeta {
	readonly label: string
	readonly description: string
	readonly icon: IconName
}

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
	dotnet: { label: ".NET", description: "OpenTelemetry .NET SDK", icon: "CodeIcon" },
	ruby: { label: "Ruby", description: "OpenTelemetry Ruby SDK", icon: "RubyIcon" },
	php: { label: "PHP", description: "OpenTelemetry PHP SDK", icon: "CodeIcon" },
	rust: { label: "Rust", description: "opentelemetry-rust", icon: "RustIcon" },
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
	prometheus: { label: "Prometheus", description: "Scrape a metrics endpoint", icon: "PrometheusIcon" },
	cloudflare: {
		label: "Cloudflare",
		description: "Zone and Workers analytics",
		icon: "CloudflareBrandIcon",
	},
	gcp: { label: "Google Cloud", description: "Logs, metrics and resources", icon: "GoogleCloudIcon" },
	aws: { label: "AWS", description: "A read-only role in an account", icon: "AwsIcon" },
	railway: { label: "Railway", description: "Service metrics", icon: "RailwayIcon" },
	planetscale: { label: "PlanetScale", description: "Database metrics", icon: "PlanetScaleIcon" },
	github: { label: "GitHub", description: "Repositories, CI and deploys", icon: "GithubIcon" },
	supabase: { label: "Supabase", description: "Project and Postgres metrics", icon: "SupabaseIcon" },
} as const satisfies Record<SourcePlatform, PlatformMeta>

export const platformMeta = (platform: SourcePlatform): PlatformMeta => PLATFORMS[platform]

export const PUSH_PLATFORMS: ReadonlyArray<PushSourcePlatform> = PUSH_SOURCE_PLATFORMS

/** Source name prefilled on create: the platform label. */
export const defaultSourceName = (platform: PushSourcePlatform): string => PLATFORMS[platform].label

/** Icon in a small bordered tile, the same frame the integrations catalog uses. */
export const platformTile = <M>(
	h: HtmlBuilder<M>,
	platform: SourcePlatform,
	size: "sm" | "md" = "md",
): Html =>
	h.span(
		[
			h.AriaHidden(true),
			h.Class(
				size === "sm"
					? "bg-card inline-flex size-7 shrink-0 items-center justify-center rounded-md border"
					: "bg-card inline-flex size-10 shrink-0 items-center justify-center rounded-lg border",
			),
		],
		[icon(h, PLATFORMS[platform].icon, { size: size === "sm" ? 14 : 18 })],
	)
