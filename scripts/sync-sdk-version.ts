// `changeset version` bumps each SDK's package.json but not the SDK_VERSION
// literal in its src/version.ts; copy it across so release PRs stay green.
const literal = /export const SDK_VERSION = "[^"]*"/

for (const dir of ["effect-sdk", "browser"]) {
	const { version } = await Bun.file(new URL(`../packages/${dir}/package.json`, import.meta.url)).json()
	const path = new URL(`../packages/${dir}/src/version.ts`, import.meta.url)
	const source = await Bun.file(path).text()
	if (!literal.test(source)) throw new Error(`SDK_VERSION literal not found in packages/${dir}/src/version.ts`)
	await Bun.write(path, source.replace(literal, `export const SDK_VERSION = "${version}"`))
}
