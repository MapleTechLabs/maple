// The span detail panel: `SpanDetailPanel` as a Submodel the page re-creates per selection. Its
// reads go through `TraceSource`; the infrastructure tab is the app's to provide.
export { Message, OutMessage } from "./span-panel/message"
export { Model } from "./span-panel/model"
export { init, refresh, update } from "./span-panel/update"
export type { Return } from "./span-panel/update"
export { resourceAttributesOf, view } from "./span-panel/view"
