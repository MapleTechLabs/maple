/** The secrets the gateway task stores in Secrets Manager, read from the deploy's environment. */
import * as Config from "effect/Config"
import * as Secrets from "@maple/infra/secrets"

export const ingestSecrets = Config.all({
	tinybirdToken: Secrets.TinybirdToken.value,
	keyEncryptionKey: Secrets.IngestKeyEncryptionKey.value,
	// Only set while a key rotation is in flight (docs/secret-encryption.md).
	keyDecryptionKeys: Secrets.IngestKeyDecryptionKeys.valueOption,
	keyLookupHmacKey: Secrets.IngestKeyLookupHmacKey.value,
	// Autumn absent means billing enforcement is dark.
	autumnSecretKey: Secrets.AutumnSecretKey.valueOption,
})

/** The gateway's own database login, on a stage whose deploy does not declare one. */
export const ingestPgUrl = Secrets.IngestPgUrl.value
