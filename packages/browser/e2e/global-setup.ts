// Bundles the fixture app the way a customer's bundler would: against the
// published entry in `dist/`, so the e2e suite tests the artifact npm ships.
import { existsSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { build } from "vite"

const here = (path: string): string => fileURLToPath(new URL(path, import.meta.url))

export const OUTPUT_DIR = here("./.output")

export default async function setup(): Promise<void> {
	const dist = here("../dist/index.mjs")
	if (!existsSync(dist)) throw new Error("dist/ is missing: run `bun run build` (test:e2e does) first")
	await build({
		root: here("./fixture"),
		logLevel: "warn",
		resolve: { alias: { "@maple-dev/browser": dist } },
		build: {
			outDir: OUTPUT_DIR,
			emptyOutDir: true,
			minify: false,
			rollupOptions: {
				input: {
					index: here("./fixture/index.html"),
					next: here("./fixture/next.html"),
					player: here("./fixture/player.html"),
				},
			},
		},
	})
}
