// The app shell (layout and sidebar): a completed Block the root keeps across navigation,
// embedded through one Binding as the frame around the page and as the overlay layers after it.
export { ShellBlock } from "./block"
export { readShellFlags } from "./flags"
export { NavSurface } from "./nav"
export { Message, OutMessage, Theme } from "./message"
export { initialModel, Model, type ShellClerk, type ShellFlags } from "./model"

export {
	favoritesChanges,
	filterViewportChanges,
	sidebarShortcut,
	smallViewportChanges,
	viewportChanges,
} from "./subscription"

export { pinnedDashboardRows } from "./dashboards-shape"
export { BUILT_COMMIT, versionChecks } from "./version"
export { isChecklistCounting, isConnectPolling } from "./update"
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
