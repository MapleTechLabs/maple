import type { FrameworkId } from "../components/quick-start/sdk-snippets"
import type { IconName } from "../ui/icon"
import type { DocsPage } from "./docs"
import { ONBOARDING_INTENT_IDS, type OnboardingIntent } from "./onboarding-intent"

// The onboarding stack step: what the user runs, and which of Maple's surfaces each pick fills.

export const STACK_LANGUAGE_IDS = [
	"nodejs",
	"browser",
	"python",
	"go",
	"java",
	"nextjs",
	"dotnet",
	"php",
	"ruby",
	"rust",
	"kotlin",
	"effect",
	"bun",
	"deno",
	"otel",
] as const
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
	nextjs: {
		label: "Next.js",
		description: "App Router",
		icon: "FrameworkNextjsIcon",
		fills: CODE_FILLS,
	},
	dotnet: { label: ".NET", description: "ASP.NET Core", icon: "CsharpIcon", fills: CODE_FILLS },
	php: { label: "PHP", description: "Laravel", icon: "LaravelIcon", fills: CODE_FILLS },
	ruby: { label: "Ruby", description: "Rails, Sinatra", icon: "RubyIcon", fills: CODE_FILLS },
	kotlin: { label: "Kotlin", description: "Ktor, Spring", icon: "KotlinIcon", fills: CODE_FILLS },
	bun: { label: "Bun", description: "Elysia, Hono", icon: "BunIcon", fills: CODE_FILLS },
	deno: { label: "Deno", description: "Built-in OTel", icon: "DenoIcon", fills: CODE_FILLS },
	effect: {
		label: "Effect",
		description: "Maple's own SDK",
		icon: "FrameworkEffectIcon",
		fills: CODE_FILLS,
	},
	otel: {
		label: "Other",
		description: "Any OTel SDK",
		icon: "FrameworkOpenTelemetryIcon",
		fills: CODE_FILLS,
	},
} as const satisfies Record<StackLanguage, StackItem>

/** Other names people search for: languages, frameworks and runtimes each card covers. */
const STACK_LANGUAGE_ALIASES = {
	nodejs: "javascript typescript express fastify hono nestjs",
	browser: "javascript typescript react vue svelte angular frontend web vitals replay",
	python: "flask celery",
	go: "golang grpc gin echo",
	java: "spring boot quarkus micronaut",
	nextjs: "react vercel",
	dotnet: "c# csharp asp.net",
	php: "laravel symfony wordpress",
	ruby: "rails sinatra sidekiq",
	rust: "axum tokio actix",
	kotlin: "ktor android jvm",
	effect: "typescript",
	bun: "javascript typescript elysia",
	deno: "javascript typescript fresh",
	otel: "opentelemetry otlp collector elixir erlang swift c++ cpp scala",
} as const satisfies Record<StackLanguage, string>

/** The languages a search matches by name, description or alias, in the grid's order. */
export const searchLanguages = (query: string): ReadonlyArray<StackLanguage> => {
	const words = query
		.toLowerCase()
		.trim()
		.split(/\s+/)
		.filter((word) => word !== "")
	return STACK_LANGUAGE_IDS.filter((id) => {
		const item = STACK_LANGUAGES[id]
		const haystack = `${item.label} ${item.description} ${STACK_LANGUAGE_ALIASES[id]}`.toLowerCase()
		return words.every((word) => haystack.includes(word))
	})
}

/** The instrumentation guide the connect step links to for each language. */
export const STACK_LANGUAGE_DOCS = {
	nodejs: { label: "Node.js", page: "nodejsGuide" },
	browser: { label: "Browser", page: "browserSdk" },
	python: { label: "Python", page: "pythonGuide" },
	go: { label: "Go", page: "goGuide" },
	java: { label: "Java", page: "javaGuide" },
	rust: { label: "Rust", page: "rustGuide" },
	nextjs: { label: "Next.js", page: "nextjsGuide" },
	dotnet: { label: ".NET", page: "dotnetGuide" },
	php: { label: "Laravel", page: "laravelGuide" },
	ruby: { label: "OpenTelemetry", page: "instrumentation" },
	kotlin: { label: "Kotlin", page: "kotlinGuide" },
	bun: { label: "OpenTelemetry", page: "instrumentation" },
	deno: { label: "OpenTelemetry", page: "instrumentation" },
	effect: { label: "Effect", page: "effectSdk" },
	otel: { label: "OpenTelemetry", page: "instrumentation" },
} as const satisfies Record<StackLanguage, Readonly<{ label: string; page: DocsPage }>>

/** The guide for the first language picked, matching the snippet `frameworkOf` opens on. */
export const languageDocsOf = (
	answers: StackAnswers,
): Readonly<{ label: string; page: DocsPage }> | undefined => {
	const first = answers.languages[0]
	return first === undefined ? undefined : STACK_LANGUAGE_DOCS[first]
}

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
	nextjs: "nextjs",
	kotlin: "otel",
	bun: "otel",
	deno: "otel",
	dotnet: "otel",
	php: "otel",
	ruby: "otel",
	effect: "effect",
	otel: "otel",
} as const satisfies Record<StackLanguage, FrameworkId>

/** The setup snippet the checklist opens on: the first language picked, else OpenTelemetry for a platform-only stack. */
export const frameworkOf = (answers: StackAnswers): FrameworkId | null => {
	const first = answers.languages[0]
	if (first !== undefined) return FRAMEWORK_OF[first]
	return answers.platforms.length > 0 ? "otel" : null
}

export const toggled = <A>(items: ReadonlyArray<A>, item: A): ReadonlyArray<A> =>
	items.includes(item) ? items.filter((candidate) => candidate !== item) : [...items, item]
