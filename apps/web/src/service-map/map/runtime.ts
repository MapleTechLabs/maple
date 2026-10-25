import type { ServicePlatform } from "@maple/ui/components/service-map/service-map-types"
import type { IconName } from "../../ui/icon"

// copied: packages/ui/src/components/service-map/service-map-runtime.ts with the icon as a name
// (the original imports React icon components); the 3D mark paths stay in the original.

export interface RuntimeGlyph {
	readonly icon: IconName | null
	readonly short: string
	readonly full: string
}

export function resolveRuntimeGlyph(rt: string): RuntimeGlyph | null {
	const key = rt.trim().toLowerCase()
	if (key.startsWith("openjdk") || key === "jvm" || key === "java")
		return { icon: "OpenjdkMonoIcon", short: "jvm", full: "JVM" }
	if (key.startsWith(".net") || key === "dotnet" || key === "coreclr")
		return { icon: null, short: "dotnet", full: ".NET" }
	switch (key) {
		case "nodejs":
		case "node":
			return { icon: "NodejsMonoIcon", short: "node", full: "Node.js" }
		case "bun":
			return { icon: "BunIcon", short: "bun", full: "Bun" }
		case "deno":
			return { icon: "DenoIcon", short: "deno", full: "Deno" }
		case "workerd":
			return { icon: "CloudflareMonoIcon", short: "workerd", full: "Cloudflare workerd" }
		case "rust":
			return { icon: "RustIcon", short: "rust", full: "Rust" }
		case "go":
		case "golang":
			return { icon: null, short: "go", full: "Go" }
		case "python":
		case "cpython":
			return { icon: "PythonIcon", short: "python", full: "Python" }
		case "ruby":
		case "cruby":
			return { icon: "RubyIcon", short: "ruby", full: "Ruby" }
		case "php":
			return { icon: null, short: "php", full: "PHP" }
		case "edge-light":
			return { icon: null, short: "edge", full: "Edge runtime" }
		case "fastly":
			return { icon: null, short: "fastly", full: "Fastly Compute" }
		default:
			return null
	}
}

/** The runtime the platform icon already implies is dropped rather than drawn twice. */
export function formatRuntime(
	rt: string | undefined,
	platform: ServicePlatform | undefined,
): RuntimeGlyph | null {
	if (!rt) return null
	if (platform === "cloudflare" && rt.toLowerCase() === "workerd") return null
	return resolveRuntimeGlyph(rt) ?? { icon: null, short: rt, full: rt }
}
