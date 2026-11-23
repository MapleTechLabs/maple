import * as PG from "@maple-dev/effect-orm/postgres"
import type { MapleDb, MapleDbError } from "@maple/db/client"
import { ErrorGroupingConfigs, ErrorGroupingKeys } from "@maple/db/tables"
import type { OrgId, TenantContext, WarehouseReadError } from "@maple/domain/http"
import { CH } from "@maple/query-engine"
import type { WarehouseQueryService } from "@maple/backend/services/warehouse/WarehouseQueryService"
import { resolveCustomFingerprint } from "@maple/domain/tinybird/fingerprint"
import {
	compileGroupingRules,
	type CompiledGroupingRules,
	EMPTY_GROUPING_CONFIG,
	GroupingConfig,
	groupingConfigDigest,
} from "@maple/domain/tinybird/grouping-rules"
import {
	GROUPING_KEY_VERSION,
	groupingParts,
	keyOfParts,
	type GroupingRule,
	type GroupingSample,
} from "@maple/domain/tinybird/grouping"
import { Array as Arr, DateTime, Effect, Option, Order, Schema } from "effect"

import { describeCause } from "./error-persistence"

/** Hashes keyed per tick at most; the rest wait for their next occurrence. */
const GROUPING_KEYS_PER_TICK = 200
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
 * What the grouping key reads for each sample whose span was found. A sample without its
 * span is left out: its `maple.fingerprint` is unknown, and grouping it could undo a split
 * the user chose. It is tried again when the hash next occurs.
 */
export const computeSampleInputs = (
	samples: ReadonlyArray<GroupingSampleRow>,
	spans: ReadonlyArray<GroupingSpanRow>,
): Array<{ readonly fingerprintHash: string; readonly input: GroupingSample }> => {
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
		return [{ fingerprintHash: sample.fingerprintHash, input }]
	})
}

const computeGroupingKeys = (
	samples: ReadonlyArray<GroupingSampleRow>,
	spans: ReadonlyArray<GroupingSpanRow>,
	rules?: CompiledGroupingRules,
): Array<ComputedKey> =>
	Arr.map(computeSampleInputs(samples, spans), ({ fingerprintHash, input }) => {
		const parts = groupingParts(input, rules)
		return { fingerprintHash, groupingKey: keyOfParts(input.serviceName, parts), rule: parts.rule }
	})

/** The org's grouping rules, compiled, and the digest stored keys are checked against. */
export interface OrgGrouping {
	readonly config: GroupingConfig
	readonly rules: CompiledGroupingRules
	readonly digest: string
	readonly updatedAt: number | null
}

export const DEFAULT_ORG_GROUPING: OrgGrouping = {
	config: EMPTY_GROUPING_CONFIG,
	rules: compileGroupingRules(EMPTY_GROUPING_CONFIG),
	digest: "",
	updatedAt: null,
}

export const loadOrgGrouping = (db: MapleDb, orgId: OrgId): Effect.Effect<OrgGrouping, MapleDbError> =>
	db
		.run(
			PG.from(ErrorGroupingConfigs)
				.select("rulesJson", "updatedAt")
				.where(($) => [$.orgId.eq(orgId)]),
		)
		.pipe(
			Effect.map(([row]) => {
				const config = new GroupingConfig({ rules: row?.rulesJson ?? [] })
				return {
					config,
					rules: compileGroupingRules(config),
					digest: groupingConfigDigest(config),
					updatedAt: row?.updatedAt ?? null,
				}
			}),
		)

type Warehouse = (typeof WarehouseQueryService)["Service"]
const SPAN_WINDOW_MS = 60_000
/** Samples further apart get their own traces read; past the cap the newest clusters win. */
const SPAN_CLUSTER_GAP_MS = 10 * 60_000
const MAX_SPAN_READS = 10

/**
 * The warehouse reads behind a grouping key: one sample per hash in `window`, then the
 * spans behind them, read in narrow windows around clusters of sample times.
 */
export const warehouseGroupingReads = (
	warehouse: Warehouse,
	tenant: TenantContext,
	orgId: OrgId,
	window: { readonly startMs: number; readonly endMs: number },
	context: string,
): GroupingKeyReads<WarehouseReadError> => ({
	samples: (hashes) =>
		warehouse.compiledQuery(
			tenant,
			CH.compile(CH.errorGroupingSamplesQuery({ fingerprintHashes: hashes }), {
				orgId,
				startTime: DateTime.makeUnsafe(window.startMs),
				endTime: DateTime.makeUnsafe(window.endMs),
			}),
			{ profile: "list", context: `${context}Samples` },
		),
	spans: (samples) => {
		const sorted = Arr.sort(
			samples,
			Order.mapInput(Order.Number, (sample: GroupingSampleRow) =>
				DateTime.toEpochMillis(sample.timestamp),
			),
		)
		const clusters = Arr.reduce(sorted, [] as Array<Array<GroupingSampleRow>>, (acc, sample) => {
			const last = acc[acc.length - 1]
			const previous = last?.[last.length - 1]
			return previous !== undefined &&
				DateTime.toEpochMillis(sample.timestamp) - DateTime.toEpochMillis(previous.timestamp) <=
					SPAN_CLUSTER_GAP_MS
				? [...acc.slice(0, -1), [...(last ?? []), sample]]
				: [...acc, [sample]]
		}).slice(-MAX_SPAN_READS)
		return Effect.forEach(
			clusters,
			(cluster) => {
				const times = Arr.map(cluster, (sample) => DateTime.toEpochMillis(sample.timestamp))
				return warehouse.compiledQuery(
					tenant,
					CH.compile(
						CH.errorGroupingSpansQuery({
							serviceNames: Arr.dedupe(Arr.map(cluster, (sample) => sample.serviceName)),
							traceIds: Arr.dedupe(Arr.map(cluster, (sample) => sample.traceId)),
							spanIds: Arr.dedupe(Arr.map(cluster, (sample) => sample.spanId)),
						}),
						{
							orgId,
							// error_events keeps whole seconds; a span starts within its second.
							startTime: DateTime.makeUnsafe(Math.min(...times) - SPAN_WINDOW_MS),
							endTime: DateTime.makeUnsafe(Math.max(...times) + SPAN_WINDOW_MS),
						},
					),
					{ profile: "list", context: `${context}Spans` },
				)
			},
			{ concurrency: 2 },
		).pipe(Effect.map(Arr.flatten))
	},
})

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
		readonly grouping: OrgGrouping
		/** The hashes a bump replaced, per hash: a pin carries over to the new hash. */
		readonly lineage: ReadonlyMap<string, ReadonlyArray<string>>
	},
): Effect.Effect<ReadonlyMap<string, ReadonlyArray<string>>> =>
	Effect.gen(function* () {
		const { orgId, nowMs } = input
		const configDigest = input.grouping.digest
		const isCurrent = (row: { readonly keyVersion: number; readonly configDigest: string }) =>
			row.keyVersion === GROUPING_KEY_VERSION && row.configDigest === configDigest
		const hashes = Arr.dedupe(input.hashes)
		if (hashes.length === 0) return new Map()
		const stored = yield* dbRun((tx) => storedKeys(tx, orgId, hashes))
		const current = new Set(Arr.map(Arr.filter(stored, isCurrent), (row) => row.fingerprintHash))
		// Hashes never keyed first (likely new issues), then stale keys after a rules change.
		const storedHashes = new Set(Arr.map(stored, (row) => row.fingerprintHash))
		const unkeyed = [
			...Arr.filter(hashes, (hash) => !storedHashes.has(hash)),
			...Arr.filter(hashes, (hash) => storedHashes.has(hash) && !current.has(hash)),
		].slice(0, GROUPING_KEYS_PER_TICK)
		const samples = unkeyed.length === 0 ? [] : yield* reads.samples(unkeyed)
		const spans = samples.length === 0 ? [] : yield* reads.spans(samples)
		const computed = computeGroupingKeys(samples, spans, input.grouping.rules)
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
									set: PG.excluded([
										"groupingKey",
										"keyVersion",
										"configDigest",
										"rule",
										"updatedAt",
									]),
								}),
						),
					{ discard: true },
				),
			)
		}
		const previousHashes = Arr.dedupe(Arr.flatten([...input.lineage.values()]))
		const pinnedPreviousRows =
			previousHashes.length === 0
				? []
				: yield* dbRun((tx) =>
						Effect.forEach(Arr.chunksOf(previousHashes, CHUNK), (chunk) =>
							tx.run(
								PG.from(ErrorGroupingKeys)
									.select("fingerprintHash")
									.where(($) => [
										$.orgId.eq(orgId),
										$.pinned.eq(true),
										$.fingerprintHash.in_(...chunk),
									]),
							),
						).pipe(Effect.map(Arr.flatten)),
					)
		const pinnedPrevious = new Set(Arr.map(pinnedPreviousRows, (row) => row.fingerprintHash))
		// A hash whose previous version was unmerged or detached stays out of groups too.
		const inheritsPin = Arr.filter(
			hashes,
			(hash) =>
				!Arr.some(stored, (row) => row.fingerprintHash === hash && row.pinned) &&
				Arr.some(input.lineage.get(hash) ?? [], (previous) => pinnedPrevious.has(previous)),
		)
		if (inheritsPin.length > 0) yield* dbRun((tx) => pinGroupingKeys(tx, orgId, inheritsPin, nowMs))
		const pinned = new Set([
			...Arr.map(
				Arr.filter(stored, (row) => row.pinned),
				(row) => row.fingerprintHash,
			),
			...inheritsPin,
		])
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
		// The oldest members of each key, capped in Postgres: a settled group keeps growing
		// (a chunk-load key gains a hash per deploy) but only the first few find its issue.
		const members = yield* dbRun((tx) =>
			Effect.forEach(Arr.chunksOf(keys, CHUNK), (chunk) =>
				tx.run(
					PG.from(ErrorGroupingKeys)
						.select(($) => ({
							groupingKey: $.groupingKey,
							hashes: PG.sql(
								PG.array(PG.text),
							)`(array_agg(${$.fingerprintHash} order by ${$.createdAt}, ${$.fingerprintHash}))[1:${MAX_SIBLINGS + 1}]`,
						}))
						.where(($) => [
							$.orgId.eq(orgId),
							$.groupingKey.in_(...chunk),
							$.keyVersion.eq(GROUPING_KEY_VERSION),
							$.configDigest.eq(configDigest),
							$.pinned.eq(false),
						])
						.groupBy("groupingKey"),
				),
			).pipe(Effect.map(Arr.flatten)),
		)
		const byKey = new Map(Arr.map(members, (row) => [row.groupingKey, row.hashes] as const))
		return new Map(
			Arr.flatMap([...keyOf], ([hash, key]) => {
				const siblings = Arr.filter(byKey.get(key) ?? [], (other) => other !== hash).slice(
					0,
					MAX_SIBLINGS,
				)
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
			attributes: { "maple.grouping.hashes": input.hashes.length },
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
