import { init, type MapleBrowserHandle } from "./init"

export type { MapleBrowserConfig } from "./config"
export type { MapleBrowserHandle } from "./init"

/**
 * Maple browser SDK. One call wires up OpenTelemetry tracing and rrweb session
 * replay, both tagged with a shared session id.
 *
 * @example
 * ```ts
 * import { MapleBrowser } from "@maple/browser"
 *
 * MapleBrowser.init({
 *   ingestKey: "maple_pk_...",
 *   serviceName: "acme-web",
 * })
 * ```
 */
export const MapleBrowser: {
	init: (config: import("./config").MapleBrowserConfig) => MapleBrowserHandle
} = { init }
