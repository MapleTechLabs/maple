/**
 * The envelope around a chat workspace's own credential.
 *
 * A connector whose install mints a per-workspace secret hands it back as one opaque string
 * (`ChatInstallResult.credentials`); this is where that string is sealed on the way into the row
 * and opened on the way back out. Nothing here reads the plaintext — it is the connector's own
 * encoding, and the only thing above a connector that touches it is this file, which treats it as
 * bytes.
 *
 * Deliberately its own module rather than a method on the service: the Worker that answers a
 * mention opens the envelope (`chat-workspace-rows.ts`) and never links anything, so it must not
 * take the install service's OAuth state, HTTP client and connector config just to read a token.
 */
import type { Effect } from "effect"
import type { EncryptedValue } from "@maple/backend/platform/Crypto"
import { openSecret, sealSecret, type SecretKeyring } from "@maple/backend/platform/SecretBox"
import {
	chatWorkspaceCredentialsSlot,
	type ChatWorkspaceCredentialsRef,
} from "@maple/backend/platform/secret-slots"

/**
 * Seal a connector's credential string for storage. The ref (org, connector, workspace) is
 * authenticated but not stored, so a triple copied onto another row does not open.
 */
export const sealChatWorkspaceCredentials = <E>(
	credentials: string,
	keyring: SecretKeyring,
	ref: ChatWorkspaceCredentialsRef,
	onError: (message: string) => E,
): Effect.Effect<EncryptedValue, E> =>
	sealSecret(keyring, chatWorkspaceCredentialsSlot, ref, credentials, onError)

/** Open a stored envelope. Fails when the key or the row it is bound to no longer match. */
export const openChatWorkspaceCredentials = <E>(
	encrypted: EncryptedValue,
	keyring: SecretKeyring,
	ref: ChatWorkspaceCredentialsRef,
	onError: (message: string) => E,
): Effect.Effect<string, E> => openSecret(keyring, chatWorkspaceCredentialsSlot, ref, encrypted, onError)

/**
 * The three columns as one value, or `null` when the row carries no credential.
 *
 * A half-written triple is `null` too: two of three columns is a row nobody can decrypt, and
 * treating it as "no credential" is the same outcome as trying and failing, one branch earlier.
 */
export const storedCredentials = (row: {
	readonly credentialsCiphertext: string | null
	readonly credentialsIv: string | null
	readonly credentialsTag: string | null
}): EncryptedValue | null =>
	row.credentialsCiphertext === null || row.credentialsIv === null || row.credentialsTag === null
		? null
		: {
				ciphertext: row.credentialsCiphertext,
				iv: row.credentialsIv,
				tag: row.credentialsTag,
			}
