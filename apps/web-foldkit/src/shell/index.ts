// The app shell (apps/web `DashboardLayout` + `AppSidebar`): a Submodel the root keeps across
// navigation, embedded twice: the frame around the page and the overlay layers after it.
export { readShellFlags } from "./flags"
export { Message, OutMessage, Theme } from "./message"
export { init, Model } from "./model"
export { favoritesChanges, sidebarShortcut, viewportChanges } from "./subscription"
export { DASHBOARD_FAVORITES_EVENT, DASHBOARD_FAVORITES_KEY } from "./favorites"
export { pinnedDashboardRows } from "./dashboards-shape"
export { BUILT_COMMIT, versionChecks } from "./version"
export { enter, routeChanged, update } from "./update"
export { type BreadcrumbEntry, bareFrameView, frameView, menuLayerView, sheetLayerView } from "./view"
