/**
 * Runs after `changeset version` (root `changeset:version`). Stamps each SDK's bumped
 * `package.json` version into its `src/version.ts`, which keeps a literal so browser
 * bundles do not need a JSON import. `version.test.ts` in each package checks the pair.
 */
import { readFileSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"

const SDK_PACKAGES = ["packages/effect-sdk", "packages/browser"]
const literal = /export const SDK_VERSION = "[^"]*"/

SDK_PACKAGES.forEach((dir) => {
	const root = resolve(import.meta.dir, "..", dir)
	const { version } = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"))
	const file = resolve(root, "src/version.ts")
	const source = readFileSync(file, "utf8")
	if (!literal.test(source)) {
		console.error(`sync-sdk-versions: SDK_VERSION literal not found in ${dir}/src/version.ts`)
		process.exit(1)
	}
	writeFileSync(file, source.replace(literal, `export const SDK_VERSION = "${version}"`))
})
