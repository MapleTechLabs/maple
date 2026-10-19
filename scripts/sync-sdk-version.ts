/**
 * Runs after `changeset version` (root `changeset:version`). Stamps the bumped
 * `packages/effect-sdk/package.json` version into `src/version.ts`, which keeps a literal
 * so browser bundles do not need a JSON import.
 */
import { readFileSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"

const root = resolve(import.meta.dir, "../packages/effect-sdk")
const { version } = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"))
const file = resolve(root, "src/version.ts")
const source = readFileSync(file, "utf8")
const literal = /export const SDK_VERSION = "[^"]*"/
if (!literal.test(source)) {
	console.error("sync-sdk-version: SDK_VERSION literal not found in src/version.ts")
	process.exit(1)
}
writeFileSync(file, source.replace(literal, `export const SDK_VERSION = "${version}"`))
