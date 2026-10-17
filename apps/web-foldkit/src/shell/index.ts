// The app shell (apps/web `DashboardLayout` + `AppSidebar`): a Submodel the root keeps across
// navigation, embedded twice: the frame around the page and the overlay layers after it.
export { readShellFlags } from "./flags"
export { Menu, Message, OutMessage, Theme } from "./message"
export { init, Model, type ShellFlags } from "./model"
export { sidebarShortcut, viewportChanges } from "./subscription"
export { BUILT_COMMIT, versionChecks } from "./version"
export { enter, routeChanged, update } from "./update"
export { type BreadcrumbEntry, frameView, menuLayerView, sheetLayerView } from "./view"
