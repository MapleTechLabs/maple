import type { FrameworkId } from "../components/quick-start/sdk-snippets"
import type { IconName } from "../ui/icon"
import { ONBOARDING_INTENT_IDS, type OnboardingIntent } from "./onboarding-intent"

// The onboarding stack step: what the user runs, and which of Maple's surfaces each pick fills.

export const STACK_LANGUAGE_IDS = ["nodejs", "browser", "python", "go", "java", "rust"] as const
export type StackLanguage = (typeof STACK_LANGUAGE_IDS)[number]

export const STACK_PLATFORM_IDS = [
	"cloudflare",
	"supabase",
	"railway",
	"aws",
	"gcp",
	"planetscale",
	"kubernetes",
	"docker",
	"prometheus",
] as const
export type StackPlatform = (typeof STACK_PLATFORM_IDS)[number]

export type StackItem = Readonly<{
	label: string
	description: string
	icon: IconName
	/** The sidebar surfaces this pick sends data to. */
	fills: ReadonlyArray<OnboardingIntent>
}>

const CODE_FILLS: ReadonlyArray<OnboardingIntent> = ["traces", "service_map", "errors", "logs"]

export const STACK_LANGUAGES = {
	nodejs: { label: "Node.js", description: "Backend APIs", icon: "FrameworkNodejsIcon", fills: CODE_FILLS },
	browser: {
		label: "Browser",
		description: "Web frontend",
		icon: "GlobeIcon",
		fills: ["replays", "errors", "traces"],
	},
	python: {
		label: "Python",
		description: "Django, FastAPI",
		icon: "FrameworkPythonIcon",
		fills: CODE_FILLS,
	},
	go: { label: "Go", description: "Services, CLIs", icon: "FrameworkGoIcon", fills: CODE_FILLS },
	java: { label: "Java", description: "Spring, JVM", icon: "OpenjdkIcon", fills: CODE_FILLS },
	rust: { label: "Rust", description: "Axum, Tokio", icon: "RustIcon", fills: CODE_FILLS },
} as const satisfies Record<StackLanguage, StackItem>

export const STACK_PLATFORMS = {
	cloudflare: {
		label: "Cloudflare",
		description: "Workers, zones",
		icon: "CloudflareBrandIcon",
		fills: ["infrastructure", "logs"],
	},
	supabase: {
		label: "Supabase",
		description: "Postgres, logs",
		icon: "SupabaseIcon",
		fills: ["infrastructure", "logs"],
	},
	railway: {
		label: "Railway",
		description: "CPU, memory",
		icon: "RailwayIcon",
		fills: ["infrastructure", "metrics"],
	},
	aws: { label: "AWS", description: "CloudWatch", icon: "AwsIcon", fills: ["infrastructure", "metrics"] },
	gcp: {
		label: "Google Cloud",
		description: "Logging, monitoring",
		icon: "GoogleCloudIcon",
		fills: ["logs", "metrics"],
	},
	planetscale: {
		label: "PlanetScale",
		description: "Branch insights",
		icon: "PlanetScaleIcon",
		fills: ["infrastructure"],
	},
	kubernetes: {
		label: "Kubernetes",
		description: "Helm chart",
		icon: "KubernetesIcon",
		fills: ["infrastructure", "metrics"],
	},
	docker: {
		label: "Docker",
		description: "Containers",
		icon: "DockerIcon",
		fills: ["infrastructure", "metrics"],
	},
	prometheus: {
		label: "Prometheus",
		description: "Scrape an endpoint",
		icon: "PrometheusIcon",
		fills: ["metrics"],
	},
} as const satisfies Record<StackPlatform, StackItem>

export type StackAnswers = Readonly<{
	languages: ReadonlyArray<StackLanguage>
	platforms: ReadonlyArray<StackPlatform>
}>

/** One surface the picks fill, with the picks that fill it, in the sidebar's order. */
export type FilledSurface = Readonly<{ intent: OnboardingIntent; sources: ReadonlyArray<StackItem> }>

/** What the stack fills: every surface any pick sends data to, plus Alerts, which works on all of it. */
export const filledSurfaces = (answers: StackAnswers): ReadonlyArray<FilledSurface> => {
	const picks: ReadonlyArray<StackItem> = [
		...answers.languages.map((id) => STACK_LANGUAGES[id]),
		...answers.platforms.map((id) => STACK_PLATFORMS[id]),
	]
	if (picks.length === 0) return []
	return ONBOARDING_INTENT_IDS.flatMap((intent): ReadonlyArray<FilledSurface> => {
		const sources = picks.filter((pick) => pick.fills.includes(intent))
		return sources.length > 0 || intent === "alerts" ? [{ intent, sources }] : []
	})
}

/** The surfaces, as the setup checklist's intents. */
export const intentsOf = (answers: StackAnswers): ReadonlyArray<OnboardingIntent> =>
	filledSurfaces(answers).map((surface) => surface.intent)

const FRAMEWORK_OF = {
	nodejs: "nodejs",
	browser: "nextjs",
	python: "python",
	go: "go",
	java: "otel",
	rust: "otel",
} as const satisfies Record<StackLanguage, FrameworkId>

/** The setup snippet the checklist opens on: the first language picked, else OpenTelemetry for a platform-only stack. */
export const frameworkOf = (answers: StackAnswers): FrameworkId | null => {
	const first = answers.languages[0]
	if (first !== undefined) return FRAMEWORK_OF[first]
	return answers.platforms.length > 0 ? "otel" : null
}

export const toggled = <A>(items: ReadonlyArray<A>, item: A): ReadonlyArray<A> =>
	items.includes(item) ? items.filter((candidate) => candidate !== item) : [...items, item]
