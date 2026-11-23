import { playwright } from "@vitest/browser-playwright"
import { createRequire } from "node:module"
import { dirname, join } from "node:path"
import { configDefaults, defineConfig } from "vitest/config"

// Its CJS entry sits next to the ESM one the browser needs.
const otelApi = join(
	dirname(createRequire(import.meta.resolve("@maple-dev/browser")).resolve("@opentelemetry/api")),
	"index.mjs",
)

const exclude = [...configDefaults.exclude, "**/.claude/**", "**/.context/**", "**/worktrees/**"]

export default defineConfig({
	test: {
		projects: [
			{
				test: {
					name: "node",
					environment: "node",
					include: ["**/*.test.ts"],
					exclude: [...exclude, "**/*.browser.test.ts"],
				},
			},
			{
				// The prebundled browser SDK imports this from the app root, which does not install it.
				resolve: { alias: [{ find: /^@opentelemetry\/api$/, replacement: otelApi }] },
				// Island hydration and DOM-reading components run in Chromium.
				test: {
					name: "browser",
					include: ["src/**/*.browser.test.ts"],
					exclude,
					browser: {
						enabled: true,
						headless: true,
						provider: playwright(),
						instances: [{ browser: "chromium" }],
					},
				},
			},
		],
	},
})
