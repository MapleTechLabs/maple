// Cards on /docs/instrumentation, grouped by ecosystem. Every entry points at
// a shipping doc page (or a section of one) — this is an inventory of what is
// documented, not a roadmap.
import type { BrandMarkId } from "./brand-marks"
import { languageById, type LanguageId } from "./docs-languages"

export type GuideIcon = { lang: LanguageId } | { mark: BrandMarkId }

export interface GuideCard {
	name: string
	hint: string
	href: string
	icon: GuideIcon
}

export interface GuideSection {
	/** Stable key used by the filter chips and `data-guide-section`. */
	id: string
	/** Section heading — also the chip label unless `chip` is set. */
	title: string
	chip?: string
	cards: GuideCard[]
}

/** Framework guides on /docs/frontend, also listed in the frontend section below. */
export const FRONTEND_GUIDES: readonly GuideCard[] = [
	{
		name: "TanStack Router & Start",
		hint: "Router events, loaders, TanStack Start SSR",
		href: "/docs/frontend/tanstack",
		icon: { mark: "tanstack" },
	},
	{
		name: "React Router",
		hint: "Instrumentation API, data and framework mode",
		href: "/docs/frontend/react-router",
		icon: { mark: "reactrouter" },
	},
	{
		name: "Next.js",
		hint: "App Router navigations, error.tsx, first load",
		href: "/docs/frontend/nextjs",
		icon: { mark: "nextjs" },
	},
	{
		name: "Vue & Nuxt",
		hint: "Vue Router guards, errorHandler, Nitro",
		href: "/docs/frontend/vue",
		icon: { mark: "vue" },
	},
	{
		name: "SvelteKit",
		hint: "Navigation hooks, load, built-in server tracing",
		href: "/docs/frontend/sveltekit",
		icon: { mark: "svelte" },
	},
	{
		name: "Angular",
		hint: "Router events, resolvers, ErrorHandler, SSR",
		href: "/docs/frontend/angular",
		icon: { mark: "angular" },
	},
	{
		name: "Other frameworks",
		hint: "Any router, SPA or multi-page app",
		href: "/docs/frontend/other",
		icon: { mark: "javascript" },
	},
]

const lang = (id: LanguageId, hint?: string, href?: string): GuideCard => {
	const l = languageById(id)
	return { name: l.name, hint: hint ?? l.hint, href: href ?? `/docs/${l.slug}`, icon: { lang: id } }
}

export const GUIDE_SECTIONS: readonly GuideSection[] = [
	{
		id: "javascript",
		title: "JavaScript & TypeScript",
		chip: "JavaScript",
		cards: [
			lang("node"),
			lang("nextjs"),
			lang("effect", "Official SDK · Node, Bun, Deno"),
			{
				name: "Cloudflare Workers",
				hint: "Effect SDK · flush in waitUntil",
				href: "/docs/sdks/effect-cloudflare",
				icon: { mark: "cloudflare" },
			},
			{
				name: "Cloudflare Workers (native)",
				hint: "Any Worker · OTLP destinations, no SDK",
				href: "/docs/guides/instrumentation-cloudflare-workers",
				icon: { mark: "cloudflare" },
			},
			{
				name: "Browser",
				hint: "Traces, errors, session replay",
				href: "/docs/frontend",
				icon: { mark: "javascript" },
			},
		],
	},
	{
		id: "python",
		title: "Python",
		cards: [
			lang("python", "opentelemetry-sdk + auto-instrumentation"),
			{
				...lang(
					"python",
					"ASGI middleware, auto-instrumented routes",
					"/docs/guides/instrumentation-python#fastapi",
				),
				name: "FastAPI",
			},
			{
				...lang(
					"python",
					"Request, ORM and template spans",
					"/docs/guides/instrumentation-python#django",
				),
				name: "Django",
			},
		],
	},
	{
		id: "jvm",
		title: "Java & Kotlin",
		chip: "JVM",
		cards: [
			lang("java", "Java agent (zero-code) or manual SDK"),
			{
				...lang(
					"java",
					"Auto-instrumented with the Java agent",
					"/docs/guides/instrumentation-java#spring-boot",
				),
				name: "Spring Boot",
			},
			lang("kotlin", "Java agent, manual SDK, or the Ktor plugin"),
			{
				...lang("kotlin", "Ktor OpenTelemetry plugin", "/docs/guides/instrumentation-kotlin#ktor"),
				name: "Ktor",
			},
		],
	},
	{
		id: "other",
		title: "Go, Rust, .NET & PHP",
		chip: "Other languages",
		cards: [
			lang("go", "otelhttp, otelgrpc, otelsql"),
			lang("rust", "tracing bridge · Axum, reqwest"),
			lang("csharp", "ASP.NET Core, HttpClient, EF Core"),
			lang("laravel", "PHP · Eloquent, queues, HTTP client"),
		],
	},
	{
		id: "frontend",
		title: "Frontend & product analytics",
		chip: "Frontend",
		cards: [
			...FRONTEND_GUIDES,
			{
				name: "Browser SDK",
				hint: "Every option: sessions, replay, consent",
				href: "/docs/session-replay/browser-sdk",
				icon: { mark: "javascript" },
			},
			lang("effect", "Effect SDK in the browser", "/docs/sdks/effect-client"),
			{
				name: "Product events API",
				hint: "Server-side track() over NDJSON",
				href: "/docs/product-events/api",
				icon: { mark: "webhooks" },
			},
		],
	},
	{
		id: "infrastructure",
		title: "Infrastructure & data sources",
		chip: "Infrastructure",
		cards: [
			{
				name: "Kubernetes",
				hint: "Helm collector · host, kubelet, cluster metrics",
				href: "/docs/infrastructure/kubernetes",
				icon: { mark: "kubernetes" },
			},
			{
				name: "Docker",
				hint: "Single-container agent · per-container stats and logs",
				href: "/docs/infrastructure/docker",
				icon: { mark: "docker" },
			},
			{
				name: "Prometheus",
				hint: "Managed scraping of any /metrics endpoint",
				href: "/docs/integrations/prometheus",
				icon: { mark: "prometheus" },
			},
			{
				name: "OpenTelemetry Collector",
				hint: "Point any OTLP exporter at the ingest endpoint",
				href: "#anything-that-speaks-otlp",
				icon: { mark: "opentelemetry" },
			},
			{
				name: "PlanetScale",
				hint: "One-click org connect · connections, WAL, CPU",
				href: "/docs/integrations/planetscale",
				icon: { mark: "planetscale" },
			},
			{
				name: "WarpStream",
				hint: "Consumer lag, request latency, object-store health",
				href: "/docs/integrations/warpstream",
				icon: { mark: "warpstream" },
			},
			{
				name: "GitHub",
				hint: "Commits alongside your traces",
				href: "/docs/integrations/github",
				icon: { mark: "github" },
			},
		],
	},
]
