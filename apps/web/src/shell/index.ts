// The app shell (layout and sidebar): a Submodel the root keeps across
// navigation, embedded twice: the frame around the page and the overlay layers after it.
export { readShellFlags } from "./flags"
export { NavSurface } from "./nav"
export { Message, OutMessage, Theme } from "./message"
export { init, Model, type ShellClerk } from "./model"

export {
	favoritesChanges,
	filterViewportChanges,
	sidebarShortcut,
	smallViewportChanges,
	viewportChanges,
} from "./subscription"

export { pinnedDashboardRows } from "./dashboards-shape"
export { BUILT_COMMIT, versionChecks } from "./version"
export {
	checklistTicked,
	connectPollTicked,
	enter,
	enterBare,
	isChecklistCounting,
	isConnectPolling,
	routeChanged,
	update,
} from "./update"
export {
	type BreadcrumbEntry,
	bareFrameView,
	frameView,
	menuLayerView,
	paletteLayerView,
	sheetLayerView,
	shortcutsLayerView,
} from "./view"
export { globalShortcuts } from "./subscription"
