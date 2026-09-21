/**
 * The `./manifests` subpath is data, and stays data.
 *
 * The dashboard imports it to draw a card for every connector this build ships. Everything else in
 * this package is host code — an install flow with an HTTP client, a gateway state machine, an
 * outbound transport — and none of it belongs in a browser bundle. The separation is one
 * `import type` away from collapsing, silently, into a web build that pulls a protocol
 * implementation to render an icon.
 *
 * So the check is the module graph itself: follow every VALUE import from the subpath and assert
 * nothing outside the allowed set is reachable. Type-only imports are skipped because they are
 * erased, which is exactly what makes them safe here.
 */
import { existsSync, readFileSync } from "node:fs"
import { dirname, join, relative, resolve, sep } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

const srcRoot = fileURLToPath(new URL(".", import.meta.url))

/**
 * Packages the dashboard already bundles. A new one here is a real decision: it lands in the web
 * build for every viewer of the integrations page.
 */
const ALLOWED_PACKAGES = ["effect", "@maple/primitives"]

/**
 * Modules in this package the subpath may pull at runtime, as a rule rather than a list — a
 * connector directory may not be named here any more than anywhere else above one.
 *
 * Two shared modules, and from each registered connector its id and its manifest. A connector's
 * install flow, gateway or transport reaching this graph fails, which is the point.
 */
const CONNECTOR_MODULE = /^connectors\/[^/]+\/(id|manifest)\.ts$/
const isAllowedModule = (module: string): boolean =>
	module === "connector.ts" || module === "connectors/manifests.ts" || CONNECTOR_MODULE.test(module)

const VALUE_IMPORT = /^\s*import\s+(type\s+)?[^"']*from\s+["']([^"']+)["']/gm

const resolveLocal = (from: string, specifier: string): string | undefined => {
	const base = resolve(dirname(from), specifier.replace(/\.ts$/, ""))
	return [`${base}.ts`, join(base, "index.ts")].find((candidate) => existsSync(candidate))
}

describe("the manifests subpath stays web-safe", () => {
	it("pulls no host code and no unexpected package", () => {
		const visited = new Set<string>()
		const packages = new Set<string>()
		const visit = (file: string): void => {
			if (visited.has(file)) return
			visited.add(file)
			for (const match of readFileSync(file, "utf8").matchAll(VALUE_IMPORT)) {
				// Erased at build time, so it reaches no bundle.
				if (match[1] !== undefined) continue
				const specifier = match[2] ?? ""
				if (!specifier.startsWith(".")) {
					packages.add(specifier)
					continue
				}
				const local = resolveLocal(file, specifier)
				if (local !== undefined) visit(local)
			}
		}
		visit(join(srcRoot, "connectors", "manifests.ts"))

		const offenders = [...visited]
			.map((file) => relative(srcRoot, file).split(sep).join("/"))
			.filter((module) => !isAllowedModule(module))
			.sort()

		expect(offenders).toEqual([])
		expect([...packages].sort()).toEqual([...ALLOWED_PACKAGES].sort())
		// A graph that resolved nothing would satisfy every assertion above it.
		expect(visited.size).toBeGreaterThan(1)
	})
})
