/**
 * How an HTTP or multi-step check's request headers and bodies are stored: sealed together in
 * `headers_{ciphertext,iv,tag}`, with `config_json` holding neither. They carry credentials
 * (`Authorization`, API keys, login payloads), so they do not sit in the config in the clear
 * (docs/secret-encryption.md).
 */
import type { UptimeMonitorConfig } from "@maple/domain/uptime"
import { Effect, Record as Rec, Schema, Array as Arr } from "effect"
import { openSecret, sealSecret, type SecretKeyring } from "@maple/backend/platform/SecretBox"
import { uptimeMonitorHeadersSlot } from "@maple/backend/platform/secret-slots"

const HeaderMap = Schema.Record(Schema.String, Schema.String)
const SealedRequest = Schema.Struct({ headers: HeaderMap, body: Schema.optionalKey(Schema.String) })
type SealedRequest = Schema.Schema.Type<typeof SealedRequest>
/**
 * The sealed JSON: one entry per request, in step order (an HTTP check has one). `v` is a number,
 * which no header map holds, so this never reads as one of the older shapes below.
 */
const SealedRequestsJson = Schema.fromJsonString(
	Schema.Struct({ v: Schema.Literal(2), requests: Schema.Array(SealedRequest) }),
)
const encodeRequests = Schema.encodeEffect(SealedRequestsJson)
const decodeRequests = Schema.decodeEffect(SealedRequestsJson)
// Rows sealed before bodies were: an HTTP check's header map, or one header map per step.
const decodeHeaders = Schema.decodeEffect(Schema.fromJsonString(HeaderMap))
const decodeStepHeaders = Schema.decodeEffect(Schema.fromJsonString(Schema.Array(HeaderMap)))

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

interface RequestSecrets {
	readonly headers: Readonly<Record<string, string>>
	readonly body?: string
}

const secretsOf = (request: RequestSecrets): SealedRequest => ({
	headers: request.headers,
	...(request.body === undefined ? undefined : { body: request.body }),
})

/** A request as `config_json` keeps it: no header values and no body. */
const withoutSecrets = <A extends RequestSecrets>(request: A) => {
	const { body: _sealed, ...rest } = request
	return { ...rest, headers: {} }
}

/** A request with what the sealed entry holds; a body still in `config_json` stays until the next write. */
const withSecrets = <A extends RequestSecrets>(request: A, sealed: SealedRequest | undefined) => {
	const body = sealed?.body ?? request.body
	return {
		...request,
		headers: sealed?.headers ?? {},
		...(body === undefined ? undefined : { body }),
	}
}

/** Whether `config_json` still holds a request body in the clear, from before bodies were sealed. */
export const hasUnsealedBody = (config: UptimeMonitorConfig): boolean =>
	config._tag === "multistep"
		? Arr.some(config.steps, (step) => step.body !== undefined)
		: config._tag === "http" && config.body !== undefined

/** Splits a config into the part stored in the clear and the sealed columns. */
export const sealConfigSecrets = <E>(
	keyring: SecretKeyring,
	ref: MonitorRef,
	config: UptimeMonitorConfig,
	onError: (reason: string) => E,
): Effect.Effect<{ readonly configJson: UptimeMonitorConfig } & StoredUptimeHeaders, E> => {
	if (config._tag !== "http" && config._tag !== "multistep")
		return Effect.succeed({ configJson: config, ...NO_HEADERS })
	const requests: ReadonlyArray<RequestSecrets> = config._tag === "multistep" ? config.steps : [config]
	if (Arr.every(requests, (request) => Rec.isEmptyRecord(request.headers) && request.body === undefined))
		return Effect.succeed({ configJson: config, ...NO_HEADERS })
	const configJson: UptimeMonitorConfig =
		config._tag === "multistep"
			? { ...config, steps: Arr.map(config.steps, withoutSecrets) }
			: withoutSecrets(config)
	return encodeRequests({ v: 2, requests: Arr.map(requests, secretsOf) }).pipe(
		Effect.mapError(() => onError("Headers and body could not be encoded")),
		Effect.flatMap((json) =>
			sealSecret(keyring, uptimeMonitorHeadersSlot, { ...ref, config: configJson }, json, onError),
		),
		Effect.map((sealed) => ({
			configJson,
			headersCiphertext: sealed.ciphertext,
			headersIv: sealed.iv,
			headersTag: sealed.tag,
		})),
	)
}

/** The sealed entries of a multi-step check, in either shape. */
const decodeStepSecrets = (json: string) =>
	decodeRequests(json).pipe(
		Effect.map((sealed) => sealed.requests),
		Effect.catch(() =>
			Effect.map(decodeStepHeaders(json), (perStep) =>
				Arr.map(perStep, (headers): SealedRequest => ({ headers })),
			),
		),
	)

/** The sealed entry of an HTTP check, in either shape. */
const decodeHttpSecrets = (json: string) =>
	decodeRequests(json).pipe(
		Effect.map((sealed) => sealed.requests[0]),
		Effect.catch(() => Effect.map(decodeHeaders(json), (headers): SealedRequest => ({ headers }))),
	)

/** The config with its headers and bodies taken from the sealed columns. */
export const openConfigSecrets = <E>(
	keyring: SecretKeyring,
	row: MonitorRef & StoredUptimeHeaders,
	config: UptimeMonitorConfig,
	onError: (reason: string) => E,
): Effect.Effect<UptimeMonitorConfig, E> => {
	if (config._tag !== "http" && config._tag !== "multistep") return Effect.succeed(config)
	if (row.headersCiphertext === null || row.headersIv === null || row.headersTag === null) {
		if (config._tag === "multistep") return Effect.succeed(config)
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
	const opened = openSecret(
		keyring,
		uptimeMonitorHeadersSlot,
		{ orgId: row.orgId, id: row.id, config },
		{ ciphertext: row.headersCiphertext, iv: row.headersIv, tag: row.headersTag },
		onError,
	)
	if (config._tag === "multistep")
		return opened.pipe(
			Effect.flatMap((json) =>
				decodeStepSecrets(json).pipe(
					Effect.mapError(() => onError("Stored step headers are not a list of string maps")),
				),
			),
			Effect.map((perStep) => ({
				...config,
				steps: Arr.map(config.steps, (step, index) => withSecrets(step, perStep[index])),
			})),
		)
	return opened.pipe(
		Effect.flatMap((json) =>
			decodeHttpSecrets(json).pipe(
				Effect.mapError(() => onError("Stored headers are not a string map")),
			),
		),
		Effect.map((sealed) => withSecrets(config, sealed)),
	)
}
