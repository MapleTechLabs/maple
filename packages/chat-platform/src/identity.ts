/**
 * Linking one person's chat account to one Maple user.
 *
 * Optional, and the optionality is the contract: See `ChatConnector.identity` for the three-case approval policy this is half of.
 *
 * Deliberately the same authorization-code flow the install half runs, over the same OAuth
 * application and the same `requiredConfig`: one app, one client id, one secret. The only
 * differences are the scope the connector asks for and what it reads back — which is why this is
 * two functions rather than a second install contract.
 *
 * **No token is kept.** The grant proves the person controls that chat account at that moment; the
 * access token is used once, to ask the platform who they are, and discarded. Maple never acts on
 * a platform as the person, only as itself.
 */
import { Effect, Schema } from "effect"
import type { HttpClient } from "effect/unstable/http"
import { ChatConnectorId } from "./connector"
import type { ChatConnectorNotConfigured, ChatInstallCallback, ChatInstallStart } from "./install"

/** Who the platform says just authorized, and nothing else. */
export interface ChatIdentity {
	/** The platform's own id for the account — what ingress reports as `actor.id` on a click. */
	readonly externalUserId: string
	/** What the platform shows for them, when it says. Display only; nothing is resolved by it. */
	readonly displayName?: string | undefined
}

/**
 * The platform refused the authorization, or answered with something unusable.
 *
 * Message-only for the same reason {@link ChatInstallFailed} is: the causes available here are an
 * HTTP client error carrying the request whose body holds the client secret, and a decode error
 * carrying the token response.
 */
export class ChatIdentityFailed extends Schema.TaggedError<ChatIdentityFailed>()(
	"@maple/chat-platform/ChatIdentityFailed",
	{ connector: ChatConnectorId, message: Schema.String },
) {}

export interface ChatConnectorIdentity {
	/**
	 * Where to send the browser to prove who they are on the platform.
	 *
	 * `state` is the host's single-use nonce, and the row behind it is what carries the Maple user:
	 * the callback binds the chat account to whoever *started* the link, never to whoever happens
	 * to open the callback URL.
	 */
	readonly authorizeUrl: (input: ChatInstallStart) => Effect.Effect<string, ChatConnectorNotConfigured>
	/**
	 * Turn the callback into the chat account it was issued for.
	 *
	 * The identity must come from what the platform binds to the credential — an id read back from
	 * the platform with the grant — never from a callback query parameter, which belongs to
	 * whoever opened the URL.
	 */
	readonly complete: (
		input: ChatInstallCallback,
	) => Effect.Effect<ChatIdentity, ChatConnectorNotConfigured | ChatIdentityFailed, HttpClient.HttpClient>
}
