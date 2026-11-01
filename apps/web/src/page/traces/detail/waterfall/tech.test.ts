import { describe, expect, test } from "vitest"
import { serviceRuntime, spanTech } from "./tech"

describe("spanTech", () => {
	test("names the system a span called, by its brand where there is one", () => {
		expect(spanTech({ "db.system.name": "postgresql" })).toMatchObject({
			icon: "PostgresIcon",
			label: "PostgreSQL",
		})
		expect(spanTech({ "db.system": "redis" })).toMatchObject({ icon: "RedisIcon", label: "Redis" })
		expect(spanTech({ "messaging.system": "kafka" })).toMatchObject({ icon: "KafkaIcon", label: "Kafka" })
		expect(spanTech({ "rpc.system": "grpc" })).toMatchObject({ icon: "ConnectionIcon", label: "gRPC" })
	})

	test("an LLM call beats the transport it went over, and the model vendor picks the mark", () => {
		expect(
			spanTech({ "gen_ai.provider.name": "anthropic", "http.request.method": "POST" }),
		).toMatchObject({ icon: "AnthropicIcon" })
		expect(spanTech({ "gen_ai.system": "gcp.vertex_ai" })).toMatchObject({
			icon: "GoogleIcon",
			label: "LLM call · Vertex AI",
		})
		expect(spanTech({ "gen_ai.provider.name": "openai" })).toMatchObject({ label: "LLM call · OpenAI" })
		expect(spanTech({ "gen_ai.provider.name": "some-new-lab" })).toMatchObject({
			icon: "ChatBubbleSparkleIcon",
			label: "LLM call · Some New Lab",
		})
	})

	test("a database beats a queue or RPC system on the same span", () => {
		expect(spanTech({ "db.system.name": "postgresql", "messaging.system": "kafka" })).toMatchObject({
			icon: "PostgresIcon",
		})
		expect(spanTech({ "db.system": "dynamodb", "rpc.system": "aws-api" })).toMatchObject({
			icon: "DatabaseIcon",
		})
	})

	test("an unknown system keeps a generic glyph and a readable name", () => {
		expect(spanTech({ "messaging.system": "cloud_tasks" })).toMatchObject({
			icon: "PaperPlaneIcon",
			label: "Cloud Tasks",
		})
	})

	test("system values match whatever their case or padding", () => {
		expect(spanTech({ "messaging.system": " Kafka " })).toMatchObject({ icon: "KafkaIcon" })
		expect(spanTech({ "db.system.name": "PostgreSQL" })).toMatchObject({ icon: "PostgresIcon" })
	})

	test("a span that names no system, or only blank ones, gets no mark", () => {
		expect(spanTech({})).toBeNull()
		expect(
			spanTech({ "http.request.method": "GET", "db.system.name": "", "messaging.system": " " }),
		).toBeNull()
	})
})

describe("serviceRuntime", () => {
	test("the Effect SDK wins and names the runtime it ran on", () => {
		expect(
			serviceRuntime({ "telemetry.sdk.name": "effect", "process.runtime.name": "bun" }),
		).toMatchObject({ icon: "EffectIcon", label: "Effect on Bun" })
		expect(serviceRuntime({ "telemetry.sdk.name": "@maple-dev/effect-sdk" })).toMatchObject({
			icon: "EffectIcon",
			label: "Effect",
		})
	})

	test("the runtime name beats the SDK language, which is the fallback", () => {
		expect(
			serviceRuntime({ "process.runtime.name": "bun", "telemetry.sdk.language": "nodejs" }),
		).toMatchObject({ icon: "BunIcon", label: "Bun" })
		expect(serviceRuntime({ "telemetry.sdk.language": "python" })).toMatchObject({
			icon: "PythonIcon",
			label: "Python",
		})
	})

	test("a runtime name with no glyph falls back to the SDK language", () => {
		expect(
			serviceRuntime({ "process.runtime.name": "pypy", "telemetry.sdk.language": "python" }),
		).toMatchObject({ icon: "PythonIcon" })
	})

	test("a runtime with no glyph, or no runtime at all, gets no mark", () => {
		expect(serviceRuntime({ "telemetry.sdk.language": "go" })).toBeNull()
		expect(serviceRuntime({ "telemetry.sdk.language": "webjs" })).toBeNull()
		expect(serviceRuntime({})).toBeNull()
	})
})
