import type { ChatConnectorId } from "@maple/primitives"
import type { ChatConnectorInstall, ChatConnectorManifest } from "./install"

/**
 * One chat platform, as the rest of Maple sees it.
 *
 * Everything that differs between platforms lives under
 * `src/connectors/<id>/` and reaches the rest of the codebase only through this
 * structure. Adding a platform is a directory plus a line in
 * `src/connectors/index.ts` — no migration, no route, no dashboard component.
 */
export interface ChatConnector {
	readonly id: ChatConnectorId
	readonly manifest: ChatConnectorManifest
	readonly install: ChatConnectorInstall
}
