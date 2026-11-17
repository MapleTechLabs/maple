/**
 * How an HTTP check's request headers are stored: sealed in `headers_{ciphertext,iv,tag}`, with
 * `config_json.headers` left empty. They carry credentials (`Authorization`, API keys), so they
 * do not sit in the config in the clear (docs/secret-encryption.md).
 */
import type { UptimeMonitorConfig } from "@maple/domain/uptime"
import { Effect, Record as Rec, Schema, Array as Arr } from "effect"
import { openSecret, sealSecret, type SecretKeyring } from "@maple/backend/platform/SecretBox"
import { uptimeMonitorHeadersSlot } from "@maple/backend/platform/secret-slots"

const HeaderMap = Schema.Record(Schema.String, Schema.String)
const UptimeHeadersJson = Schema.fromJsonString(HeaderMap)
const encodeHeaders = Schema.encodeEffect(UptimeHeadersJson)
const decodeHeaders = Schema.decodeEffect(UptimeHeadersJson)
/** A multi-step check seals every step's headers together, one map per step in order. */
const StepHeadersJson = Schema.fromJsonString(Schema.Array(HeaderMap))
const encodeStepHeaders = Schema.encodeEffect(StepHeadersJson)
const decodeStepHeaders = Schema.decodeEffect(StepHeadersJson)

export interface StoredUptimeHeaders {
	readonly headersCiphertext: string | null
	readonly headersIv: string | null
	readonly headersTag: string | null
}

interface MonitorRef {
	readonly orgId: string
	readonly id: string
}

const NO_HEADERS: StoredUptimeHeaders = { headersCiphertext: null, headersIv: null, headersTag: null }

/** Splits a config into the part stored in the clear and the sealed header columns. */
export const sealConfigHeaders = <E>(
	keyring: SecretKeyring,
	ref: MonitorRef,
	config: UptimeMonitorConfig,
	onError: (reason: string) => E,
): Effect.Effect<{ readonly configJson: UptimeMonitorConfig } & StoredUptimeHeaders, E> => {
	if (config._tag === "multistep") {
		const perStep = Arr.map(config.steps, (step) => step.headers)
		if (Arr.every(perStep, Rec.isEmptyRecord))
			return Effect.succeed({ configJson: config, ...NO_HEADERS })
		return encodeStepHeaders(perStep).pipe(
			Effect.mapError(() => onError("Headers could not be encoded")),
			Effect.flatMap((json) => sealSecret(keyring, uptimeMonitorHeadersSlot, ref, json, onError)),
			Effect.map((sealed) => ({
				configJson: { ...config, steps: Arr.map(config.steps, (step) => ({ ...step, headers: {} })) },
				headersCiphertext: sealed.ciphertext,
				headersIv: sealed.iv,
				headersTag: sealed.tag,
			})),
		)
	}
	return config._tag !== "http" || Rec.isEmptyRecord(config.headers)
		? Effect.succeed({ configJson: config, ...NO_HEADERS })
		: encodeHeaders(config.headers).pipe(
				Effect.mapError(() => onError("Headers could not be encoded")),
				Effect.flatMap((json) => sealSecret(keyring, uptimeMonitorHeadersSlot, ref, json, onError)),
				Effect.map((sealed) => ({
					configJson: { ...config, headers: {} },
					headersCiphertext: sealed.ciphertext,
					headersIv: sealed.iv,
					headersTag: sealed.tag,
				})),
			)
}

/** The config with its headers taken from the sealed columns, the only place they are read from. */
export const openConfigHeaders = <E>(
	keyring: SecretKeyring,
	row: MonitorRef & StoredUptimeHeaders,
	config: UptimeMonitorConfig,
	onError: (reason: string) => E,
): Effect.Effect<UptimeMonitorConfig, E> => {
	if (config._tag === "multistep") {
		if (row.headersCiphertext === null || row.headersIv === null || row.headersTag === null)
			return Effect.succeed(config)
		return openSecret(
			keyring,
			uptimeMonitorHeadersSlot,
			{ orgId: row.orgId, id: row.id },
			{ ciphertext: row.headersCiphertext, iv: row.headersIv, tag: row.headersTag },
			onError,
		).pipe(
			Effect.flatMap((json) =>
				decodeStepHeaders(json).pipe(
					Effect.mapError(() => onError("Stored step headers are not a list of string maps")),
				),
			),
			Effect.map((perStep) => ({
				...config,
				steps: Arr.map(config.steps, (step, index) => ({ ...step, headers: perStep[index] ?? {} })),
			})),
		)
	}
	if (config._tag !== "http") return Effect.succeed(config)
	if (row.headersCiphertext === null || row.headersIv === null || row.headersTag === null) {
		const unsealed = { ...config, headers: {} }
		// Nothing writes headers into the config any more, so say so when a row still has them:
		// they are not sent, and the check would otherwise just start failing.
		return Rec.isEmptyRecord(config.headers)
			? Effect.succeed(unsealed)
			: Effect.logWarning("Uptime monitor has request headers outside the sealed columns").pipe(
					Effect.annotateLogs({
						"maple.uptime.monitor_id": row.id,
						orgId: row.orgId,
						"maple.uptime.unsealed_header_count": Rec.size(config.headers),
					}),
					Effect.as(unsealed),
				)
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
