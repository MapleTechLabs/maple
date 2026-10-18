// The global chat sheet, embedded by the root (it lives above every page, like `<GlobalChatSheet />`
// in apps/web's root frame).
export { init, Message, Model, OutMessage } from "./model"
export { openGlobalChat, subscriptions, type SheetHost } from "./subscription"
export { update } from "./update"
export { view } from "./view"
