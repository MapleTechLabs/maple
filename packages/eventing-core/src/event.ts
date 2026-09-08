import { createHash } from "node:crypto"
import { Result, Schema } from "effect"
import {
	MapleCloudEventSchema,
	type JsonValue,
	type MapleCloudEvent,
	type NormalizedSignal,
	type SignalProjectionSpec,
} from "./model"
import { timestampToEpochNanos } from "./predicate"

export const MAX_CLOUD_EVENT_BYTES = 256 * 1024

export interface EventIdentityInput {
	readonly tenantId: string
	readonly sourceKind: string
	readonly source: string
	readonly occurrenceId: string
	readonly projectionId: string
	readonly projectionRevision: number
}

const updateLengthDelimited = (hash: ReturnType<typeof createHash>, value: string): void => {
	const encoded = Buffer.from(value, "utf8")
	const length = Buffer.allocUnsafe(4)
	length.writeUInt32BE(encoded.byteLength)
	hash.update(length)
	hash.update(encoded)
}

/** Canonical v1 identity shared by every host implementation. */
export const makeEventId = (input: EventIdentityInput): string => {
	const hash = createHash("sha256")
	for (const field of [
		"maple-event-v1",
		input.tenantId,
		input.sourceKind,
		input.source,
		input.occurrenceId,
		input.projectionId,
		String(input.projectionRevision),
	])
		updateLengthDelimited(hash, field)
	return `sha256:${hash.digest("hex")}`
}

export const isJsonValue = (value: unknown, seen: Set<object> = new Set()): value is JsonValue => {
	if (value === null || typeof value === "string" || typeof value === "boolean") return true
	if (typeof value === "number") return Number.isFinite(value)
	if (typeof value !== "object") return false
	if (seen.has(value)) return false
	seen.add(value)
	const prototype = Object.getPrototypeOf(value)
	const valid = Array.isArray(value)
		? value.every((item) => isJsonValue(item, seen))
		: (prototype === Object.prototype || prototype === null) &&
			Object.values(value).every((item) => isJsonValue(item, seen))
	seen.delete(value)
	return valid
}

const canonicalizeJson = (value: JsonValue): JsonValue => {
	if (value === null || typeof value !== "object") return value
	if (Array.isArray(value)) return value.map(canonicalizeJson)
	return Object.fromEntries(
		Object.entries(value)
			.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
			.map(([key, child]) => [key, canonicalizeJson(child)]),
	)
}

/** Stable JSON encoding for outbox collision checks and cross-host fixtures. */
export const canonicalJson = (value: JsonValue): string => {
	Schema.decodeUnknownSync(
		Schema.Unknown.check(
			Schema.makeFilter((value) => isJsonValue(value), { expected: "finite acyclic JSON" }),
		),
	)(value)
	return JSON.stringify(canonicalizeJson(value))
}

export interface ValidatedMapleCloudEvent {
	readonly event: MapleCloudEvent
	readonly canonicalJson: string
	readonly byteLength: number
}

export class CloudEventInvalid extends Schema.TaggedError<CloudEventInvalid>()(
	"@maple/eventing-core/CloudEventInvalid",
	{ message: Schema.String, cause: Schema.Defect() },
) {}

/** Validate the persisted envelope and byte budget without throwing into host fibers. */
export const validateMapleCloudEvent = (
	candidate: unknown,
): Result.Result<ValidatedMapleCloudEvent, CloudEventInvalid> =>
	Result.gen(function* () {
		const event = yield* Schema.decodeUnknownResult(MapleCloudEventSchema)(candidate)
		const eventJson = JSON.stringify(canonicalizeJson(event))
		const byteLength = Buffer.byteLength(eventJson, "utf8")
		yield* Schema.decodeUnknownResult(
			Schema.Number.check(
				Schema.isLessThanOrEqualTo(MAX_CLOUD_EVENT_BYTES, {
					message: `CloudEvent exceeds ${MAX_CLOUD_EVENT_BYTES} UTF-8 bytes`,
				}),
			),
		)(byteLength)
		return { event, canonicalJson: eventJson, byteLength }
	}).pipe(Result.mapError((cause) => new CloudEventInvalid({ message: cause.message, cause })))

export const makeCloudEvent = (input: {
	readonly signal: NormalizedSignal
	readonly projection: SignalProjectionSpec
	readonly projectorId: string
	readonly projectorVersion: number
	readonly outputType: string
	readonly dataSchema: string
	readonly subject?: string | null
	readonly time?: string
	readonly data: JsonValue
}): Result.Result<MapleCloudEvent, CloudEventInvalid> =>
	Result.gen(function* () {
		const identity = yield* Schema.decodeUnknownResult(
			Schema.Struct({
				occurrenceId: Schema.NonEmptyString.check(Schema.isTrimmed()),
				identityQuality: Schema.Literals(["source", "derived"]),
			}),
		)(input.signal).pipe(
			Result.mapError(
				(cause) =>
					new CloudEventInvalid({
						message: "durable event projection requires stable or derived occurrence identity",
						cause,
					}),
			),
		)
		const subject = input.subject === undefined ? input.signal.subject : input.subject
		const time = input.time ?? input.signal.occurredAt
		yield* Schema.decodeUnknownResult(
			Schema.String.check(
				Schema.makeFilter((value) => timestampToEpochNanos(value) !== null, {
					expected: "a valid event instant",
				}),
			),
		)(time).pipe(Result.mapError((cause) => new CloudEventInvalid({ message: cause.message, cause })))
		const envelope = {
			specversion: "1.0",
			id: makeEventId({
				tenantId: input.signal.tenantId,
				sourceKind: input.signal.sourceKind,
				source: input.signal.source,
				occurrenceId: identity.occurrenceId,
				projectionId: input.projection.id,
				projectionRevision: input.projection.revision,
			}),
			source: input.signal.source,
			type: input.outputType,
			time,
			datacontenttype: "application/json",
			dataschema: input.dataSchema,
			tenantid: input.signal.tenantId,
			projectionid: input.projection.id,
			projectionrevision: input.projection.revision,
			projectorid: input.projectorId,
			projectorversion: input.projectorVersion,
			sourceoccurrenceid: identity.occurrenceId,
			identityquality: identity.identityQuality,
			data: input.data,
		}
		return yield* validateMapleCloudEvent(subject == null ? envelope : { ...envelope, subject }).pipe(
			Result.map(({ event }) => event),
		)
	})
