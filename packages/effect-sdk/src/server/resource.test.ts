import { ConfigProvider, Effect } from "effect"
import { describe, expect, it } from "vitest"
import { resolveResource, resolveResourceFromEnv } from "./resource.js"

const endpointFor = (env: Record<string, string>, config: Parameters<typeof resolveResource>[0]) =>
	Effect.runPromise(
		resolveResource(config).pipe(
			Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromEnv({ env })),
			Effect.map((resolved) => resolved.endpoint),
		),
	)

describe("resolveResource endpoint", () => {
	it("defaults to the US ingest", async () => {
		expect(await endpointFor({}, {})).toBe("https://ingest.maple.dev")
	})

	it("uses the EU ingest for region eu, from config or MAPLE_REGION", async () => {
		expect(await endpointFor({}, { region: "eu" })).toBe("https://ingest.eu.maple.dev")
		expect(await endpointFor({ MAPLE_REGION: "EU" }, {})).toBe("https://ingest.eu.maple.dev")
	})

	it("lets an endpoint from any source beat a region from any source", async () => {
		// The k8s chart injects a collector endpoint; a region in code must not bypass it.
		expect(
			await endpointFor({ OTEL_EXPORTER_OTLP_ENDPOINT: "http://agent:4318" }, { region: "eu" }),
		).toBe("http://agent:4318")
		expect(await endpointFor({ MAPLE_REGION: "eu" }, { endpoint: "https://proxy.test/" })).toBe(
			"https://proxy.test",
		)
	})
})

describe("resolveResourceFromEnv endpoint", () => {
	it("resolves the region from config or env.MAPLE_REGION", () => {
		expect(resolveResourceFromEnv({}, { region: "eu" }).endpoint).toBe("https://ingest.eu.maple.dev")
		expect(resolveResourceFromEnv({ MAPLE_REGION: "eu" }, {}).endpoint).toBe(
			"https://ingest.eu.maple.dev",
		)
		expect(
			resolveResourceFromEnv({ MAPLE_ENDPOINT: "https://collector.test", MAPLE_REGION: "eu" }, {})
				.endpoint,
		).toBe("https://collector.test")
	})
})
