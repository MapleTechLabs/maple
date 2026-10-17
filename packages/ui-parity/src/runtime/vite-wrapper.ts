import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"

/**
 * The `/lab` layout route 404s unless `import.meta.env.DEV`. Parity builds are production builds
 * (React prod, no dev warnings), so this plugin flips that one check in that one file and nothing
 * else: a global `DEV` define would also turn on dev-only banners, dials and layout debug overlays.
 */
export const LAB_GATE_FILE = "/src/routes/lab/route.tsx"

const CONFIG_NAMES = ["vite.config.ts", "vite.config.mts", "vite.config.js", "vite.config.mjs"]

/**
 * Writes a Vite config that wraps the app's own one: the lab-gate plugin, and an empty `envDir`
 * so no `.env*` file can leak a value the parity env does not set. It lives in the app's
 * `node_modules` (never tracked) so bare imports resolve exactly as the app's own config does.
 */
export const viteWrapperConfig = (appDir: string, emptyEnvDir: string) => {
	const base = CONFIG_NAMES.map((name) => resolve(appDir, name)).find((path) => existsSync(path))
	mkdirSync(emptyEnvDir, { recursive: true })
	const dir = resolve(appDir, "node_modules/.parity")
	mkdirSync(dir, { recursive: true })
	const file = resolve(dir, "vite.parity.config.mjs")
	const source = `${base ? `import base from ${JSON.stringify(base)}` : "const base = {}"}

const labGate = {
	name: "parity-lab-gate",
	enforce: "pre",
	transform(code, id) {
		if (!id.split("?")[0].endsWith(${JSON.stringify(LAB_GATE_FILE)})) return null
		return { code: code.replaceAll("import.meta.env.DEV", "true"), map: null }
	},
}

export default async (env) => {
	const resolved = typeof base === "function" ? await base(env) : base
	return {
		...resolved,
		root: ${JSON.stringify(appDir)},
		envDir: ${JSON.stringify(emptyEnvDir)},
		plugins: [labGate, ...(resolved.plugins ?? [])],
	}
}
`
	writeFileSync(file, source)
	return file
}
