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
import { Effect } from "effect"
import { decryptAes256Gcm, encryptAes256Gcm, type EncryptedValue } from "@maple/backend/platform/Crypto"

/**
 * What the envelope is authenticated against.
 *
 * Authenticated but not stored, so it binds the ciphertext to its row: an attacker holding only
 * database writes cannot relocate an `(iv, ciphertext, tag)` triple onto another org's row, onto
 * another connector's row, or onto the same connector's row for a different workspace — which is
 * exactly the move that would point one team's bot token at another team's conversations.
 */
export const chatWorkspaceCredentialsAad = (
	orgId: string,
	connector: string,
	externalWorkspaceId: string,
): Buffer => Buffer.from(`chat_workspaces:v1:${orgId}:${connector}:${externalWorkspaceId}`, "utf8")

export interface ChatWorkspaceCredentialsRef {
	readonly orgId: string
	readonly connector: string
	readonly externalWorkspaceId: string
}

/** Seal a connector's credential string for storage. */
export const sealChatWorkspaceCredentials = <E>(
	credentials: string,
	encryptionKey: Buffer,
	ref: ChatWorkspaceCredentialsRef,
	onError: (message: string) => E,
): Effect.Effect<EncryptedValue, E> =>
	encryptAes256Gcm(
		credentials,
		encryptionKey,
		onError,
		chatWorkspaceCredentialsAad(ref.orgId, ref.connector, ref.externalWorkspaceId),
	)

/** Open a stored envelope. Fails when the key, the row or the AAD no longer match. */
export const openChatWorkspaceCredentials = <E>(
	encrypted: EncryptedValue,
	encryptionKey: Buffer,
	ref: ChatWorkspaceCredentialsRef,
	onError: (message: string) => E,
): Effect.Effect<string, E> =>
	decryptAes256Gcm(
		encrypted,
		encryptionKey,
		onError,
		chatWorkspaceCredentialsAad(ref.orgId, ref.connector, ref.externalWorkspaceId),
	)

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
