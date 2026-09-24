import { describe, expect, it } from "vitest"
import { detectAiModel } from "./detect"

describe("detectAiModel", () => {
	it("resolves an OpenRouter id, variant and all", () => {
		const detected = detectAiModel("z-ai/glm-5.3-flash:nitro")
		expect(detected).toMatchObject({
			slug: "glm-5.3-flash:nitro",
			normalizedSlug: "glm-5.3-flash",
			openRouterId: "z-ai/glm-5.3-flash",
			displayName: "GLM 5.3 Flash (nitro)",
			vendorSlug: "z-ai",
			vendorName: "Z.ai",
			// A vendor the catalog lists no color for.
			brandColor: null,
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
			brandColor: { light: "#D97757", dark: "#D97757" },
			family: "claude",
			source: "openrouter",
		})
		expect(detectAiModel("gpt-4.1-mini-2025-04-14").openRouterId).toBe("openai/gpt-4.1-mini")
		expect(detectAiModel("gemini-2.5-flash-preview-04-17").openRouterId).toBe("google/gemini-2.5-flash")
		expect(detectAiModel("mistral-large-latest").openRouterId).toBe("mistralai/mistral-large")
	})

	it("keeps an explicit vendor even when the segment names another vendor's model", () => {
		expect(detectAiModel("anthropic/gpt-4o")).toMatchObject({
			vendorSlug: "anthropic",
			openRouterId: null,
			source: "heuristic",
		})
		// A dated provider id under its own vendor still resolves.
		expect(detectAiModel("anthropic/claude-sonnet-4-5-20250929").openRouterId).toBe(
			"anthropic/claude-sonnet-4.5",
		)
		expect(detectAiModel("openai/gpt-5-2025-08-07").openRouterId).toBe("openai/gpt-5")
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
		// The vendor is not the segment next to the model on Vertex; an unlisted
		// model still gets it from the path.
		expect(detectAiModel("publishers/google/models/text-bison-001")).toMatchObject({
			vendorSlug: "google",
			source: "heuristic",
		})
		expect(detectAiModel("eu.anthropic.claude-3-5-sonnet-20241022-v2:0").vendorSlug).toBe("anthropic")
		expect(detectAiModel("us-gov.amazon.nova-pro-v1:0")).toMatchObject({
			vendorSlug: "amazon",
			slug: "nova-pro",
		})
	})

	it("keeps a rolling alias's id as OpenRouter serves it, and names it without the vendor", () => {
		expect(detectAiModel("claude-sonnet-latest")).toMatchObject({
			openRouterId: "~anthropic/claude-sonnet-latest",
			vendorSlug: "anthropic",
		})
	})

	it("names a variant after its plain listing, and keeps the variant", () => {
		expect(detectAiModel("anthropic/claude-opus-5:batch").displayName).toBe("Claude Opus 5 (batch)")
		expect(detectAiModel("z-ai/glm-5.3-flash:free").displayName).toBe("GLM 5.3 Flash (free)")
		// The plain listing keeps the plain name, so the two never collide.
		expect(detectAiModel("z-ai/glm-5.3-flash").displayName).toBe("GLM 5.3 Flash")
	})

	it("keeps an Ollama size tag, and reads a Bedrock version as no tag at all", () => {
		expect(detectAiModel("llama3.1:8b").displayName).toBe("Llama 3.1 (8b)")
		expect(detectAiModel("us.anthropic.claude-opus-5-20250929-v1:0").displayName).toBe("Claude Opus 5")
	})

	it("places an unlisted model with its vendor by prefix", () => {
		expect(detectAiModel("llama3.1:8b")).toMatchObject({
			slug: "llama3.1:8b",
			vendorSlug: "meta-llama",
			vendorName: "Meta",
			family: null,
			source: "heuristic",
		})
		expect(detectAiModel("grok-4")).toMatchObject({
			vendorSlug: "x-ai",
			vendorName: "xAI",
			// A heuristic vendor carries its color too; xAI's mark is monochrome.
			brandColor: { light: "#000000", dark: "#FFFFFF" },
			family: "grok",
		})
		expect(detectAiModel("gemini-1.5-pro-002").displayName).toBe("Gemini 1.5 Pro")
		expect(detectAiModel("palmyra-fin-70b").vendorSlug).toBe("writer")
		expect(detectAiModel("phind-codellama-34b").vendorSlug).not.toBe("microsoft")
	})

	it("derives a readable name from a slug", () => {
		expect(detectAiModel("deepseek-r1-70b-custom").displayName).toBe("Deepseek R1 70B Custom")
		expect(detectAiModel("o9-mini-turbo-custom").displayName).toBe("o9 Mini Turbo Custom")
		expect(detectAiModel("glm-9-air-custom").displayName).toBe("GLM 9 Air Custom")
	})

	it("never throws: prototype keys and punctuation are unknown models", () => {
		// An unknown path segment is ignored like any other gateway prefix.
		expect(detectAiModel("__proto__/gpt-4o")).toMatchObject({
			vendorSlug: "openai",
			source: "openrouter",
		})
		for (const input of ["constructor/foo", "constructor.foo", "__proto__/foo", "-", "anthropic/"]) {
			const detected = detectAiModel(input)
			expect(detected.source).toBe("unknown")
			expect(detected.brandColor).toBeNull()
			expect(typeof detected.vendorName === "string" || detected.vendorName === null).toBe(true)
			expect(detected.displayName.length).toBeGreaterThan(0)
		}
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
			brandColor: null,
			family: null,
			source: "unknown",
		})
	})
})
