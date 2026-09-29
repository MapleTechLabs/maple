// `@maple-dev/browser/nuxt`: joins the page load to Nuxt's server render.
//
// Nuxt renders a page in several steps, with no single call to wrap in a span,
// so the server's request span (the HTTP instrumentation's) stands in for the
// render: a Nuxt server plugin names it after the page's route, and a Nitro
// plugin sends its trace context to the browser in `Server-Timing`, which the
// `pageload` span reads. The browser side is `@maple-dev/browser/vue`. Depends
// on `@opentelemetry/api` only, like `@maple-dev/browser/server`.
import { trace } from "@opentelemetry/api"
import type { App } from "vue"
import type { Router } from "vue-router"
import { serverTiming } from "../server"

/** The part of Nitro's `NitroApp` this uses. */
interface NitroApp {
	readonly hooks: {
		hook(
			name: "render:response",
			fn: (response: { headers?: Record<string, string> | undefined }) => void,
		): void
	}
}

/** The part of Nuxt's `NuxtApp` this uses. */
interface NuxtApp {
	readonly vueApp: App
}

/**
 * `export default defineNitroPlugin(mapleNitroPlugin)` in `server/plugins/`: adds the
 * `Server-Timing` header that joins the browser's page load to the request's trace.
 */
export function mapleNitroPlugin(nitroApp: NitroApp): void {
	// Only rendered pages go through `render:response`, not assets or API routes
	nitroApp.hooks.hook("render:response", (response) => {
		const value = serverTiming()
		if (!value) return
		const existing = response.headers?.["server-timing"]
		response.headers = {
			...response.headers,
			"server-timing": existing ? `${existing}, ${value}` : value,
		}
	})
}

/**
 * `export default defineNuxtPlugin(mapleSsrPlugin)` in `app/plugins/*.server.ts`: names the
 * request span after the page's route, `ssr /projects/:id()`.
 */
export function mapleSsrPlugin(nuxtApp: NuxtApp): void {
	const router: Router = nuxtApp.vueApp.config.globalProperties.$router
	router.afterEach((to) => {
		// A URL no route matches keeps the request span's own name, not the concrete path
		const route = to.matched.at(-1)?.path
		if (route) trace.getActiveSpan()?.updateName(`ssr ${route}`)
	})
}
