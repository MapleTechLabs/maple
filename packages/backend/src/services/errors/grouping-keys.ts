import * as PG from "@maple-dev/effect-orm/postgres"
import type { MapleDb, MapleDbError } from "@maple/db/client"
import {
	ErrorFingerprintCandidates,
	ErrorGroupingConfigs,
	ErrorGroupingKeys,
	ErrorIssueFingerprints,
	ErrorIssues,
} from "@maple/db/tables"
import type { OrgId, TenantContext, WarehouseReadError } from "@maple/domain/http"
import { CH } from "@maple/query-engine"
import type { WarehouseQueryService } from "@maple/backend/services/warehouse/WarehouseQueryService"
import type { StackSymbolicatorApi } from "@maple/backend/services/sourcemaps/StackSymbolicator"
import type { SourceMapFileRow } from "@maple/db/tables"
import { hasDebugIdFor, isLookupUrl } from "@maple/backend/services/sourcemaps/source-map-files"
import { DEBUG_IDS_ATTRIBUTE, decodeDebugIds, isInAppPath, parseJsStack } from "@maple/domain/errors/js-stack"
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
import { Array as Arr, DateTime, Effect, Option, Order, String as Str } from "effect"

import { describeCause } from "./error-persistence"
import { exceptionEventAttribute } from "./exception-event"

/** Hashes keyed per tick at most; the rest wait for their next occurrence. */
const GROUPING_KEYS_PER_TICK = 200
/** Siblings handed to one hash at most: enough to fold a group, bounded for a storm. */
const MAX_SIBLINGS = 50
const CHUNK = 500
/** How long a sample whose app frames found no map waits for one: the deploy-then-upload gap. */
export const MAP_PENDING_GRACE_MS = 60 * 60_000
/** Source map lookups run at once per tick; each is cached per isolate by the symbolicator. */
const SYMBOLICATE_CONCURRENCY = 4

export interface GroupingSampleRow {
	readonly fingerprintHash: string
	readonly serviceName: string
	readonly serviceVersion: string
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

export interface SampleInput {
	readonly fingerprintHash: string
	readonly input: GroupingSample
	/** What a source map lookup needs beyond the sample. */
	readonly serviceVersion: string
	readonly debugIds: ReadonlyMap<string, string>
	/**
	 * The org has maps, yet the stack has frames one could map and none of its frames mapped:
	 * its map may still be on its way, so a young hash is not keyed yet.
	 */
	readonly mapPending?: boolean
	/** A map lookup or read failed: a key from this sample may be missing frames that do map. */
	readonly lookupFailed?: boolean
}

/**
 * What the grouping key reads for each sample whose span was found. A sample without its
 * span is left out: its `maple.fingerprint` is unknown, and grouping it could undo a split
 * the user chose. It is tried again when the hash next occurs.
 */
export const computeSampleInputs = (
	samples: ReadonlyArray<GroupingSampleRow>,
	spans: ReadonlyArray<GroupingSpanRow>,
): Array<SampleInput> => {
	const spanOf = new Map(Arr.map(spans, (span) => [`${span.traceId}:${span.spanId}`, span] as const))
	return Arr.flatMap(samples, (sample) => {
		const span = spanOf.get(`${sample.traceId}:${sample.spanId}`)
		if (span === undefined) return []
		const customFingerprint = resolveCustomFingerprint(
			exceptionEventAttribute(span, "maple.fingerprint"),
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
				input,
				serviceVersion: sample.serviceVersion,
				debugIds: decodeDebugIds(exceptionEventAttribute(span, DEBUG_IDS_ATTRIBUTE)),
			},
		]
	})
}

/**
 * In an org with no maps yet, a sample whose build registered debug ids is waiting for its first
 * upload: its frames could map, so a young hash is not keyed on raw frames.
 */
const withFirstMapPending = (entry: SampleInput, rules: CompiledGroupingRules | undefined): SampleInput => {
	if (entry.debugIds.size === 0) return entry
	const rule = groupingParts(entry.input, rules).rule
	if (rule !== "frames" && rule !== "type-function") return entry
	const frames = parseJsStack(entry.input.exceptionStacktrace).frames
	// Only a debug id recorded for one of this stack's own app frames says a map is coming.
	return Arr.some(
		frames,
		(frame) =>
			frame.url !== null &&
			hasDebugIdFor(frame.url, entry.debugIds) &&
			isAppFrame(frame, entry.input, rules),
	)
		? { ...entry, mapPending: true }
		: entry
}

/** An app frame by the org's frame rules (on the generated frame) first, else by its path. */
const isAppFrame = (
	frame: { readonly raw: string; readonly url: string | null },
	sample: GroupingSample,
	rules: CompiledGroupingRules | undefined,
): boolean => {
	const kind = rules?.frameKind(frame.raw, sample)
	return kind === undefined ? frame.url !== null && isInAppPath(frame.url) : kind === "app"
}

/**
 * Samples whose key reads frames, with their stack mapped through the org's source maps,
 * so a deploy's renamed bundle keeps its key. Only a JS stack with frame URLs is looked up;
 * every other sample, and every host without the symbolicator, keys as before.
 */
export const withSourceMappedStacks = (
	symbolicator: Option.Option<StackSymbolicatorApi>,
	orgId: OrgId,
	entries: ReadonlyArray<SampleInput>,
	rules?: CompiledGroupingRules,
): Effect.Effect<ReadonlyArray<SampleInput>> =>
	Option.match(symbolicator, {
		onNone: () => Effect.succeed(entries),
		onSome: (stacks) =>
			Effect.flatMap(
				Effect.all([
					stacks.hasSourceMaps(orgId),
					Effect.sync(() => new Map<string, SourceMapFileRow>()),
				]),
				// One lookup per frame URL for the whole tick, shared by its samples.
				([hasMaps, lookupMemo]) =>
					!hasMaps
						? Effect.succeed(Arr.map(entries, (entry) => withFirstMapPending(entry, rules)))
						: Effect.forEach(
								entries,
								(entry) => {
									const rule = groupingParts(entry.input, rules).rule
									const readsFrames = rule === "frames" || rule === "type-function"
									const frames = parseJsStack(entry.input.exceptionStacktrace).frames
									if (
										!readsFrames ||
										!Arr.some(
											frames,
											(frame) =>
												frame.url !== null && isLookupUrl(frame.url, entry.debugIds),
										)
									) {
										return Effect.succeed(entry)
									}
									return stacks
										.symbolicateWithOutcome({
											orgId,
											stacktrace: entry.input.exceptionStacktrace,
											serviceName:
												entry.input.serviceName === ""
													? null
													: entry.input.serviceName,
											serviceVersion:
												entry.serviceVersion === "" ? null : entry.serviceVersion,
											debugIds: entry.debugIds,
											lookupMemo,
										})
										.pipe(
											Effect.map(({ stack, lookupFailed }) => {
												// Decided on the raw frames: a vendor chunk whose frames map into
												// `node_modules` is mapped, not waiting.
												const candidate = (frame: (typeof frames)[number]) =>
													frame.url !== null &&
													isLookupUrl(frame.url, entry.debugIds) &&
													isAppFrame(frame, entry.input, rules)
												const unmapped = (i: number) =>
													stack.frames[i]?.resolved !== true
												// The throw site waits for its map even when a caller below it mapped:
												// keyed on that caller alone, two throw sites would share a key.
												const throwSiteWaits = Option.match(
													Arr.findFirstIndex(frames, candidate),
													{
														onNone: () => false,
														onSome: unmapped,
													},
												)
												const mapPending =
													throwSiteWaits ||
													// A dependency frame that mapped says nothing about the app's own map.
													(!Arr.some(
														stack.frames,
														(frame) => frame.resolved && frame.in_app,
													) &&
														Arr.some(
															frames,
															(frame, i) => candidate(frame) && unmapped(i),
														))
												return stack.status === "resolved" ||
													stack.status === "partial"
													? {
															...entry,
															input: {
																...entry.input,
																symbolicatedStack: stack,
															},
															mapPending,
															lookupFailed,
														}
													: { ...entry, mapPending, lookupFailed }
											}),
										)
								},
								{ concurrency: SYMBOLICATE_CONCURRENCY },
							),
			),
	})

const computeGroupingKeys = (
	entries: ReadonlyArray<SampleInput>,
	rules?: CompiledGroupingRules,
): Array<ComputedKey> =>
	Arr.map(entries, ({ fingerprintHash, input }) => {
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
	symbolicator: Option.Option<StackSymbolicatorApi> = Option.none(),
): GroupingKeyReads<WarehouseReadError> => ({
	sourceMapped: (entries, rules) => withSourceMappedStacks(symbolicator, orgId, entries, rules),
	mapsInPlay: Option.match(symbolicator, {
		onNone: () => Effect.succeedSome(false),
		onSome: (stacks) => stacks.sourceMapsKnown(orgId),
	}),
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
	/** The samples with their stacks source-mapped; absent, every sample keys on its raw stack. */
	readonly sourceMapped?: (
		entries: ReadonlyArray<SampleInput>,
		rules: CompiledGroupingRules,
	) => Effect.Effect<ReadonlyArray<SampleInput>>
	/** Whether the org has source maps, `None` when the lookup failed; absent, it has none. */
	readonly mapsInPlay?: Effect.Effect<Option.Option<boolean>>
}

const storedKeys = (db: MapleDb, orgId: OrgId, hashes: ReadonlyArray<string>) =>
	Effect.forEach(Arr.chunksOf(hashes, CHUNK), (chunk) =>
		db.run(
			PG.from(ErrorGroupingKeys)
				.select("fingerprintHash", "groupingKey", "keyVersion", "configDigest", "pinned", "rule")
				.where(($) => [$.orgId.eq(orgId), $.fingerprintHash.in_(...chunk)]),
		),
	).pipe(Effect.map(Arr.flatten))

/**
 * When each hash was first seen, from the rows the tick keeps for it: its candidate, its issue,
 * or its alias on another issue. A hash with none is being seen for the first time.
 */
const firstSeenOf = (
	db: MapleDb,
	orgId: OrgId,
	hashes: ReadonlyArray<string>,
): Effect.Effect<ReadonlyMap<string, number>, MapleDbError> =>
	Effect.forEach(Arr.chunksOf(hashes, CHUNK), (chunk) =>
		Effect.all([
			db.run(
				PG.from(ErrorFingerprintCandidates)
					.select("fingerprintHash", "firstSeenAt")
					.where(($) => [$.orgId.eq(orgId), $.fingerprintHash.in_(...chunk)]),
			),
			db.run(
				PG.from(ErrorIssues)
					.select("fingerprintHash", "firstSeenAt")
					.where(($) => [$.orgId.eq(orgId), $.fingerprintHash.in_(...chunk)]),
			),
			db.run(
				PG.from(ErrorIssueFingerprints)
					.select(($) => ({ fingerprintHash: $.fingerprintHash, firstSeenAt: $.createdAt }))
					.where(($) => [$.orgId.eq(orgId), $.fingerprintHash.in_(...chunk)]),
			),
		]),
	).pipe(
		Effect.map((chunks) =>
			Arr.reduce(Arr.flatten(Arr.flatten(chunks)), new Map<string, number>(), (seen, row) =>
				seen.set(
					row.fingerprintHash,
					Math.min(seen.get(row.fingerprintHash) ?? row.firstSeenAt, row.firstSeenAt),
				),
			),
		),
	)

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
		const hashes = Arr.dedupe(input.hashes)
		if (hashes.length === 0) return new Map()
		const mapsKnown = reads.mapsInPlay === undefined ? Option.some(false) : yield* reads.mapsInPlay
		const mapsInPlay = Option.getOrElse(mapsKnown, () => false)
		// Whether the org has maps is part of the digest, so a first upload re-keys its keys once.
		// An org without maps keeps the rules digest as it was.
		const withMaps = `${input.grouping.digest}+source-maps`
		const configDigest = mapsInPlay ? withMaps : input.grouping.digest
		// A failed lookup decides nothing: a key under either maps bit stays current this tick.
		const currentDigests = Option.isSome(mapsKnown) ? [configDigest] : [input.grouping.digest, withMaps]
		const isCurrent = (row: { readonly keyVersion: number; readonly configDigest: string }) =>
			row.keyVersion === GROUPING_KEY_VERSION && Arr.contains(currentDigests, row.configDigest)
		const stored = yield* dbRun((tx) => storedKeys(tx, orgId, hashes))
		const current = new Set(Arr.map(Arr.filter(stored, isCurrent), (row) => row.fingerprintHash))
		// Hashes never keyed first (likely new issues), then stale keys after a rules change.
		const storedHashes = new Set(Arr.map(stored, (row) => row.fingerprintHash))
		const neverKeyed = Arr.filter(hashes, (hash) => !storedHashes.has(hash))
		// Over the cap, the order decides who waits. Hashes held past their grace window come first,
		// up to half the slots (a hash whose span never turns up stays in that group, so it must not
		// hold every slot); then first sightings; then hashes still held and the rest of the expired,
		// each in an order that rotates every minute so none is stuck behind the same prefix.
		// Under the cap everything fits and nothing more is read.
		const overCap = neverKeyed.length > GROUPING_KEYS_PER_TICK
		const earlierSeen = overCap
			? yield* dbRun((tx) => firstSeenOf(tx, orgId, neverKeyed))
			: new Map<string, number>()
		const graceOver = (hash: string) => nowMs - (earlierSeen.get(hash) ?? nowMs) >= MAP_PENDING_GRACE_MS
		const minute = Math.floor(nowMs / 60_000)
		const rotate = (list: ReadonlyArray<string>) => {
			const turn = list.length === 0 ? 0 : minute % list.length
			return [...list.slice(turn), ...list.slice(0, turn)]
		}
		const expired = rotate(Arr.filter(neverKeyed, (hash) => earlierSeen.has(hash) && graceOver(hash)))
		const held = rotate(Arr.filter(neverKeyed, (hash) => earlierSeen.has(hash) && !graceOver(hash)))
		const expiredShare = Math.floor(GROUPING_KEYS_PER_TICK / 2)
		// Stale keys (a rules change, a first upload) get up to a quarter, so a storm of new hashes
		// cannot stall re-keying; any share a group leaves unused goes to the groups after it.
		const staleShare = Math.floor(GROUPING_KEYS_PER_TICK / 4)
		const stale = rotate(Arr.filter(hashes, (hash) => storedHashes.has(hash) && !current.has(hash)))
		const unkeyed = [
			...stale.slice(0, staleShare),
			...expired.slice(0, expiredShare),
			...rotate(Arr.filter(neverKeyed, (hash) => !earlierSeen.has(hash))),
			...held,
			...expired.slice(expiredShare),
			...stale.slice(staleShare),
		].slice(0, GROUPING_KEYS_PER_TICK)
		const samples = unkeyed.length === 0 ? [] : yield* reads.samples(unkeyed)
		const spans = samples.length === 0 ? [] : yield* reads.spans(samples)
		const entries = computeSampleInputs(samples, spans)
		const mapped =
			reads.sourceMapped === undefined || entries.length === 0
				? entries
				: yield* reads.sourceMapped(entries, input.grouping.rules)
		// A never-keyed hash whose frames found no map yet (or whose lookup failed) waits, up to the
		// grace window from its first sighting: keyed now on its raw frames, it would never be keyed
		// again. Past the window it keys on what it has. A hash with no row yet is a first sighting.
		// A hash with a stored key whose lookup failed or whose map is pending keeps that key this tick: re-keying it on
		// raw frames could overwrite a good mapped key.
		const neverKeyedSet = new Set(neverKeyed)
		const waits = (entry: SampleInput) =>
			neverKeyedSet.has(entry.fingerprintHash) &&
			(entry.mapPending === true || entry.lookupFailed === true)
		const pending = Arr.filter(mapped, waits)
		const pendingUnknown = Arr.filter(
			Arr.map(pending, (entry) => entry.fingerprintHash),
			(hash) => !earlierSeen.has(hash),
		)
		const pendingSeen =
			pendingUnknown.length === 0
				? earlierSeen
				: new Map([...earlierSeen, ...(yield* dbRun((tx) => firstSeenOf(tx, orgId, pendingUnknown)))])
		// The stack mapped, yet its frames gave no identity to key on (no name, no source text), so
		// the key fell back to raw frames: a stored key, maybe a good mapped one, is not replaced by it.
		const mappedUnusable = (entry: SampleInput) => {
			if (entry.input.symbolicatedStack === undefined) return false
			const rule = groupingParts(entry.input, input.grouping.rules).rule
			return rule === "frames" || rule === "type-function"
		}
		// The vetoes protect a stored key from a worse one, never a rules change: a stored mapped key
		// is kept against an unmapped or identity-less sample; a raw key only waits for a pending or
		// failed lookup when the org's rules are unchanged (the maps bit alone made it stale).
		const storedOf = new Map(Arr.map(stored, (row) => [row.fingerprintHash, row] as const))
		const rulesChanged = (row: { readonly keyVersion: number; readonly configDigest: string }) =>
			row.keyVersion !== GROUPING_KEY_VERSION ||
			Str.replace(/\+source-maps$/u, "")(row.configDigest) !== input.grouping.digest
		const keepsStored = (entry: SampleInput) => {
			const row = storedOf.get(entry.fingerprintHash)
			if (row === undefined) return false
			const unsure = entry.lookupFailed === true || entry.mapPending === true
			return row.rule === "source-mapped" || row.rule === "source-mapped-function"
				? unsure || mappedUnusable(entry)
				: unsure && !rulesChanged(row)
		}
		const ready = Arr.filter(mapped, (entry) =>
			waits(entry)
				? nowMs - (pendingSeen.get(entry.fingerprintHash) ?? nowMs) >= MAP_PENDING_GRACE_MS
				: !keepsStored(entry),
		)
		const computed = computeGroupingKeys(ready, input.grouping.rules)
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
		// Each key's members capped in Postgres, those owning an issue first: a group keeps growing
		// (a chunk-load key gains a hash per deploy), and ownerless keys must not hide its issue.
		const members = yield* dbRun((tx) =>
			Effect.forEach(Arr.chunksOf(keys, CHUNK), (chunk) =>
				tx.run(
					PG.from(ErrorGroupingKeys)
						.select(($) => ({
							groupingKey: $.groupingKey,
							hashes: PG.sql(
								PG.array(PG.text),
							)`(array_agg(${$.fingerprintHash} order by (exists (select 1 from error_issues i where i.org_id = ${$.orgId} and i.fingerprint_hash = ${$.fingerprintHash}) or exists (select 1 from error_issue_fingerprints f where f.org_id = ${$.orgId} and f.fingerprint_hash = ${$.fingerprintHash})) desc, ${$.createdAt}, ${$.fingerprintHash}))[1:${MAX_SIBLINGS + 1}]`,
						}))
						.where(($) => [
							$.orgId.eq(orgId),
							$.groupingKey.in_(...chunk),
							$.keyVersion.eq(GROUPING_KEY_VERSION),
							$.configDigest.in_(...currentDigests),
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
