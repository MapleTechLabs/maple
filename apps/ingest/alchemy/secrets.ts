/** The secrets the gateway task stores in Secrets Manager, read from the deploy's environment. */
import * as Config from "effect/Config"
import * as Secrets from "@maple/infra/secrets"

export const ingestSecrets = Config.all({
	tinybirdToken: Secrets.TinybirdToken.requiredValue,
	keyLookupHmacKey: Secrets.IngestKeyLookupHmacKey.requiredValue,
	// Autumn absent means billing enforcement is dark.
	autumnSecretKey: Secrets.AutumnSecretKey.optionalValue,
})

/** The gateway's own database login, on a stage whose deploy does not declare one. */
export const ingestPgUrl = Secrets.IngestPgUrl.requiredValue

/**
 * The master keys the deploy derives the gateway's ClickHouse password slot keys from, read only
 * through `resolveDerived`: the task never receives them (docs/secret-encryption.md).
 */
export const ingestSlotKeyMasters = Config.all({
	primary: Secrets.IngestKeyEncryptionKey.requiredValue,
	// Only set while a key rotation is in flight.
	decryptOnly: Secrets.IngestKeyDecryptionKeys.optionalValue,
})
