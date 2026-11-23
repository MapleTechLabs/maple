import { Array as Arr, Option, Order, Record as Rec, Schema, String as Str } from "effect"
// What kind of service something is (web app, API, worker...) and which framework it is built on,
// from instrumentation scope names, SDK resource attributes and its span-kind mix. Pure, so the
// API, Maple Local and the web bundle share it.

export const SERVICE_KINDS = {
	"web-frontend": "Web frontend",
	"mobile-app": "Mobile app",
	"web-app": "Web app",
	api: "API",
	worker: "Queue consumer",
	job: "Background worker",
	ci: "CI pipeline",
	synthetic: "Synthetic check",
	unknown: "Service",
} as const

export type ServiceKind = keyof typeof SERVICE_KINDS

/** Earlier tiers win: a Next.js app that also loads Effect is a Next.js app. */
type FrameworkTier = "meta" | "app" | "http" | "jobs" | "generic"

interface FrameworkInfo {
	readonly label: string
	readonly tier: FrameworkTier
	/** Matched against lowercased instrumentation scope names. */
	readonly scopes: ReadonlyArray<RegExp>
	/** Matched against lowercased `telemetry.sdk.name`. */
	readonly sdkNames?: ReadonlyArray<string>
}

export const FRAMEWORKS = {
	nextjs: { label: "Next.js", tier: "meta", scopes: [/^next\.js$/] },
	astro: { label: "Astro", tier: "meta", scopes: [/^@astroscope\//, /^astro$/] },
	sveltekit: { label: "SvelteKit", tier: "meta", scopes: [/^@sveltejs\/kit/] },
	nuxt: { label: "Nuxt", tier: "meta", scopes: [/^nuxt/] },
	remix: { label: "Remix", tier: "meta", scopes: [/^@remix-run\//, /instrumentation-remix$/] },
	nestjs: { label: "NestJS", tier: "app", scopes: [/instrumentation-nestjs-core$/] },
	effect: {
		label: "Effect",
		tier: "app",
		scopes: [/^effect$/, /^@effect\/opentelemetry$/],
		sdkNames: ["effect", "@effect/opentelemetry", "@maple-dev/effect-sdk"],
	},
	rails: {
		label: "Rails",
		tier: "app",
		scopes: [/^opentelemetry::instrumentation::(rails|actionpack|actionview|activerecord|activejob)$/],
	},
	django: { label: "Django", tier: "app", scopes: [/^opentelemetry\.instrumentation\.django$/] },
	spring: { label: "Spring", tier: "app", scopes: [/^io\.opentelemetry\.spring/] },
	hono: { label: "Hono", tier: "http", scopes: [/^@hono\/otel$/, /instrumentation-hono$/] },
	express: { label: "Express", tier: "http", scopes: [/instrumentation-express$/] },
	fastify: { label: "Fastify", tier: "http", scopes: [/^@fastify\/otel$/, /instrumentation-fastify$/] },
	koa: { label: "Koa", tier: "http", scopes: [/instrumentation-koa$/] },
	elysia: { label: "Elysia", tier: "http", scopes: [/^elysia$/, /^@elysiajs\//] },
	fastapi: { label: "FastAPI", tier: "http", scopes: [/^opentelemetry\.instrumentation\.fastapi$/] },
	flask: { label: "Flask", tier: "http", scopes: [/^opentelemetry\.instrumentation\.flask$/] },
	gin: { label: "Gin", tier: "http", scopes: [/\/otelgin$/] },
	echo: { label: "Echo", tier: "http", scopes: [/\/otelecho$/] },
	fiber: { label: "Fiber", tier: "http", scopes: [/\/otelfiber(\/v\d+)?$/] },
	aspnetcore: { label: "ASP.NET Core", tier: "http", scopes: [/^microsoft\.aspnetcore/] },
	celery: { label: "Celery", tier: "jobs", scopes: [/^opentelemetry\.instrumentation\.celery$/] },
	sidekiq: { label: "Sidekiq", tier: "jobs", scopes: [/^opentelemetry::instrumentation::sidekiq$/] },
	inngest: { label: "Inngest", tier: "jobs", scopes: [/^inngest$/] },
	bullmq: { label: "BullMQ", tier: "jobs", scopes: [/bullmq$/] },
	pgboss: { label: "pg-boss", tier: "jobs", scopes: [/^pg-boss$/] },
	gohttp: { label: "Go net/http", tier: "generic", scopes: [/\/otelhttp$/] },
	rack: { label: "Rack", tier: "generic", scopes: [/^opentelemetry::instrumentation::rack$/] },
} as const satisfies Record<string, FrameworkInfo>

export type ServiceFramework = keyof typeof FRAMEWORKS

const TIER_ORDER: ReadonlyArray<FrameworkTier> = ["meta", "app", "http", "jobs", "generic"]

export interface ServiceIdentitySignals {
	readonly scopeNames: ReadonlyArray<string>
	readonly sdkName: string
	readonly sdkLanguage: string
	readonly mapleSdkType: string
	readonly runtimeName: string
	readonly osName: string
	readonly serverSpans: number
	readonly consumerSpans: number
	readonly clientSpans: number
	readonly rootSpans: number
	/** Spans counted by the span-kind columns; 0 means the window predates them, so the mix is unknown. */
	readonly classifiedSpans: number
}

const ServiceKindSchema = Schema.Literals(Rec.keys(SERVICE_KINDS))
const ServiceFrameworkSchema = Schema.Literals(Rec.keys(FRAMEWORKS))

/** `sdk`: the service's SDK says so. `framework`: implied by the framework. `spans`: inferred from its span kinds. */
export const ServiceIdentitySource = Schema.Literals(["sdk", "framework", "spans", "none"])
export type ServiceIdentitySource = typeof ServiceIdentitySource.Type

export const ServiceIdentityEvidence = Schema.Struct({
	signal: Schema.String,
	value: Schema.String,
	supports: Schema.Literals(["kind", "framework"]),
})
export type ServiceIdentityEvidence = typeof ServiceIdentityEvidence.Type

export const ServiceIdentity = Schema.Struct({
	kind: ServiceKindSchema,
	kindSource: ServiceIdentitySource,
	framework: Schema.NullOr(ServiceFrameworkSchema),
	/** Other frameworks found on the service, in tier order. */
	alsoUses: Schema.Array(ServiceFrameworkSchema),
	evidence: Schema.Array(ServiceIdentityEvidence),
})
export type ServiceIdentity = typeof ServiceIdentity.Type

const lower = (value: string) => Str.toLowerCase(Str.trim(value))

const MOBILE_OS = new Set(["ios", "ipados", "android", "watchos", "tvos", "visionos"])
const MOBILE_SDK_TYPES = new Set(["ios", "android", "react-native", "flutter"])
const MOBILE_LANGUAGES = new Set(["swift"])
const BROWSER_SDK_TYPES = new Set(["browser", "client"])
const BROWSER_SCOPES = [
	/instrumentation-document-load$/,
	/instrumentation-user-interaction$/,
	/^maple-browser$/,
]
// Maple's Effect SDK stamps `maple.sdk.type` but not always `telemetry.sdk.name`.
const MAPLE_EFFECT_SDK_TYPES = new Set(["server", "cloudflare", "client"])
const JS_RUNTIMES = new Set(["nodejs", "node", "bun", "deno", "workerd", "edge", "edge-light"])
const JS_LANGUAGES = new Set(["nodejs", "webjs", "js", "javascript", "typescript"])

interface FrameworkMatch {
	readonly framework: ServiceFramework
	readonly evidence: ServiceIdentityEvidence
}

const matchFramework = (
	id: ServiceFramework,
	scopes: ReadonlyArray<string>,
	signals: ServiceIdentitySignals,
): Option.Option<FrameworkMatch> => {
	const info: FrameworkInfo = FRAMEWORKS[id]
	const scope = Arr.findFirst(scopes, (name) =>
		Arr.some(info.scopes, (pattern) => pattern.test(lower(name))),
	)
	if (Option.isSome(scope)) {
		return Option.some({
			framework: id,
			evidence: { signal: "instrumentation scope", value: scope.value, supports: "framework" },
		})
	}
	const sdkName = lower(signals.sdkName)
	if (sdkName !== "" && info.sdkNames?.includes(sdkName) === true) {
		return Option.some({
			framework: id,
			evidence: { signal: "telemetry.sdk.name", value: signals.sdkName, supports: "framework" },
		})
	}
	const jsService =
		JS_RUNTIMES.has(lower(signals.runtimeName)) || JS_LANGUAGES.has(lower(signals.sdkLanguage))
	if (id === "effect" && jsService && MAPLE_EFFECT_SDK_TYPES.has(lower(signals.mapleSdkType))) {
		return Option.some({
			framework: id,
			evidence: { signal: "maple.sdk.type", value: signals.mapleSdkType, supports: "framework" },
		})
	}
	return Option.none()
}

const share = (part: number, whole: number) => `${Math.round((part / Math.max(whole, 1)) * 100)}%`

export function classifyServiceIdentity(signals: ServiceIdentitySignals): ServiceIdentity {
	const scopes = Arr.filter(signals.scopeNames, (name) => name !== "")
	const matches = Arr.getSomes(Arr.map(Rec.keys(FRAMEWORKS), (id) => matchFramework(id, scopes, signals)))
	const ranked = Arr.sort(
		matches,
		Order.mapInput(Order.Number, (m: FrameworkMatch) => TIER_ORDER.indexOf(FRAMEWORKS[m.framework].tier)),
	)
	const primary = Arr.head(ranked)
	const framework = Option.getOrNull(Option.map(primary, (m) => m.framework))
	const tier = Option.getOrNull(Option.map(primary, (m) => FRAMEWORKS[m.framework].tier))
	const frameworkEvidence = Arr.map(ranked, (m) => m.evidence)
	const alsoUses = Arr.map(Arr.drop(ranked, 1), (m) => m.framework)

	const result = (
		kind: ServiceKind,
		kindSource: ServiceIdentitySource,
		kindEvidence: ReadonlyArray<ServiceIdentityEvidence>,
	): ServiceIdentity => ({
		kind,
		kindSource,
		framework,
		alsoUses,
		evidence: [...frameworkEvidence, ...kindEvidence],
	})
	const kindBy = (signal: string, value: string): ReadonlyArray<ServiceIdentityEvidence> => [
		{ signal, value, supports: "kind" },
	]

	const lowerScopes = Arr.map(scopes, lower)
	if (lowerScopes.includes("@maple/ci-traces"))
		return result("ci", "sdk", kindBy("instrumentation scope", "@maple/ci-traces"))
	if (lowerScopes.includes("maple-uptime"))
		return result("synthetic", "sdk", kindBy("instrumentation scope", "maple-uptime"))

	const osName = lower(signals.osName)
	if (MOBILE_OS.has(osName)) return result("mobile-app", "sdk", kindBy("os.name", signals.osName))
	const mapleSdkType = lower(signals.mapleSdkType)
	if (MOBILE_SDK_TYPES.has(mapleSdkType))
		return result("mobile-app", "sdk", kindBy("maple.sdk.type", signals.mapleSdkType))
	if (MOBILE_LANGUAGES.has(lower(signals.sdkLanguage)))
		return result("mobile-app", "sdk", kindBy("telemetry.sdk.language", signals.sdkLanguage))

	if (BROWSER_SDK_TYPES.has(mapleSdkType))
		return result("web-frontend", "sdk", kindBy("maple.sdk.type", signals.mapleSdkType))
	if (lower(signals.sdkLanguage) === "webjs")
		return result("web-frontend", "sdk", kindBy("telemetry.sdk.language", signals.sdkLanguage))
	const browserScope = Arr.findFirst(scopes, (name) =>
		Arr.some(BROWSER_SCOPES, (pattern) => pattern.test(lower(name))),
	)
	if (Option.isSome(browserScope))
		return result("web-frontend", "sdk", kindBy("instrumentation scope", browserScope.value))

	const { serverSpans, consumerSpans, rootSpans, classifiedSpans } = signals
	if (tier === "meta") return result("web-app", "framework", [])
	if (classifiedSpans === 0)
		return tier === "jobs" ? result("worker", "framework", []) : result("unknown", "none", [])

	if (consumerSpans > 0 && consumerSpans >= serverSpans)
		return result(
			"worker",
			"spans",
			kindBy("span kinds", `${share(consumerSpans, classifiedSpans)} Consumer`),
		)
	if (serverSpans > 0)
		return result("api", "spans", kindBy("span kinds", `${share(serverSpans, classifiedSpans)} Server`))
	if (tier === "jobs") return result("worker", "framework", [])
	if (rootSpans > 0)
		return result(
			"job",
			"spans",
			kindBy("span kinds", "no inbound Server or Consumer spans; starts its own traces"),
		)
	return result("unknown", "none", [])
}
