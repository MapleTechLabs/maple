/**
 * alchemy's `pure` bundle option: packages whose top-level calls get `/*#__PURE__*\/` so
 * rolldown can tree-shake them. alchemy's default list includes `@distilled.cloud/*`, but
 * `@distilled.cloud/railway` registers its GraphQL type fields with discarded-result
 * `Object.assign(X.fields, …)` calls; annotated, they are dropped and every query lens reads
 * `undefined` at runtime. Same defaults, with the distilled packages listed one by one.
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
