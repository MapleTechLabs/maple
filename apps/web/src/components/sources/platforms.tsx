import type { PushSourcePlatform, SourcePlatform } from "@maple/domain/primitives"
import { PULL_SOURCE_PLATFORMS, PUSH_SOURCE_PLATFORMS } from "@maple/domain/primitives"
import {
	ClaudeIcon,
	CloudflareIcon,
	CodeIcon,
	DockerIcon,
	GithubIcon,
	GlobeIcon,
	GoogleCloudIcon,
	KubernetesIcon,
	OpenjdkIcon,
	PlanetScaleIcon,
	PrometheusIcon,
	RailwayIcon,
	RubyIcon,
	RustIcon,
	ServerIcon,
	VercelIcon,
} from "@/components/icons"
import { GoIcon, NodejsIcon, OpenTelemetryIcon, PythonIcon } from "@/components/quick-start/framework-icons"

type PlatformIcon = React.ComponentType<{ size?: number; className?: string }>

export interface PlatformMeta {
	readonly label: string
	readonly description: string
	readonly icon: PlatformIcon
}

export const PLATFORMS = {
	opentelemetry: { label: "OpenTelemetry", description: "Any SDK or collector", icon: OpenTelemetryIcon },
	nodejs: { label: "Node.js", description: "OpenTelemetry Node SDK", icon: NodejsIcon },
	python: { label: "Python", description: "OpenTelemetry Python SDK", icon: PythonIcon },
	go: { label: "Go", description: "OpenTelemetry Go SDK", icon: GoIcon },
	java: { label: "Java", description: "Java agent or SDK", icon: OpenjdkIcon },
	dotnet: { label: ".NET", description: "OpenTelemetry .NET SDK", icon: CodeIcon },
	ruby: { label: "Ruby", description: "OpenTelemetry Ruby SDK", icon: RubyIcon },
	php: { label: "PHP", description: "OpenTelemetry PHP SDK", icon: CodeIcon },
	rust: { label: "Rust", description: "opentelemetry-rust", icon: RustIcon },
	browser: { label: "Browser", description: "Sessions, replays and events", icon: GlobeIcon },
	kubernetes: { label: "Kubernetes", description: "Helm chart for a cluster", icon: KubernetesIcon },
	docker: { label: "Docker", description: "Agent container for a host", icon: DockerIcon },
	host: { label: "Host", description: "Host metrics with a collector", icon: ServerIcon },
	cloudflare_ai_gateway: {
		label: "Cloudflare AI Gateway",
		description: "OTLP export from a gateway",
		icon: CloudflareIcon,
	},
	claude_code: { label: "Claude Code", description: "Agent sessions and usage", icon: ClaudeIcon },
	prometheus: { label: "Prometheus", description: "Scrape a metrics endpoint", icon: PrometheusIcon },
	cloudflare: { label: "Cloudflare", description: "Zone and Workers analytics", icon: CloudflareIcon },
	gcp: { label: "Google Cloud", description: "Logs, metrics and resources", icon: GoogleCloudIcon },
	railway: { label: "Railway", description: "Service metrics", icon: RailwayIcon },
	vercel: { label: "Vercel", description: "Logs, traces and deployments", icon: VercelIcon },
	planetscale: { label: "PlanetScale", description: "Database metrics", icon: PlanetScaleIcon },
	github: { label: "GitHub", description: "Repositories, CI and deploys", icon: GithubIcon },
} satisfies Record<SourcePlatform, PlatformMeta>

export const platformMeta = (platform: SourcePlatform): PlatformMeta => PLATFORMS[platform]

export const PUSH_PLATFORMS: ReadonlyArray<PushSourcePlatform> = PUSH_SOURCE_PLATFORMS
export const PULL_PLATFORMS = PULL_SOURCE_PLATFORMS

/** Source name prefilled on create: the platform label. */
export const defaultSourceName = (platform: PushSourcePlatform) => PLATFORMS[platform].label

/** Icon in a small bordered tile, the same frame the integrations catalog uses. */
export function PlatformTile({ platform, size = "md" }: { platform: SourcePlatform; size?: "sm" | "md" }) {
	const Icon = PLATFORMS[platform].icon
	return (
		<span
			aria-hidden
			className={
				size === "sm"
					? "bg-card inline-flex size-7 shrink-0 items-center justify-center rounded-md border"
					: "bg-card inline-flex size-10 shrink-0 items-center justify-center rounded-lg border"
			}
		>
			<Icon size={size === "sm" ? 14 : 18} />
		</span>
	)
}
