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
	],
}
