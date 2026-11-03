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

describe("service identity from OTEL_RESOURCE_ATTRIBUTES", () => {
	const resolved = (env: Record<string, string>) =>
		Effect.runPromise(
			resolveResource({}).pipe(
				Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromEnv({ env })),
			),
		)

	it("names the service from service.name when OTEL_SERVICE_NAME is unset", async () => {
		const env = { OTEL_RESOURCE_ATTRIBUTES: "service.name=checkout,service.version=1.4.0" }
		expect((await resolved(env)).resource).toMatchObject({
			serviceName: "checkout",
			serviceVersion: "1.4.0",
		})
		expect(resolveResourceFromEnv(env, {}).resource).toMatchObject({
			serviceName: "checkout",
			serviceVersion: "1.4.0",
		})
	})

	it("lets OTEL_SERVICE_NAME override service.name", async () => {
		const env = { OTEL_RESOURCE_ATTRIBUTES: "service.name=checkout", OTEL_SERVICE_NAME: "payments" }
		expect((await resolved(env)).resource.serviceName).toBe("payments")
		expect(resolveResourceFromEnv(env, {}).resource.serviceName).toBe("payments")
	})

	it("lets explicit attributes beat the env and emits each identity key once", async () => {
		const env = { OTEL_RESOURCE_ATTRIBUTES: "service.name=checkout,service.version=1.0" }
		const attributes = { "service.name": "billing", "service.version": "2.0" }
		const fromConfig = await Effect.runPromise(
			resolveResource({ attributes }).pipe(
				Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromEnv({ env })),
			),
		)
		for (const { resource } of [fromConfig, resolveResourceFromEnv(env, { attributes })]) {
			expect(resource).toMatchObject({ serviceName: "billing", serviceVersion: "2.0" })
			expect(resource.attributes["service.name"]).toBeUndefined()
			expect(resource.attributes["service.version"]).toBeUndefined()
		}
	})
})

describe("vcs.ref.head.revision from serviceVersion", () => {
	const revision = (serviceVersion: string) =>
		resolveResourceFromEnv({}, { serviceVersion }).resource.attributes["vcs.ref.head.revision"]

	it("stamps a SHA-shaped version and skips build numbers and semver", () => {
		expect(revision("a1b2c3d")).toBe("a1b2c3d")
		expect(revision("20261103")).toBeUndefined()
		expect(revision("1.4.0")).toBeUndefined()
	})
})
