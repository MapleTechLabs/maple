// The log detail sheet: `LogSheet` as a Submodel the page keeps. `open` shows a log in the sheet,
// `show` lays the same panels out for a log's own page; its reads go through `LogSource`, and the
// Infrastructure tab is the app's to provide.
export { Message, Model, OutMessage } from "./log-sheet/model"
export { close, init, open, show, update, viewLog } from "./log-sheet/update"
export type { InitOptions, Return, Scope } from "./log-sheet/update"
export { pageView, view } from "./log-sheet/view"
export type { ViewInputs } from "./log-sheet/view"
