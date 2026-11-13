import type { VercelConnectionRow } from "@maple/db/tables"
import { openSecret, type SecretKeyring } from "@maple/backend/platform/SecretBox"
import { vercelTokenSlot } from "@maple/backend/platform/secret-slots"

/** The connection's Vercel access token, unsealed. Shared by the integration and the cost adapter. */
export const openVercelToken = <E>(
	keyring: SecretKeyring,
	connection: Pick<VercelConnectionRow, "orgId" | "tokenCiphertext" | "tokenIv" | "tokenTag">,
	onError: (message: string) => E,
) =>
	openSecret(
		keyring,
		vercelTokenSlot,
		{ orgId: connection.orgId },
		{ ciphertext: connection.tokenCiphertext, iv: connection.tokenIv, tag: connection.tokenTag },
		onError,
	)
