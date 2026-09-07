import { describe, expect, it } from "vitest"
import { detectAiModel } from "./detect"

describe("detectAiModel", () => {
	it("resolves an OpenRouter id, variant and all", () => {
		const detected = detectAiModel("z-ai/glm-5.3-flash:nitro")
		expect(detected).toMatchObject({
			slug: "glm-5.3-flash:nitro",
			normalizedSlug: "glm-5.3-flash",
			openRouterId: "z-ai/glm-5.3-flash",
			displayName: "GLM 5.3 Flash",
			vendorSlug: "z-ai",
			vendorName: "Z.ai",
			family: null,
			source: "openrouter",
		})
	})

	it("resolves the model segment alone, and ignores case", () => {
		expect(detectAiModel("glm-5.3-flash:nitro").openRouterId).toBe("z-ai/glm-5.3-flash")
		expect(detectAiModel("GPT-4o").openRouterId).toBe("openai/gpt-4o")
	})

	it("maps a provider's raw dated id onto OpenRouter's spelling", () => {
		expect(detectAiModel("claude-sonnet-4-5-20250929")).toMatchObject({
			normalizedSlug: "claude-sonnet-4.5",
			openRouterId: "anthropic/claude-sonnet-4.5",
			displayName: "Claude Sonnet 4.5",
			vendorSlug: "anthropic",
			family: "claude",
			source: "openrouter",
		})
		expect(detectAiModel("gpt-4.1-mini-2025-04-14").openRouterId).toBe("openai/gpt-4.1-mini")
		expect(detectAiModel("gemini-2.5-flash-preview-04-17").openRouterId).toBe("google/gemini-2.5-flash")
		expect(detectAiModel("mistral-large-latest").openRouterId).toBe("mistralai/mistral-large")
	})

	it("keeps a dated id OpenRouter lists as its own snapshot", () => {
		expect(detectAiModel("gpt-4o-2024-08-06").normalizedSlug).toBe("gpt-4o-2024-08-06")
	})

	it("strips gateway decoration: LiteLLM paths, Bedrock ids, Vertex publisher paths", () => {
		expect(detectAiModel("openrouter/anthropic/claude-3.5-sonnet")).toMatchObject({
			vendorSlug: "anthropic",
			normalizedSlug: "claude-3.5-sonnet",
		})
		expect(detectAiModel("us.anthropic.claude-3-5-sonnet-20241022-v2:0")).toMatchObject({
			vendorSlug: "anthropic",
			normalizedSlug: "claude-3.5-sonnet",
			displayName: "Claude 3.5 Sonnet",
			family: "claude",
		})
		expect(detectAiModel("bedrock/meta.llama3-1-70b-instruct-v1:0").openRouterId).toBe(
			"meta-llama/llama-3.1-70b-instruct",
		)
		expect(detectAiModel("publishers/google/models/gemini-2.5-pro").openRouterId).toBe(
			"google/gemini-2.5-pro",
		)
	})

	it("places an unlisted model with its vendor by prefix", () => {
		expect(detectAiModel("llama3.1:8b")).toMatchObject({
			slug: "llama3.1:8b",
			vendorSlug: "meta-llama",
			vendorName: "Meta",
			family: "llama",
			source: "heuristic",
		})
		expect(detectAiModel("grok-4")).toMatchObject({
			vendorSlug: "x-ai",
			vendorName: "xAI",
			family: "grok",
		})
		expect(detectAiModel("gemini-1.5-pro-002").displayName).toBe("Gemini 1.5 Pro")
	})

	it("gives an unrecognised string a readable name and nothing else", () => {
		expect(detectAiModel("  my-azure-deployment ")).toEqual({
			model: "my-azure-deployment",
			slug: "my-azure-deployment",
			normalizedSlug: "my-azure-deployment",
			openRouterId: null,
			displayName: "My Azure Deployment",
			vendorSlug: null,
			vendorName: null,
			family: null,
			source: "unknown",
		})
	})
})
