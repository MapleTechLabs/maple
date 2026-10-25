import { describe, expect, test } from "vitest"
import {
	filledSurfaces,
	frameworkOf,
	intentsOf,
	languageDocsOf,
	searchLanguages,
	toggled,
} from "./onboarding-stack"

describe("onboarding stack", () => {
	test("nothing picked fills nothing", () => {
		expect(filledSurfaces({ languages: [], platforms: [] })).toEqual([])
		expect(frameworkOf({ languages: [], platforms: [] })).toBeNull()
	})

	test("a backend and a browser app fill traces, errors and replays, with Alerts on top", () => {
		expect(intentsOf({ languages: ["nodejs", "browser"], platforms: [] })).toEqual([
			"traces",
			"logs",
			"errors",
			"replays",
			"service_map",
			"alerts",
		])
	})

	test("each surface names the picks that fill it", () => {
		const infra = filledSurfaces({ languages: [], platforms: ["cloudflare", "supabase"] }).find(
			(surface) => surface.intent === "infrastructure",
		)
		expect(infra?.sources.map((source) => source.label)).toEqual(["Cloudflare", "Supabase"])
	})

	test("the checklist opens on the first language, or OpenTelemetry for a platform-only stack", () => {
		expect(frameworkOf({ languages: ["python", "nodejs"], platforms: [] })).toBe("python")
		expect(frameworkOf({ languages: [], platforms: ["docker"] })).toBe("otel")
	})

	test("a language without its own snippet opens on OpenTelemetry and links the overview guide", () => {
		const ruby = { languages: ["ruby"], platforms: [] } as const
		expect(frameworkOf(ruby)).toBe("otel")
		expect(languageDocsOf(ruby)?.page).toBe("instrumentation")
		// Bun is not Node: the Node snippet starts the app with `node --import`.
		expect(frameworkOf({ languages: ["bun"], platforms: [] })).toBe("otel")
		expect(frameworkOf({ languages: ["effect"], platforms: [] })).toBe("effect")
	})

	test("language search matches names, frameworks and aliases", () => {
		expect(searchLanguages("c#")).toEqual(["dotnet"])
		expect(searchLanguages("Rails")).toEqual(["ruby"])
		expect(searchLanguages("elixir")).toEqual(["otel"])
		expect(searchLanguages("cobol")).toEqual([])
		expect(searchLanguages("  ")).toHaveLength(15)
	})

	test("toggling adds a pick once and removes it again", () => {
		expect(toggled(toggled(["go"], "rust"), "go")).toEqual(["rust"])
	})
})
