import { playwright } from "@vitest/browser-playwright"
import base from "./vite.config"
import { mergeConfig, defineConfig } from "vitest/config"

export default mergeConfig(
	base,
	defineConfig({
		resolve: { dedupe: ["react", "react-dom"] },
		test: {
			projects: [
				{
					test: {
						name: "node",
						server: { deps: { inline: ["@effect/vitest"] } },
						environment: "node",
						include: ["src/**/*.test.{ts,tsx}"],
						exclude: ["src/**/*.browser.test.{ts,tsx}"],
					},
				},
				{
					test: {
						name: "browser",
						include: ["src/**/*.browser.test.{ts,tsx}"],
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
	}),
)
