// `@maple-dev/browser/astro`: the Astro integration.
//
// Wires the other two Astro entries into every page, so nothing goes in the
// layouts: the middleware (route names in the HTML, on-demand render spans),
// first in the chain, and a page script that traces navigations. Runs in
// `astro.config.mjs`, so it imports nothing at runtime. `MapleBrowser.init`
// stays in your own `<script>`: its options can hold functions and
// `import.meta.env` values that don't survive the trip through the config.
import type { AstroIntegration } from "astro"

/** Add to `integrations` in `astro.config.mjs`: traces page loads, `<ClientRouter />` navigations and on-demand renders. */
export default function maple(): AstroIntegration {
	return {
		name: "@maple-dev/browser",
		hooks: {
			"astro:config:setup": ({ addMiddleware, injectScript }) => {
				addMiddleware({ entrypoint: "@maple-dev/browser/astro/middleware", order: "pre" })
				injectScript(
					"page",
					'import { traceAstroNavigation } from "@maple-dev/browser/astro/client"; traceAstroNavigation()',
				)
			},
		},
	}
}
