import tailwindcss from "@tailwindcss/vite"
import { playwright } from "@vitest/browser-playwright"
import { defineConfig } from "vitest/config"

export default defineConfig({
	plugins: [tailwindcss()],
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
})
