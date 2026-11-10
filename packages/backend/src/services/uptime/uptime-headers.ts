/**
 * How an HTTP check's request headers are stored: sealed in `headers_{ciphertext,iv,tag}`, with
 * `config_json.headers` left empty. They carry credentials (`Authorization`, API keys), so they
 * do not sit in the config in the clear (docs/secret-encryption.md).
 */
import type { UptimeMonitorConfig } from "@maple/domain/uptime"
import { Effect, Record as Rec, Schema } from "effect"
import { openSecret, type SecretKeyring } from "@maple/backend/platform/SecretBox"
import { uptimeMonitorHeadersSlot } from "@maple/backend/platform/secret-slots"

const UptimeHeadersJson = Schema.fromJsonString(Schema.Record(Schema.String, Schema.String))
const decodeHeaders = Schema.decodeEffect(UptimeHeadersJson)

export interface StoredUptimeHeaders {
	readonly headersCiphertext: string | null
	readonly headersIv: string | null
	readonly headersTag: string | null
}

interface MonitorRef {
	readonly orgId: string
	readonly id: string
}

/**
 * The config with its headers back in place. Headers still in `config_json` win: they were
 * written before sealing existed, or by a Worker that has not been deployed with it yet.
 */
export const openConfigHeaders = <E>(
	keyring: SecretKeyring,
	row: MonitorRef & StoredUptimeHeaders,
	config: UptimeMonitorConfig,
	onError: (reason: string) => E,
): Effect.Effect<UptimeMonitorConfig, E> => {
	if (
		config._tag !== "http" ||
		!Rec.isEmptyRecord(config.headers) ||
		row.headersCiphertext === null ||
		row.headersIv === null ||
		row.headersTag === null
	) {
		return Effect.succeed(config)
	}
	return openSecret(
		keyring,
		uptimeMonitorHeadersSlot,
		{ orgId: row.orgId, id: row.id },
		{ ciphertext: row.headersCiphertext, iv: row.headersIv, tag: row.headersTag },
		onError,
	).pipe(
		Effect.flatMap((json) =>
			decodeHeaders(json).pipe(Effect.mapError(() => onError("Stored headers are not a string map"))),
		),
		Effect.map((headers) => ({ ...config, headers })),
	)
}
