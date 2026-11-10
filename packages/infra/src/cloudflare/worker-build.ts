/** Workers runtime compatibility date for every Maple Worker (and the cold-path build scripts). */
export const WORKER_COMPATIBILITY_DATE = "2026-10-01"

/**
 * A Website Worker's build cache key: its own tree plus the `@maple/*` sources it bundles.
 * `lockfile` is restated because providing `include` drops it.
 */
export const siteBuildMemo = (...extra: ReadonlyArray<string>) => ({
	include: ["**/*", "../../packages/*/src/**", "../../lib/*/src/**", ...extra],
	lockfile: true,
})

/**
 * alchemy's default `pure` list minus `@distilled.cloud/railway`, whose side-effecting
 * `Object.assign(X.fields, …)` calls would be tree-shaken away.
 */
export const WORKER_PURE_OPTIONS = {
	replaceDefaults: true,
	packages: [
		"effect",
		"@effect/*",
		"alchemy",
		"@alchemy.run/*",
		"@distilled.cloud/core",
		"@distilled.cloud/cloudflare",
		"@distilled.cloud/aws",
		"@distilled.cloud/planetscale",
	],
}
