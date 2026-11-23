import { describe, expect, it } from "vitest"
import { classifyServiceIdentity, type ServiceIdentitySignals } from "./service-identity"

// Fingerprints copied from real services (scopes, SDK attributes, span-kind mix), names removed.

const signals = (overrides: Partial<ServiceIdentitySignals>): ServiceIdentitySignals => ({
	scopeNames: [],
	sdkName: "",
	sdkLanguage: "",
	mapleSdkType: "",
	runtimeName: "",
	osName: "",
	serverSpans: 0,
	consumerSpans: 0,
	clientSpans: 0,
	rootSpans: 0,
	classifiedSpans: 0,
	...overrides,
})

const classify = (overrides: Partial<ServiceIdentitySignals>) => {
	const identity = classifyServiceIdentity(signals(overrides))
	return { kind: identity.kind, framework: identity.framework, source: identity.kindSource }
}

describe("classifyServiceIdentity", () => {
	it("names a Next.js app a web app even when its spans are all Internal", () => {
		expect(classify({ scopeNames: ["next.js"], runtimeName: "nodejs", classifiedSpans: 537 })).toEqual({
			kind: "web-app",
			framework: "nextjs",
			source: "framework",
		})
	})

	it("ranks a meta framework over the HTTP libraries under it", () => {
		const identity = classifyServiceIdentity(
			signals({
				scopeNames: [
					"@opentelemetry/instrumentation-http",
					"next.js",
					"@opentelemetry/instrumentation-pg",
				],
				serverSpans: 40,
				classifiedSpans: 100,
			}),
		)
		expect(identity.framework).toBe("nextjs")
	})

	it("reads Effect from the Effect tracer's scope and an Effect API from its Server spans", () => {
		expect(
			classify({
				scopeNames: ["effect"],
				sdkName: "effect",
				sdkLanguage: "nodejs",
				serverSpans: 900,
				clientSpans: 200,
				classifiedSpans: 1200,
			}),
		).toEqual({ kind: "api", framework: "effect", source: "spans" })
	})

	it("reads Effect from Maple's Effect SDK on a Worker, whose scope is the service name", () => {
		const identity = classifyServiceIdentity(
			signals({
				scopeNames: ["maple-api"],
				mapleSdkType: "cloudflare",
				runtimeName: "workerd",
				serverSpans: 10,
				classifiedSpans: 40,
			}),
		)
		expect(identity.framework).toBe("effect")
		expect(identity.evidence).toContainEqual({
			signal: "maple.sdk.type",
			value: "cloudflare",
			supports: "framework",
		})
	})

	it("does not call a Rust service Effect because it stamps maple.sdk.type", () => {
		expect(
			classify({
				scopeNames: ["maple-ingest"],
				sdkName: "opentelemetry",
				sdkLanguage: "rust",
				mapleSdkType: "server",
				runtimeName: "rust",
				serverSpans: 5,
				classifiedSpans: 10,
			}).framework,
		).toBeNull()
	})

	it("ranks Effect over the HTTP framework it serves through", () => {
		expect(
			classify({ scopeNames: ["@hono/otel", "effect"], serverSpans: 1, classifiedSpans: 2 }).framework,
		).toBe("effect")
	})

	it("recognises Go, Ruby, Python and Java frameworks by their instrumentation scope", () => {
		const frameworkOf = (scope: string) =>
			classify({ scopeNames: [scope], serverSpans: 1, classifiedSpans: 1 }).framework
		expect(
			frameworkOf("go.opentelemetry.io/contrib/instrumentation/github.com/gin-gonic/gin/otelgin"),
		).toBe("gin")
		expect(frameworkOf("OpenTelemetry::Instrumentation::ActionView")).toBe("rails")
		expect(frameworkOf("opentelemetry.instrumentation.django")).toBe("django")
		expect(frameworkOf("io.opentelemetry.spring-webmvc-6.0")).toBe("spring")
		expect(frameworkOf("@opentelemetry/instrumentation-nestjs-core")).toBe("nestjs")
		expect(frameworkOf("go.opentelemetry.io/contrib/instrumentation/net/http/otelhttp")).toBe("gohttp")
	})

	it("calls a browser SDK a web frontend and an iOS app a mobile app", () => {
		expect(
			classify({
				scopeNames: ["@opentelemetry/instrumentation-fetch"],
				sdkName: "@maple-dev/browser",
				sdkLanguage: "webjs",
				mapleSdkType: "browser",
				clientSpans: 50,
				classifiedSpans: 50,
			}).kind,
		).toBe("web-frontend")
		expect(
			classify({
				scopeNames: ["dev.maple.tracing"],
				sdkName: "maple-swift",
				sdkLanguage: "swift",
				mapleSdkType: "ios",
				osName: "iOS",
				classifiedSpans: 10,
			}).kind,
		).toBe("mobile-app")
	})

	it("calls a service a queue consumer when Consumer spans outnumber Server spans", () => {
		expect(
			classify({
				scopeNames: ["maple-vcs-sync"],
				consumerSpans: 300,
				serverSpans: 20,
				clientSpans: 900,
				classifiedSpans: 2000,
			}),
		).toEqual({ kind: "worker", framework: null, source: "spans" })
	})

	it("calls a service that only starts its own traces a background worker", () => {
		expect(
			classify({
				scopeNames: ["enrichment-api-tracer"],
				runtimeName: "nodejs",
				rootSpans: 287028,
				classifiedSpans: 287028,
			}).kind,
		).toBe("job")
	})

	it("keeps the span-kind mix unknown on rows written before the counters existed", () => {
		expect(classify({ scopeNames: ["effect"], sdkName: "effect" })).toEqual({
			kind: "unknown",
			framework: "effect",
			source: "none",
		})
	})

	it("names Maple's own CI and uptime callers", () => {
		expect(classify({ scopeNames: ["@maple/ci-traces"], serverSpans: 3, classifiedSpans: 3 }).kind).toBe(
			"ci",
		)
		expect(classify({ scopeNames: ["maple-uptime"], clientSpans: 3, classifiedSpans: 3 }).kind).toBe(
			"synthetic",
		)
	})

	it("lists the other frameworks it found", () => {
		const identity = classifyServiceIdentity(
			signals({
				scopeNames: ["@opentelemetry/instrumentation-express", "effect", "inngest"],
				serverSpans: 1,
				classifiedSpans: 1,
			}),
		)
		expect(identity.framework).toBe("effect")
		expect(identity.alsoUses).toEqual(["express", "inngest"])
	})
})
