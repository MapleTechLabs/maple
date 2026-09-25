/**
 * What a chat platform has to provide: how it is installed, and how it carries a Maple agent turn.
 *
 * The whole package exists for one rule: everything that differs between one chat vendor and the
 * next lives under `src/connectors/<id>/`, behind this structure. Nothing above a connector
 * directory names a vendor — not an identifier, not a literal, not a test fixture — and adding a
 * platform is a directory beside the others plus one line in `src/connectors/index.ts`. The
 * isolation is checked, not trusted: `vendor-isolation.test.ts` reads the sources.
 */
import { ChatConnectorId } from "@maple/primitives"
import { Schema } from "effect"
import type { ChatConnectorIdentity } from "./identity"
import type { ConnectorIngress } from "./ingress"
import type { ChatConnectorInstall, ChatConnectorManifest } from "./install"
import type { ChatOutbound } from "./outbound"

/**
 * A connector's identity, lowercase alphanumeric with no separators.
 *
 * Defined once in `@maple/primitives`, because the stored column, the public contract and the
 * dashboard decode the same id and none of them can depend on this package. Re-exported here so a
 * connector reaches everything it implements through one module.
 */
export { ChatConnectorId }

/** Decode a connector's own id. A connector declares it at module scope, so a bad one fails the build. */
export const chatConnectorId = Schema.decodeUnknownSync(ChatConnectorId)

/**
 * One platform, as one structured export.
 *
 * `R` is what the connector's outbound needs from the host Worker — an HTTP client, its own
 * credential service. The host supplies those; the package never reads the environment.
 *
 * `ingress` carries no `R` of its own and never will: a webhook connector is handed the request
 * and answers, and a socket connector is a pure state machine the host drives. Both are described
 * in `./ingress.ts`.
 */
export interface ChatConnector<R = never> {
	readonly id: ChatConnectorId
	readonly manifest: ChatConnectorManifest
	readonly install: ChatConnectorInstall
	readonly outbound: ChatOutbound<R>
	readonly ingress: ConnectorIngress
	/**
	 * How one person proves which account on this platform is theirs, where the platform can say.
	 *
	 * **This is where the approval policy is written down.** Its absence is a policy rather than a
	 * gap, and the three cases are:
	 *
	 *   - **no `identity`** — the connector cannot tell Maple who clicked, so anyone who can see
	 *     the conversation may approve, and the change runs as the org-level connector identity
	 *     (`connectorApprovalTenant`), which carries `org:admin` because there is no person whose
	 *     roles could be read. The weaker rule, and deliberate: the alternative is a bot that can
	 *     propose changes and never apply them.
	 *   - **`identity`, linked** — the change runs as the Maple user that person linked to, under
	 *     the roles they hold in the org at approval time. Nothing is granted: a tool that needs an
	 *     admin refuses a member exactly as it would in the app.
	 *   - **`identity`, not linked** — refused. On a platform where identity was available,
	 *     "nobody linked" must never quietly become "anyone in the channel may approve".
	 */
	readonly identity?: ChatConnectorIdentity
}
