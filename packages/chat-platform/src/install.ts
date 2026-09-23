import { ChatConnectorId } from "./connector"
import { Effect, Redacted, Schema } from "effect"
import type { HttpClient } from "effect/unstable/http"
import type { ConnectorConfigKey } from "./ingress"

/**
 * The install half of the {@link ChatConnector} contract: everything needed to
 * link one chat workspace to a Maple org, and the pure data the dashboard needs
 * to render the connector without knowing which platform it is.
 *
 * Nothing here is platform-specific. An OAuth-redirect platform implements
 * `authorizeUrl` + `complete` as the two halves of an authorization-code flow;
 * a platform whose install is "paste a token" would implement `authorizeUrl` as
 * a link to its own setup page and read the pasted value from `complete`'s
 * params. Neither variant needs a new column, route or component.
 */

/**
 * Values the host resolved for the names a connector declared in
 * {@link ChatConnectorInstall.requiredConfig}, keyed by that name. A connector
 * never reads the environment itself — the host owns which secret store the
 * values came from, and a name the deployment has not set is simply absent.
 *
 * Redacted where the ingress half's `ConnectorConfig` holds plain strings: an
 * install exchanges an OAuth client secret against a provider that answers with
 * failures, and a redacted value cannot be carried into one by accident.
 */
export type ChatConnectorConfig = ReadonlyMap<string, Redacted.Redacted<string>>

/**
 * Connector-defined workspace settings, as the settings form posts them and as
 * they are stored. Values stay strings on the wire and in the column; a
 * connector that needs structure decodes them on the way out.
 */
export interface ChatWorkspaceSettings {
	readonly [key: string]: string
}

/** The connector's config is not set on this deployment, so it cannot install. */
export class ChatConnectorNotConfigured extends Schema.TaggedError<ChatConnectorNotConfigured>()(
	"@maple/chat-platform/ChatConnectorNotConfigured",
	{ connector: ChatConnectorId, message: Schema.String },
) {}

/**
 * The platform refused the authorization, or answered with something unusable.
 *
 * Deliberately message-only. The causes available at an install boundary are an
 * HTTP client error, which carries the request whose body holds the client
 * secret, and a decode error, which carries the token response — so a `cause`
 * here would be a credential on its way into a log.
 */
export class ChatInstallFailed extends Schema.TaggedError<ChatInstallFailed>()(
	"@maple/chat-platform/ChatInstallFailed",
	{ connector: ChatConnectorId, message: Schema.String },
) {}

/** A settings value did not satisfy the connector's own rules. */
export class ChatSettingsRejected extends Schema.TaggedError<ChatSettingsRejected>()(
	"@maple/chat-platform/ChatSettingsRejected",
	{ connector: ChatConnectorId, message: Schema.String },
) {}

/** One editable workspace setting, rendered as a field in the generic settings form. */
export interface ChatConnectorSettingsField {
	/** Key in {@link ChatWorkspaceSettings}. */
	readonly key: string
	readonly label: string
	readonly help: string
	readonly kind: "text"
}

/**
 * A mark as pure data — a viewBox and its paths. A path without a `fill` takes
 * `currentColor`; a multicolor mark (Slack) gives each path its brand fill, and the
 * dashboard can still render it monochrome by ignoring them. Data rather than a
 * component so the dashboard can render every connector's icon from one element,
 * and rather than raw SVG markup so nothing injects a document fragment.
 */
export interface ChatConnectorIcon {
	readonly viewBox: string
	readonly paths: ReadonlyArray<{ readonly d: string; readonly fill?: string }>
}

/** Everything the dashboard needs to present a connector. Pure data, no runtime. */
export interface ChatConnectorManifest {
	readonly id: ChatConnectorId
	readonly name: string
	readonly description: string
	readonly icon: ChatConnectorIcon
	/** Brand accent for the icon plate wash, as a CSS color. */
	readonly accent: string
	readonly settingsFields: ReadonlyArray<ChatConnectorSettingsField>
}

export interface ChatInstallStart {
	readonly config: ChatConnectorConfig
	/** Single-use CSRF nonce the host issued; the platform hands it back on the callback. */
	readonly state: string
	readonly redirectUri: string
}

export interface ChatInstallCallback {
	readonly config: ChatConnectorConfig
	/** The callback's query parameters, exactly as the platform sent them. */
	readonly params: URLSearchParams
	/** The same redirect URI the authorize step used — most token endpoints require it. */
	readonly redirectUri: string
}

/** The linked workspace, as the platform itself reports it. */
export interface ChatInstallResult {
	readonly externalWorkspaceId: string
	readonly name: string
	/**
	 * A secret the install minted for THIS workspace, in whatever the connector
	 * wants to read back — one token, or its own JSON. Absent where a connector
	 * authenticates with one deployment-wide credential the host already resolves
	 * from its environment.
	 *
	 * Opaque above the connector: the host encrypts it, stores it beside the row,
	 * and hands it back to the same connector's outbound half under
	 * {@link WORKSPACE_CREDENTIALS}. Nothing between the two reads it, so a
	 * platform whose install returns three values needs no column for each.
	 */
	readonly credentials?: string | undefined
}

export interface ChatConnectorInstall {
	/**
	 * Config the host must supply for this connector to be installable, in the
	 * same terms the ingress half declares its own: the names may well be
	 * platform-specific — they are declared here, inside the connector — and the
	 * host reads them generically, binding each as a secret or a plain variable
	 * according to its `secret` flag.
	 *
	 * A different Worker resolves these than resolves the ingress half's, because
	 * installing and carrying a turn are different deployables. One element type
	 * so neither host has to learn a second way to ask.
	 */
	readonly requiredConfig: ReadonlyArray<ConnectorConfigKey>
	/** Where to send the browser to begin the install. */
	readonly authorizeUrl: (input: ChatInstallStart) => Effect.Effect<string, ChatConnectorNotConfigured>
	/**
	 * Turn the callback into a linked workspace. The workspace identity must come
	 * from whatever the platform binds to the callback's credential, never from a
	 * query parameter the browser could have edited.
	 */
	readonly complete: (
		input: ChatInstallCallback,
	) => Effect.Effect<
		ChatInstallResult,
		ChatConnectorNotConfigured | ChatInstallFailed,
		HttpClient.HttpClient
	>
	/** Validate and normalize posted settings into the record to store. */
	readonly decodeSettings: (
		input: ChatWorkspaceSettings,
	) => Effect.Effect<ChatWorkspaceSettings, ChatSettingsRejected>
}

/** Read one declared config value, or fail naming the connector. */
export const requireConfig = (
	config: ChatConnectorConfig,
	connector: ChatConnectorId,
	name: string,
): Effect.Effect<string, ChatConnectorNotConfigured> => {
	const value = config.get(name)
	return value === undefined
		? Effect.fail(
				new ChatConnectorNotConfigured({
					connector,
					message: `${connector} is not configured on this deployment (${name})`,
				}),
			)
		: Effect.succeed(Redacted.value(value))
}
