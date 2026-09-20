import type { ChatConnector } from "../connector"
import { discord } from "./discord/index"

/**
 * The registry. Adding a platform is a directory beside this file plus its line
 * below — the only place outside a connector directory where a platform is named
 * (`manifests.ts`, the dashboard's half of the same registration, is the other).
 */
export const connectors: ReadonlyArray<ChatConnector> = [discord]
