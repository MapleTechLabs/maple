// Runtime posture for the Security Center's Runtimes tab: which language runtime a service reports
// (`process.runtime.*`, `telemetry.sdk.language`) and how its version stands against the release
// cycles endoflife.date publishes. Pure, so the web bundle and the API share it.

export interface RuntimeProductInfo {
	readonly label: string
	/** The product's id on endoflife.date. */
	readonly endoflifeSlug: string
	/** Compare against the cycle's latest patch. Off where the catalog tracks one vendor of many. */
	readonly patchTracking: boolean
}

export const RUNTIME_PRODUCTS = {
	nodejs: { label: "Node.js", endoflifeSlug: "nodejs", patchTracking: true },
	python: { label: "Python", endoflifeSlug: "python", patchTracking: true },
	go: { label: "Go", endoflifeSlug: "go", patchTracking: true },
	// Eclipse Temurin's support dates stand in for OpenJDK; other vendors ship their own patches.
	java: { label: "Java", endoflifeSlug: "eclipse-temurin", patchTracking: false },
	dotnet: { label: ".NET", endoflifeSlug: "dotnet", patchTracking: true },
	ruby: { label: "Ruby", endoflifeSlug: "ruby", patchTracking: true },
	php: { label: "PHP", endoflifeSlug: "php", patchTracking: true },
	bun: { label: "Bun", endoflifeSlug: "bun", patchTracking: true },
	deno: { label: "Deno", endoflifeSlug: "deno", patchTracking: true },
} as const satisfies Record<string, RuntimeProductInfo>

export type RuntimeProduct = keyof typeof RUNTIME_PRODUCTS

const BY_RUNTIME_NAME: ReadonlyArray<readonly [RegExp, RuntimeProduct]> = [
	[/^node(js)?$/, "nodejs"],
	[/^bun$/, "bun"],
	[/^deno$/, "deno"],
	[/^(cpython|python)$/, "python"],
	[/^go$/, "go"],
	[/(openjdk|java\(tm\)|java)/, "java"],
	[/^\.net( core)?$/, "dotnet"],
	[/^ruby$/, "ruby"],
	[/^php$/, "php"],
]

// PHP reports its SAPI (`cli`, `fpm-fcgi`) as the runtime name, so its SDK language decides. Any
// other unrecognized name (JRuby, .NET Framework, PyPy) stays untracked rather than guessed.
const BY_SDK_LANGUAGE = new Map<string, RuntimeProduct>([
	["python", "python"],
	["go", "go"],
	["java", "java"],
	["dotnet", "dotnet"],
	["ruby", "ruby"],
	["php", "php"],
])

/** Runtimes with no version to check, named so the UI can say so instead of "unknown". */
const UNVERSIONED_RUNTIMES = new Set(["workerd", "edge-light", "fastly", "netlify", "browser", "webjs"])

/** Runtimes that run Node.js code and report themselves as `nodejs` through the stock OTel SDK. */
const NODE_EMULATORS = new Map<string, RuntimeProduct>([
	["bun", "bun"],
	["deno", "deno"],
])

/** The product a service runs on, undefined when Maple does not track it. */
export function runtimeProductOf(runtimeName: string, sdkLanguage: string): RuntimeProduct | undefined {
	const name = runtimeName.trim().toLowerCase()
	if (UNVERSIONED_RUNTIMES.has(name)) return undefined
	const byName = BY_RUNTIME_NAME.find(([pattern]) => pattern.test(name))
	if (byName !== undefined) return byName[1]
	const language = sdkLanguage.trim().toLowerCase()
	// A Node.js SDK may run on Bun or Deno, so `nodejs` only counts with the runtime name above.
	return name === "" || language === "php" ? BY_SDK_LANGUAGE.get(language) : undefined
}

/**
 * The dotted numeric version, undefined when there is none: `v22.1.0` and `go1.22.1` drop their
 * prefix, Java's `17.0.9+9` its build, and `1.8.0_392` and `8u392-b08` become `8.0.392`.
 */
export function normalizeRuntimeVersion(raw: string): string | undefined {
	const java8 = /^1\.(\d+)\.(\d+)_(\d+)/.exec(raw.trim())
	if (java8 !== null) return `${java8[1]}.${java8[2]}.${java8[3]}`
	const update = /^(\d+)u(\d+)/.exec(raw.trim())
	if (update !== null) return `${update[1]}.0.${update[2]}`
	const match = /(\d+(?:\.\d+)*)/.exec(raw.trim().replace(/^(v|go)/i, ""))
	return match?.[1]
}

const parts = (version: string) => version.split(".").map((part) => Number.parseInt(part, 10))

/** Numeric dotted comparison; a missing segment counts as 0. */
export function compareVersions(a: string, b: string): number {
	const left = parts(a)
	const right = parts(b)
	const differences = Array.from(
		{ length: Math.max(left.length, right.length) },
		(_, index) => (left[index] ?? 0) - (right[index] ?? 0),
	)
	return Math.sign(differences.find((difference) => difference !== 0) ?? 0)
}

export interface RuntimeRelease {
	/** The release cycle, `22` for Node.js, `3.12` for Python. */
	readonly cycle: string
	readonly isEol: boolean
	/** `YYYY-MM-DD`, null when no date is announced. */
	readonly eolFrom: string | null
	/** The cycle's latest version, null when unknown. */
	readonly latest: string | null
}

/** The cycle a version belongs to: the longest cycle that prefixes it on a segment boundary. */
export function releaseCycleOf(
	releases: ReadonlyArray<RuntimeRelease>,
	version: string,
): RuntimeRelease | undefined {
	return releases
		.filter((release) => version === release.cycle || version.startsWith(`${release.cycle}.`))
		.reduce<RuntimeRelease | undefined>(
			(best, release) =>
				best === undefined || release.cycle.length > best.cycle.length ? release : best,
			undefined,
		)
}

export type RuntimePosture =
	/** No `process.runtime.*` Maple can check, e.g. Cloudflare Workers. */
	| { readonly status: "untracked" }
	/** The runtime is known but the service sends no `process.runtime.version`. */
	| { readonly status: "no_version"; readonly product: RuntimeProduct }
	/** Bun or Deno reporting itself as Node.js: its version is the Node.js compatibility level. */
	| { readonly status: "emulated"; readonly product: RuntimeProduct; readonly version: string }
	/** The release data could not be read. */
	| { readonly status: "catalog_unavailable"; readonly product: RuntimeProduct; readonly version: string }
	/** The version matches no published cycle (a pre-release or a vendor build). */
	| { readonly status: "unknown_cycle"; readonly product: RuntimeProduct; readonly version: string }
	| {
			readonly status: "end_of_life" | "behind" | "supported"
			readonly product: RuntimeProduct
			readonly version: string
			readonly cycle: string
			readonly eolFrom: string | null
			readonly latest: string | null
	  }

/** How a reported runtime stands. `releases` is undefined when the catalog could not be read. */
export function runtimePosture(
	input: {
		readonly runtimeName: string
		readonly runtimeVersion: string
		readonly sdkLanguage: string
		/** `process.executable.name`, which tells Bun and Deno apart from Node.js. */
		readonly executableName?: string
	},
	releasesFor: (product: RuntimeProduct) => ReadonlyArray<RuntimeRelease> | undefined,
): RuntimePosture {
	const product = runtimeProductOf(input.runtimeName, input.sdkLanguage)
	if (product === undefined) return { status: "untracked" }
	const version = normalizeRuntimeVersion(input.runtimeVersion)
	const emulator = NODE_EMULATORS.get((input.executableName ?? "").trim().toLowerCase())
	if (product === "nodejs" && emulator !== undefined) {
		return { status: "emulated", product: emulator, version: version ?? "" }
	}
	if (version === undefined) return { status: "no_version", product }
	const releases = releasesFor(product)
	if (releases === undefined) return { status: "catalog_unavailable", product, version }
	const release = releaseCycleOf(releases, version)
	if (release === undefined) return { status: "unknown_cycle", product, version }
	const latest = release.latest === null ? null : (normalizeRuntimeVersion(release.latest) ?? null)
	const facts = { product, version, cycle: release.cycle, eolFrom: release.eolFrom, latest }
	if (release.isEol) return { status: "end_of_life", ...facts }
	if (RUNTIME_PRODUCTS[product].patchTracking && latest !== null && compareVersions(version, latest) < 0) {
		return { status: "behind", ...facts }
	}
	return { status: "supported", ...facts }
}
