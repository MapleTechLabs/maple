import { Array as Arr, Option } from "effect"
import { describe, expect, test } from "vitest"
import {
	filledSurfaces,
	frameworkOf,
	intentsOf,
	languageDocsOf,
	searchLanguages,
	STACK_LANGUAGE_IDS,
	type StackLanguage,
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
		const infra = Option.getOrUndefined(
			Arr.findFirst(
				filledSurfaces({ languages: [], platforms: ["cloudflare", "supabase"] }),
				(surface) => surface.intent === "infrastructure",
			),
		)
		expect(Arr.map(infra?.sources ?? [], (source) => source.label)).toEqual(["Cloudflare", "Supabase"])
	})

	test("the checklist opens on the first language, or OpenTelemetry for a platform-only stack", () => {
		expect(frameworkOf({ languages: ["python", "nodejs"], platforms: [] })).toBe("python")
		expect(frameworkOf({ languages: [], platforms: ["docker"] })).toBe("otel")
	})

	test("each language opens the setup it documents, and only Bun falls back to OpenTelemetry", () => {
		const opens = (language: StackLanguage) => frameworkOf({ languages: [language], platforms: [] })
		expect(opens("browser")).toBe("browser")
		expect(opens("kotlin")).toBe("java")
		expect(opens("php")).toBe("laravel")
		expect(opens("ruby")).toBe("ruby")
		expect(opens("deno")).toBe("deno")
		// Bun is not Node: the Node setup starts the app with `node --require`.
		expect(opens("bun")).toBe("otel")
		expect(languageDocsOf({ languages: ["php"], platforms: [] })?.page).toBe("laravelGuide")
		expect(Arr.filter(STACK_LANGUAGE_IDS, (language) => opens(language) === "otel")).toEqual([
			"bun",
			"otel",
		])
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
