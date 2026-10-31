import { describe, expect, it } from "vitest"
import { detectCloudflareWorker, detectPlatform } from "./cloud-platform"

const workerSpan = {
	"cloud.platform": "cloudflare.workers",
	"cloudflare.script_name": "maple-api",
	"cloudflare.script_version.id": "4f1c2a9e-7b3d-4e8a-9c21-0d5e6f7a8b9c",
	"cloudflare.handler_type": "fetch",
	"cloudflare.execution_model": "stateless",
	"cloudflare.colo": "ORD",
	"faas.invoked_region": "ENAM",
	"geo.locality.name": "Chicago",
	"geo.country.code": "US",
	cpu_time_ms: "3",
	wall_time_ms: "41.5",
	"cloudflare.response.time_to_first_byte_ms": "39",
	"cloudflare.outcome": "ok",
	"cloudflare.ray_id": "8d2f1a3b4c5d6e7f",
}

describe("detectPlatform", () => {
	it("summarizes a native Workers span with numeric timings", () => {
		expect(detectPlatform(workerSpan)).toEqual({
			_tag: "cloudflare",
			scriptName: "maple-api",
			scriptVersion: "4f1c2a9e-7b3d-4e8a-9c21-0d5e6f7a8b9c",
			handler: "fetch",
			executionModel: "stateless",
			colo: "ORD",
			region: "ENAM",
			city: "Chicago",
			countryCode: "US",
			cpuTimeMs: 3,
			wallTimeMs: 41.5,
			ttfbMs: 39,
			outcome: "ok",
			rayId: "8d2f1a3b4c5d6e7f",
		})
	})

	it("keeps zero timings and leaves missing fields absent", () => {
		const summary = detectPlatform({
			"cloud.platform": "cloudflare.workers",
			cpu_time_ms: "0",
			wall_time_ms: "0",
		})
		expect(summary).toEqual({ _tag: "cloudflare", cpuTimeMs: 0, wallTimeMs: 0 })
	})

	it("drops a timing that is not a number instead of inventing one", () => {
		expect(detectPlatform({ "cloudflare.ray_id": "abc", cpu_time_ms: "n/a" })).toEqual({
			_tag: "cloudflare",
			rayId: "abc",
		})
	})

	it("does not flag a span whose projected cloudflare.* keys are all empty", () => {
		const projected = {
			"http.route": "/orders",
			"cloud.platform": "",
			"cloudflare.colo": "",
			"cloudflare.outcome": "  ",
			"faas.invoked_region": "",
		}
		expect(detectPlatform(projected)).toBeUndefined()
	})

	it("reads Cloudflare context from resource attributes", () => {
		expect(
			detectPlatform(
				{ "http.route": "/orders", cpu_time_ms: "7" },
				{ "cloud.platform": "cloudflare.workers", "faas.name": "maple-api", "faas.version": "v42" },
			),
		).toEqual({ _tag: "cloudflare", scriptName: "maple-api", scriptVersion: "v42", cpuTimeMs: 7 })
	})

	it("prefers the span value over the resource value for the same key", () => {
		const summary = detectPlatform(
			{ "cloudflare.colo": "AMS", "cloudflare.script_name": "" },
			{ "cloudflare.colo": "ORD", "cloudflare.script_name": "maple-api" },
		)
		expect(summary).toMatchObject({ colo: "AMS", scriptName: "maple-api" })
	})

	it("summarizes any other cloud/FaaS span from OpenTelemetry semantics", () => {
		expect(
			detectPlatform(
				{ "faas.coldstart": "true", "faas.invocation_id": "req-1" },
				{
					"cloud.provider": "aws",
					"cloud.platform": "aws_lambda",
					"cloud.region": "eu-west-1",
					"faas.name": "checkout",
					"faas.version": "$LATEST",
				},
			),
		).toEqual({
			_tag: "cloud",
			provider: "aws",
			platform: "aws_lambda",
			region: "eu-west-1",
			functionName: "checkout",
			functionVersion: "$LATEST",
			coldStart: true,
			invocationId: "req-1",
		})
	})

	it("does not place a client span on the function it invoked", () => {
		const client = {
			"faas.invoked_name": "checkout",
			"faas.invoked_provider": "aws",
			"faas.invoked_region": "us-east-1",
		}
		expect(detectPlatform(client, { "service.name": "web" })).toBeUndefined()
	})

	it("takes cloud.* from the resource and ignores a span's cloud.region from an SDK call", () => {
		expect(
			detectPlatform(
				{ "cloud.region": "us-east-1", "rpc.service": "DynamoDB" },
				{ "cloud.provider": "gcp", "cloud.platform": "gcp_cloud_run" },
			),
		).toEqual({ _tag: "cloud", provider: "gcp", platform: "gcp_cloud_run" })
	})

	it("returns nothing for a span with no platform attributes", () => {
		expect(detectPlatform({ "http.route": "/orders" }, { "service.name": "api" })).toBeUndefined()
	})
})

describe("detectCloudflareWorker", () => {
	it("ignores non-Cloudflare cloud spans", () => {
		expect(detectCloudflareWorker({ "cloud.provider": "aws", "faas.name": "checkout" })).toBeUndefined()
	})
})
