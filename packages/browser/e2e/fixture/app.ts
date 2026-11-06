// A customer app: imports the published entry (aliased to the built dist) and
// inits from `?maple=<json>`, so each test picks its own config per page load.
import { type MapleBrowserConfig, type MapleBrowserHandle, MapleBrowser } from "@maple-dev/browser"

declare global {
	interface Window {
		MapleBrowser: typeof MapleBrowser
		maple: MapleBrowserHandle | undefined
		/** Errors the host app saw that did not come from the page under test. */
		hostErrors: string[]
	}
}

window.MapleBrowser = MapleBrowser
window.hostErrors = []
window.addEventListener("unhandledrejection", (event) => {
	window.hostErrors.push(`unhandledrejection: ${String(event.reason)}`)
})

// Carried to every page of the multi-page flow, so a navigation keeps the config.
const raw = new URLSearchParams(location.search).get("maple") ?? sessionStorage.getItem("e2e:maple")
if (raw !== null) {
	sessionStorage.setItem("e2e:maple", raw)
	const config: MapleBrowserConfig = JSON.parse(raw)
	window.maple = MapleBrowser.init(config)
}
