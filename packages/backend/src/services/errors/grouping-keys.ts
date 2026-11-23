import * as PG from "@maple-dev/effect-orm/postgres"
import type { MapleDb, MapleDbError } from "@maple/db/client"
import { ErrorGroupingKeys } from "@maple/db/tables"
import type { OrgId } from "@maple/domain/http"
import { resolveCustomFingerprint } from "@maple/domain/tinybird/fingerprint"
import {
	GROUPING_KEY_VERSION,
	groupingKey,
	groupingParts,
	type GroupingRule,
	type GroupingSample,
} from "@maple/domain/tinybird/grouping"
import { Array as Arr, type DateTime, Effect, Option, Schema } from "effect"

import { describeCause } from "./error-persistence"

/** Hashes keyed per tick at most; the rest wait for their next occurrence. */
export const GROUPING_KEYS_PER_TICK = 200
/** Siblings handed to one hash at most: enough to fold a group, bounded for a storm. */
const MAX_SIBLINGS = 50
const CHUNK = 500

export interface GroupingSampleRow {
	readonly fingerprintHash: string
	readonly serviceName: string
	readonly timestamp: DateTime.Utc
	readonly traceId: string
	readonly spanId: string
	readonly exceptionType: string
	readonly statusMessage: string
	readonly exceptionStacktrace: string
}

export interface GroupingSpanRow {
	readonly traceId: string
	readonly spanId: string
	readonly spanName: string
	readonly spanKind: string
	readonly spanFingerprint: string
	readonly eventsName: string
	readonly eventsAttributes: string
}

export interface ComputedKey {
	readonly fingerprintHash: string
	readonly groupingKey: string
	readonly rule: GroupingRule
}

const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown))
const decodeNames = Schema.decodeUnknownOption(Schema.Array(Schema.String))
const decodeAttributes = Schema.decodeUnknownOption(Schema.Array(Schema.Record(Schema.String, Schema.String)))

/** The first exception event's `maple.fingerprint`, as the error-events view reads it. */
const eventFingerprint = (span: GroupingSpanRow): string | undefined => {
	const names = Option.getOrElse(Option.flatMap(decodeJson(span.eventsName), decodeNames), () => [])
	const attributes = Option.getOrElse(
		Option.flatMap(decodeJson(span.eventsAttributes), decodeAttributes),
		() => [],
	)
	const index = Arr.findFirstIndex(names, (name) => name === "exception")
	return Option.getOrUndefined(
		Option.flatMap(index, (i) => Option.fromNullishOr(attributes[i]?.["maple.fingerprint"])),
	)
}

/**
 * The key for each sample whose span was found. A sample without its span is left
 * unkeyed: its `maple.fingerprint` is unknown, and grouping it could undo a split the
 * user chose. It is tried again when the hash next occurs.
 */
export const computeGroupingKeys = (
	samples: ReadonlyArray<GroupingSampleRow>,
	spans: ReadonlyArray<GroupingSpanRow>,
): Array<ComputedKey> => {
	const spanOf = new Map(Arr.map(spans, (span) => [`${span.traceId}:${span.spanId}`, span] as const))
	return Arr.flatMap(samples, (sample) => {
		const span = spanOf.get(`${sample.traceId}:${sample.spanId}`)
		if (span === undefined) return []
		const customFingerprint = resolveCustomFingerprint(
			eventFingerprint(span),
			span.spanFingerprint === "" ? undefined : span.spanFingerprint,
		)
		const base: GroupingSample = {
			serviceName: sample.serviceName,
			exceptionType: sample.exceptionType,
			statusMessage: sample.statusMessage,
			exceptionStacktrace: sample.exceptionStacktrace,
			span: { kind: span.spanKind, name: span.spanName },
		}
		const input: GroupingSample = customFingerprint === undefined ? base : { ...base, customFingerprint }
		return [
			{
				fingerprintHash: sample.fingerprintHash,
				groupingKey: groupingKey(input),
				rule: groupingParts(input).rule,
			},
		]
	})
}

export interface GroupingKeyReads<E> {
	readonly samples: (hashes: ReadonlyArray<string>) => Effect.Effect<ReadonlyArray<GroupingSampleRow>, E>
	readonly spans: (
		samples: ReadonlyArray<GroupingSampleRow>,
	) => Effect.Effect<ReadonlyArray<GroupingSpanRow>, E>
}

const storedKeys = (db: MapleDb, orgId: OrgId, hashes: ReadonlyArray<string>) =>
	Effect.forEach(Arr.chunksOf(hashes, CHUNK), (chunk) =>
		db.run(
			PG.from(ErrorGroupingKeys)
				.select("fingerprintHash", "groupingKey", "keyVersion", "configDigest", "pinned")
				.where(($) => [$.orgId.eq(orgId), $.fingerprintHash.in_(...chunk)]),
		),
	).pipe(Effect.map(Arr.flatten))

/**
 * Key the hashes that have no current key yet, then return, for each hash, the other
 * hashes sharing its key. The tick treats those siblings as it treats the hashes a
 * fingerprint bump replaced: a new hash joins the issue its siblings belong to, and
 * issues a key unites are folded into one. A pinned hash has no siblings and is no one's.
 *
 * Best effort, like the bump lineage: a failed read keys nothing and groups nothing.
 */
export const resolveGroupingSiblings = <EDb, ERead>(
	dbRun: <A>(run: (db: MapleDb) => Effect.Effect<A, MapleDbError>) => Effect.Effect<A, EDb>,
	reads: GroupingKeyReads<ERead>,
	input: {
		readonly orgId: OrgId
		readonly hashes: ReadonlyArray<string>
		readonly nowMs: number
		/** The org's grouping rules, as `groupingConfigDigest` names them; "" for none. */
		readonly configDigest: string
	},
): Effect.Effect<ReadonlyMap<string, ReadonlyArray<string>>> =>
	Effect.gen(function* () {
		const { orgId, nowMs, configDigest } = input
		const isCurrent = (row: { readonly keyVersion: number; readonly configDigest: string }) =>
			row.keyVersion === GROUPING_KEY_VERSION && row.configDigest === configDigest
		const hashes = Arr.dedupe(input.hashes)
		if (hashes.length === 0) return new Map()
		const stored = yield* dbRun((tx) => storedKeys(tx, orgId, hashes))
		const current = new Set(
			Arr.map(
				Arr.filter(stored, isCurrent),
				(row) => row.fingerprintHash,
			),
		)
		const unkeyed = Arr.filter(hashes, (hash) => !current.has(hash)).slice(0, GROUPING_KEYS_PER_TICK)
		const samples = unkeyed.length === 0 ? [] : yield* reads.samples(unkeyed)
		const spans = samples.length === 0 ? [] : yield* reads.spans(samples)
		const computed = computeGroupingKeys(samples, spans)
		if (computed.length > 0) {
			yield* dbRun((tx) =>
				Effect.forEach(
					Arr.chunksOf(computed, CHUNK),
					(chunk) =>
						tx.run(
							PG.insertInto(ErrorGroupingKeys)
								.values(
									Arr.map(chunk, (row) => ({
										orgId,
										fingerprintHash: row.fingerprintHash,
										groupingKey: row.groupingKey,
										keyVersion: GROUPING_KEY_VERSION,
										configDigest,
										rule: row.rule,
										pinned: false,
										createdAt: nowMs,
										updatedAt: nowMs,
									})),
								)
								.onConflictDoUpdate({
									target: ["orgId", "fingerprintHash"],
									// A pinned hash keeps its pin across a key version.
									set: PG.excluded(["groupingKey", "keyVersion", "configDigest", "rule", "updatedAt"]),
								}),
						),
					{ discard: true },
				),
			)
		}
		const pinned = new Set(
			Arr.map(
				Arr.filter(stored, (row) => row.pinned),
				(row) => row.fingerprintHash,
			),
		)
		const keyOf = new Map<string, string>([
			...Arr.map(
				Arr.filter(stored, (row) => isCurrent(row) && !row.pinned),
				(row) => [row.fingerprintHash, row.groupingKey] as const,
			),
			...Arr.flatMap(computed, (row) =>
				pinned.has(row.fingerprintHash) ? [] : [[row.fingerprintHash, row.groupingKey] as const],
			),
		])
		const keys = Arr.dedupe([...keyOf.values()])
		if (keys.length === 0) return new Map()
		const members = yield* dbRun((tx) =>
			Effect.forEach(Arr.chunksOf(keys, CHUNK), (chunk) =>
				tx.run(
					PG.from(ErrorGroupingKeys)
						.select("fingerprintHash", "groupingKey", "createdAt")
						.where(($) => [
							$.orgId.eq(orgId),
							$.groupingKey.in_(...chunk),
							$.keyVersion.eq(GROUPING_KEY_VERSION),
							$.configDigest.eq(configDigest),
							$.pinned.eq(false),
						])
						.orderBy(["createdAt", "asc"], ["fingerprintHash", "asc"]),
				),
			).pipe(Effect.map(Arr.flatten)),
		)
		const byKey = Arr.groupBy(members, (row) => row.groupingKey)
		return new Map(
			Arr.flatMap([...keyOf], ([hash, key]) => {
				const siblings = Arr.filter(
					Arr.map(byKey[key] ?? [], (row) => row.fingerprintHash),
					(other) => other !== hash,
				).slice(0, MAX_SIBLINGS)
				return siblings.length === 0 ? [] : [[hash, siblings] as const]
			}),
		)
	}).pipe(
		Effect.catch((error) =>
			Effect.as(
				Effect.logWarning("Error tick grouping keys failed").pipe(
					Effect.annotateLogs({ orgId: input.orgId, cause: describeCause(error) }),
				),
				new Map<string, ReadonlyArray<string>>(),
			),
		),
		Effect.withSpan("ErrorsService.groupingSiblings", {
			attributes: { "maple.errors.grouping.hashes": input.hashes.length },
		}),
	)

/**
 * Keep hashes out of every group, from an unmerge or a detach. A hash not keyed yet is
 * stored pinned under its own key, so the tick never keys it into a group later.
 */
export const pinGroupingKeys = (
	db: MapleDb,
	orgId: OrgId,
	hashes: ReadonlyArray<string>,
	nowMs: number,
): Effect.Effect<void, MapleDbError> =>
	Effect.forEach(
		Arr.chunksOf(Arr.dedupe(hashes), CHUNK),
		(chunk) =>
			db.run(
				PG.insertInto(ErrorGroupingKeys)
					.values(
						Arr.map(chunk, (fingerprintHash) => ({
							orgId,
							fingerprintHash,
							groupingKey: `pinned:${fingerprintHash}`,
							keyVersion: GROUPING_KEY_VERSION,
							rule: "frames" as const,
							pinned: true,
							createdAt: nowMs,
							updatedAt: nowMs,
						})),
					)
					.onConflictDoUpdate({
						target: ["orgId", "fingerprintHash"],
						set: { pinned: true, updatedAt: nowMs },
					}),
			),
		{ discard: true },
	)
