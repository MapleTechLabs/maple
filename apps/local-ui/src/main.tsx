import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { QueryClientProvider } from "@tanstack/react-query"
import { setTheme } from "@maple/ui/hooks/use-theme"
import { App } from "./App"
import { localServerPort } from "./lib/constants"
import { shouldRetryLocalQuery } from "./lib/query"
import { LocalQueryClient, persistQueryCache, restoreQueryCache } from "./lib/query-cache"
import "./styles.css"

const queryClient = new LocalQueryClient({
	defaultOptions: {
		queries: {
			// Lists are anchored to a time window and offer a "new data" refresh
			// instead; refetching every page on focus would re-run them all.
			refetchOnWindowFocus: false,
			staleTime: 30_000,
			retry: shouldRetryLocalQuery,
			// Older windows stay around to open pages on while the server is busy.
			gcTime: 60 * 60 * 1000,
		},
	},
})

// Last results survive a reload or a stopped server; one cache per server port.
const cacheKey = `maple-local:query-cache:${localServerPort()}`
restoreQueryCache(queryClient, cacheKey)
persistQueryCache(queryClient, cacheKey)

// Follow the OS theme. Dark stays the default when nothing says light (the
// markup ships `class="dark"`), and `setTheme` keeps chart colors in step.
const prefersLight = window.matchMedia("(prefers-color-scheme: light)")
const applyColorScheme = () => setTheme(prefersLight.matches ? "light" : "dark", { persist: false })
applyColorScheme()
prefersLight.addEventListener("change", applyColorScheme)

const container = document.getElementById("app")
if (container) {
	createRoot(container).render(
		<StrictMode>
			<QueryClientProvider client={queryClient}>
				<App />
			</QueryClientProvider>
		</StrictMode>,
	)
}
