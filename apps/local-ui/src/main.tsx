import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { setTheme } from "@maple/ui/hooks/use-theme"
import { App } from "./App"
import { shouldRetryLocalQuery } from "./lib/query"
import "./styles.css"

const queryClient = new QueryClient({
	defaultOptions: {
		queries: {
			// Lists are anchored to a time window and offer a "new data" refresh
			// instead; refetching every page on focus would re-run them all.
			refetchOnWindowFocus: false,
			staleTime: 30_000,
			retry: shouldRetryLocalQuery,
		},
	},
})

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
