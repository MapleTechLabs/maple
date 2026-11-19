/** The secrets the gateway task stores in Secrets Manager, read from the deploy's environment. */
import * as Config from "effect/Config"
import * as Secrets from "@maple/infra/secrets"

export const ingestSecrets = Config.all({
	keyLookupHmacKey: Secrets.IngestKeyLookupHmacKey.requiredValue,
	// Autumn absent means billing enforcement is dark.
	autumnSecretKey: Secrets.AutumnSecretKey.optionalValue,
})

/** The admin token the deploy reads the gateway's append-only token with, through `resolveDerived`. */
export const ingestWarehouseAdminToken = Secrets.TinybirdToken.requiredValue

/**
 * The master keys the deploy derives the gateway's ClickHouse password slot keys from, read only
 * through `resolveDerived`: the task never receives them (docs/secret-encryption.md).
 */
export const ingestSlotKeyMasters = Config.all({
	primary: Secrets.IngestKeyEncryptionKey.requiredValue,
	// Only set while a key rotation is in flight.
	decryptOnly: Secrets.IngestKeyDecryptionKeys.optionalValue,
})
