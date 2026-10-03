import { describe, expect, it } from "vitest"

/**
 * Both SDKs bundle this package, so it stays neutral: no Effect (the browser
 * SDK's eager chunk), no OpenTelemetry (the Effect SDK never ships it), no rrweb
 * (only the lazy replay chunk may). The root is also bundled server-side, so it stays DOM-free.
 */
declare global {
	interface ImportMeta {
		glob: (
			pattern: string,
			options: { query: "?raw"; import: "default"; eager: true },
		) => Record<string, string>
	}
}

const sources = import.meta.glob("./**/*.ts", { query: "?raw", import: "default", eager: true })

const files = Object.keys(sources)
	.map((key) => key.replace(/^\.\//, ""))
	.filter((file) => !file.endsWith(".test.ts"))
	.sort()

/** Every module specifier, whether imported, re-exported, dynamically imported or required, in either quote style. */
const specifiers = (file: string): string[] =>
	[...(sources[`./${file}`] ?? "").matchAll(/(?:\bfrom|\bimport|\brequire)\s*\(?\s*["']([^"']+)["']/g)].map(
		(m) => m[1] ?? "",
	)

const isRuntime = (s: string): boolean =>
	s === "effect" ||
	s.startsWith("effect/") ||
	s.startsWith("@opentelemetry/") ||
	s === "rrweb" ||
	s.startsWith("rrweb-") ||
	s.startsWith("@rrweb/") ||
	// The replay entry pulls rrweb in; only an SDK's lazy chunk may import it.
	s === "@maple/browser-session/replay"

/** Browser globals the root tier must not touch: the Effect SDK's server presets bundle it. */
const DOM_GLOBALS = /\b(?:window|document|navigator|location|localStorage|indexedDB)\s*[.[]/

/** Source with comments and string literals blanked, so `"window.onerror"` as a label is not a use. */
const codeOnly = (source: string): string =>
	source
		.replace(/\/\*[\s\S]*?\*\//g, "")
		.replace(/\/\/.*$/gm, "")
		.replace(/"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`/g, '""')

describe("module layout", () => {
	it("sees the source tree", () => {
		expect(files.length).toBeGreaterThan(10)
		expect(files).toContain("browser/web-vitals.ts")
	})

	it("imports no SDK runtime and nothing that reaches rrweb", () => {
		const offenders = files.flatMap((file) =>
			specifiers(file)
				.filter(isRuntime)
				.map((s) => `${file} → ${s}`),
		)
		expect(offenders).toEqual([])
	})

	it("keeps the root tier free of the DOM tier", () => {
		const root = files.filter((file) => !file.startsWith("browser/"))
		const imports = root.flatMap((file) =>
			specifiers(file)
				.filter(
					(s) =>
						s.startsWith("./browser") ||
						s.startsWith("@maple/browser-session") ||
						s === "web-vitals",
				)
				.map((s) => `${file} → ${s}`),
		)
		const globals = root.filter((file) => DOM_GLOBALS.test(codeOnly(sources[`./${file}`] ?? "")))
		expect(imports).toEqual([])
		expect(globals).toEqual([])
	})
})
