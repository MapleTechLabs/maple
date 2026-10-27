import path from "node:path"
import { foldkit } from "@foldkit/vite-plugin"
import tailwindcss from "@tailwindcss/vite"
import { defineConfig, loadEnv, type Plugin } from "vite"
import { siblingUrl } from "../../packages/infra/src/dev-urls.ts"
import { clerkJsUrl } from "./src/platform/clerk-js-url.ts"
import { versionManifest } from "./vite-plugin-version-manifest.ts"

const envDir = path.resolve(import.meta.dirname, "../..")

// Every VITE_* key the app reads.
const overrideKeys = [
	"VITE_API_BASE_URL",
	"VITE_API_PUBLIC_URL",
	"VITE_INGEST_URL",
	"VITE_MAPLE_SELF_INGEST_URL",
	"VITE_ELECTRIC_SYNC_URL",
	"VITE_MAPLE_REGION",
	"VITE_MAPLE_REGION_APP_URLS",
	"VITE_MAPLE_AUTH_MODE",
	"VITE_CLERK_PUBLISHABLE_KEY",
	"VITE_MAPLE_INGEST_KEY",
	"VITE_COMMIT_SHA",
	"VITE_MAPLE_ENVIRONMENT",
	"VITE_MAPLE_REPLAY",
	"VITE_MAPLE_CAPTURE",
	"VITE_MAPLE_COOKIE_DOMAIN",
	"VITE_MAPLE_LAB",
] as const

/**
 * Fetch clerk-js while the app bundle downloads instead of after it runs, and open the
 * credentialed connection `clerk.load()` calls the Frontend API on.
 */
const clerkEarlyLoad = (publishableKey: string): Plugin => ({
	name: "maple-clerk-early-load",
	transformIndexHtml: () => {
		const href = clerkJsUrl(publishableKey)
		return [
			{
				tag: "link",
				attrs: { rel: "preload", as: "script", href, crossorigin: "anonymous" },
				injectTo: "head-prepend",
			},
			{
				tag: "link",
				attrs: { rel: "preconnect", href: new URL(href).origin },
				injectTo: "head-prepend",
			},
		]
	},
})

/**
 * `src/boot.ts` as its own module script ahead of the app's: Vite folds every script in
 * index.html into one graph, which would make Clerk's start wait for the whole app bundle.
 */
const earlyBoot = (): Plugin => ({
	name: "maple-early-boot",
	config: (config) => ({
		build: {
			rolldownOptions: {
				input: {
					index: path.resolve(config.root ?? import.meta.dirname, "index.html"),
					boot: path.resolve(config.root ?? import.meta.dirname, "src/boot.ts"),
				},
			},
		},
	}),
	transformIndexHtml: {
		order: "post",
		handler: (_html, context) => {
			const chunk = Object.values(context.bundle ?? {}).find(
				(output) => output.type === "chunk" && output.isEntry && output.name === "boot",
			)
			return [
				{
					tag: "script",
					attrs: { type: "module", crossorigin: true, src: `/${chunk?.fileName ?? "src/boot.ts"}` },
					injectTo: "head-prepend",
				},
			]
		},
	},
})

export default defineConfig(({ mode, command }) => {
	const env = loadEnv(mode, envDir, "")

	if (process.env.PORTLESS_URL) {
		process.env.VITE_API_BASE_URL ??= siblingUrl("api")
		process.env.VITE_INGEST_URL ??= siblingUrl("ingest")
		process.env.VITE_ELECTRIC_SYNC_URL ??= siblingUrl("electric-sync")
	}
	process.env.VITE_MAPLE_AUTH_MODE ||= env.MAPLE_AUTH_MODE?.trim() || "self_hosted"
	process.env.VITE_CLERK_PUBLISHABLE_KEY ||= env.CLERK_PUBLISHABLE_KEY?.trim() || ""
	process.env.VITE_MAPLE_INGEST_KEY ||= env.MAPLE_OTEL_PUBLIC_INGEST_KEY?.trim() || ""
	process.env.VITE_MAPLE_COOKIE_DOMAIN ||= env.PUBLIC_MAPLE_COOKIE_DOMAIN?.trim() || ""

	const clerkKey = process.env.VITE_CLERK_PUBLISHABLE_KEY?.trim()

	// `.env*` files outrank process.env for VITE_* keys; `define` makes process.env win.
	const define: Record<string, string> = {}
	for (const key of overrideKeys) {
		const value = process.env[key]?.trim()
		if (value) define[`import.meta.env.${key}`] = JSON.stringify(value)
	}

	return {
		envDir,
		resolve: { tsconfigPaths: true },
		define,
		plugins: [
			tailwindcss(),
			// The DevTools MCP relay only exists on the dev server.
			foldkit(command === "serve" ? {} : { devToolsMcpPort: false }),
			// `/version.json`, which open tabs poll to offer a reload after a deploy (shell/version.ts).
			versionManifest(process.env.VITE_COMMIT_SHA?.trim() || ""),
			earlyBoot(),
			...(process.env.VITE_MAPLE_AUTH_MODE?.trim().toLowerCase() === "clerk" && clerkKey
				? [clerkEarlyLoad(clerkKey)]
				: []),
		],
		build: { manifest: true },
	}
})
