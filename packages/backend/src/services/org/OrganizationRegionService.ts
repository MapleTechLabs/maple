/**
 * Which regional instance serves an organization.
 *
 * An organization lives in the regions its Clerk public metadata names (`@maple/domain/organization-regions`),
 * and every other instance refuses its sessions. Without this, a member who opened the wrong
 * region's app would silently create the organization's rows (onboarding state, ingest keys) there.
 *
 * Ingest keys and API keys are minted per instance, so this steers people to the right app; it is
 * not what keeps data in a region. That is why a Clerk read that fails lets the request through.
 */
import { createClerkClient } from "@clerk/backend"
import { EdgeCacheService } from "@maple/cache"
import { OrganizationWrongRegionError, type OrgId } from "@maple/domain/http"
import {
	type MapleRegion,
	MAPLE_REGION_LABELS,
	organizationHomeRegion,
	organizationRegionOpen,
	organizationRegionsFrom,
	organizationServedIn,
} from "@maple/domain/organization-regions"
import { Clock, Context, Effect, Fiber, HashMap, Layer, Option, Redacted, Ref, Schema } from "effect"
import { Env } from "@maple/backend/platform/Env"
import { type ClerkRequestError, clerkRequest } from "@maple/backend/services/auth/clerk-request"

/**
 * A region that can no longer change: chosen, or past the choice window (`REGION_CHOICE_WINDOW_MS`,
 * enforced where the choice is written), so long reuse is safe. At a minute for both tiers, about
 * one region read in seven still went to Clerk (2026-11).
 */
const SETTLED_TTL_MS = { isolate: 10 * 60_000, edge: 60 * 60_000 } as const
/**
 * An organization still inside its choice window may pick EU in onboarding, after which this
 * instance must stop serving it. Short enough to close that window.
 */
const OPEN_REGION_TTL_MS = 5_000

/**
 * The Workers cache tier, shared by every isolate in a data center, so a fresh isolate can skip
 * the Clerk call. Holds only answers that let this instance serve.
 */
const REGIONS_CACHE_BUCKET = "org-regions"
/**
 * How long the shared read runs alone before Clerk is asked too. Warm reads answer in ~13 ms. A
 * fresh isolate's first read took 90 to 340 ms (p10 to p90) on a preview, so there both race.
 */
const CLERK_HEDGE_AFTER_MS = 40
/** Frees a hung shared read. Clerk is already answering by then. */
const SHARED_READ_DEADLINE_MS = 1_000
/**
 * Parallel requests from one phone miss together in an isolate, so one reads and the rest poll
 * inert state for its answer: Workers tie I/O to the request that started it.
 */
const FOLLOWER_POLL_MS = 10
/** Followers wait as long as their leader runs, up to this; then they read for themselves. */
const FOLLOWER_WAIT_MS = 5_000

/** One Clerk answer. Every tier measures its age from `readAtMs`, so reuse never adds up across tiers. */
const RegionRead = Schema.Struct({
	metadata: Schema.Unknown,
	createdAtMs: Schema.Number,
	readAtMs: Schema.Number,
})
type RegionRead = typeof RegionRead.Type

const decodeRegionRead = Schema.decodeUnknownOption(RegionRead)

/** The shared tier had no usable answer, so the race against Clerk goes to Clerk. */
class RegionNotShared extends Schema.TaggedError<RegionNotShared>()(
	"@maple/backend/services/org/RegionNotShared",
	{ message: Schema.String },
) {}

type Tier = keyof typeof SETTLED_TTL_MS

const regionTtlMs = (entry: RegionRead, nowMs: number, tier: Tier): number =>
	organizationRegionOpen(entry.metadata, entry.createdAtMs, nowMs)
		? OPEN_REGION_TTL_MS
		: SETTLED_TTL_MS[tier]

/** Where a region answer came from, for the `cache.layer` span attribute. */
interface RegionAnswer {
	readonly entry: RegionRead
	readonly layer: "isolate" | "edge" | "origin"
}

const answer = (entry: RegionRead, layer: RegionAnswer["layer"]): RegionAnswer => ({ entry, layer })

// The TTL is picked as of the read: an entry read while the choice window was open must not
// become a settled answer when the window closes.
const isFresh = (entry: RegionRead, nowMs: number, tier: Tier): boolean =>
	nowMs - entry.readAtMs < regionTtlMs(entry, entry.readAtMs, tier)

/** An answer this isolate holds, and since when: an edge hit counts from when it arrived here. */
interface Held {
	readonly entry: RegionRead
	readonly heldAtMs: number
}

/** Within the isolate tier from arrival, and never past the answer's own edge age. */
const isHeldFresh = (held: Held, nowMs: number): boolean =>
	isFresh(held.entry, nowMs, "edge") &&
	nowMs - held.heldAtMs < regionTtlMs(held.entry, held.entry.readAtMs, "isolate")

/** The organization fields a region decision needs, as the directory returns them. */
export interface DirectoryOrganization {
	readonly publicMetadata: unknown
	readonly createdAt: number
}

/** None when the directory no longer has the organization: it was deleted. */
export type ReadDirectoryOrganization = (
	orgId: OrgId,
) => Effect.Effect<Option.Option<DirectoryOrganization>, ClerkRequestError>

/**
 * Whether this instance is an organization's home. `unknown` when Clerk could not say; `deleted`
 * when Clerk no longer has the organization, an answer every region gets alike.
 */
export type HomeAnswer = "here" | "elsewhere" | "deleted" | "unknown"

/** What the directory said: the organization's metadata, that it is gone, or nothing. */
type DirectoryAnswer =
	| { readonly _tag: "Found"; readonly metadata: unknown }
	| { readonly _tag: "Deleted" }
	| { readonly _tag: "Unreachable" }

const found = (metadata: unknown): DirectoryAnswer => ({ _tag: "Found", metadata })

/** The read running for each organization, and the last one that finished. */
interface Coalescing {
	readonly running: HashMap.HashMap<OrgId, { readonly id: number; readonly startedAtMs: number }>
	readonly settled: HashMap.HashMap<OrgId, { readonly id: number; readonly answer: DirectoryAnswer }>
}

export interface OrganizationRegionServiceApi {
	/** The instance's own region. */
	readonly region: MapleRegion
	/** Fails when the organization lives in another region. Never fails on a Clerk outage. */
	readonly ensureServedHere: (orgId: OrgId) => Effect.Effect<void, OrganizationWrongRegionError>
	/**
	 * For background work that every region receives and exactly one must do, which has to wait
	 * on `unknown` rather than be served on a guess.
	 */
	readonly servedHere: (orgId: OrgId) => Effect.Effect<HomeAnswer>
	/** Drops what this instance remembers about the organization, after its region was written. */
	readonly forget: (orgId: OrgId) => Effect.Effect<void>
}

/**
 * Builds the service over a directory read, or none for a single instance without Clerk.
 * Exported so tests can stand in for Clerk.
 */
export const makeOrganizationRegionService = Effect.fnUntraced(function* (
	region: MapleRegion,
	readOrganization: Option.Option<ReadDirectoryOrganization>,
) {
	const edgeCache = yield* EdgeCacheService
	const remembered = yield* Ref.make(HashMap.empty<OrgId, Held>())
	// A counter, not the clock, names a read: Workers' clock stands still between I/O.
	const readIds = yield* Ref.make(0)
	const coalescing = yield* Ref.make<Coalescing>({ running: HashMap.empty(), settled: HashMap.empty() })
	// Bumped by `forget`: a read that started before it must not cache its answer after it.
	const generations = yield* Ref.make(HashMap.empty<OrgId, number>())
	const generationOf = (orgId: OrgId) =>
		Effect.map(Ref.get(generations), (map) => Option.getOrElse(HashMap.get(map, orgId), () => 0))
	const ifStillCurrent = (orgId: OrgId, generation: number, write: Effect.Effect<void>) =>
		Effect.flatMap(generationOf(orgId), (now) => (now === generation ? write : Effect.void))

	const readDirectory = Effect.fnUntraced(function* (read: ReadDirectoryOrganization, orgId: OrgId) {
		const readAtMs = yield* Clock.currentTimeMillis
		const organization = yield* read(orgId)
		return Option.map(organization, (found): RegionRead => ({
			metadata: found.publicMetadata,
			createdAtMs: found.createdAt,
			readAtMs,
		}))
	})

	const readEdge = (orgId: OrgId, nowMs: number) =>
		edgeCache
			.rawGetDetailed<unknown>(REGIONS_CACHE_BUCKET, orgId, { readTimeoutMs: SHARED_READ_DEADLINE_MS })
			.pipe(
				Effect.map(({ value }) =>
					Option.filter(Option.flatMap(value, decodeRegionRead), (entry) =>
						isFresh(entry, nowMs, "edge"),
					),
				),
				// A failed read is a miss. Clerk still answers.
				Effect.orElseSucceed(() => Option.none<RegionRead>()),
			)

	// Only a yes is shared. An organization whose region was just chosen in onboarding arrives
	// here straight away, and a cached no would refuse it.
	const readOrigin = (read: ReadDirectoryOrganization, orgId: OrgId, generation: number) =>
		readDirectory(read, orgId).pipe(
			Effect.tap((entry) =>
				Option.isSome(entry) && organizationServedIn(entry.value.metadata, region)
					? ifStillCurrent(
							orgId,
							generation,
							edgeCache
								.rawPut(
									REGIONS_CACHE_BUCKET,
									orgId,
									entry.value,
									Math.ceil(regionTtlMs(entry.value, entry.value.readAtMs, "edge") / 1000),
								)
								.pipe(
									Effect.catch((error) =>
										Effect.logWarning("Could not share the organization's regions").pipe(
											Effect.annotateLogs({ orgId, error: error.message }),
										),
									),
								),
						)
					: Effect.void,
			),
			Effect.map(Option.map((entry) => answer(entry, "origin"))),
		)

	const readShared = Effect.fnUntraced(function* (
		read: ReadDirectoryOrganization,
		orgId: OrgId,
		nowMs: number,
		generation: number,
	) {
		const shared = yield* Effect.forkChild(readEdge(orgId, nowMs))
		const early = yield* Fiber.join(shared).pipe(Effect.timeoutOption(CLERK_HEDGE_AFTER_MS))
		if (Option.isSome(early)) {
			return Option.isSome(early.value)
				? Option.some(answer(early.value.value, "edge"))
				: yield* readOrigin(read, orgId, generation)
		}
		// Usually a fresh isolate's first read. Ask Clerk as well and take whichever answers first.
		yield* Effect.annotateCurrentSpan("cache.hedged", true)
		const lateHit = Fiber.join(shared).pipe(
			Effect.flatMap(
				Option.match({
					onNone: () => Effect.fail(new RegionNotShared({ message: "No shared region answer" })),
					onSome: (entry) => Effect.succeedSome(answer(entry, "edge")),
				}),
			),
		)
		return yield* Effect.race(lateHit, readOrigin(read, orgId, generation))
	})

	const readTiers = (read: ReadDirectoryOrganization, orgId: OrgId, nowMs: number) =>
		Effect.flatMap(generationOf(orgId), (generation) => readTiersAt(read, orgId, nowMs, generation))

	const readTiersAt = (read: ReadDirectoryOrganization, orgId: OrgId, nowMs: number, generation: number) =>
		readShared(read, orgId, nowMs, generation).pipe(
			Effect.flatMap(
				Option.match({
					onNone: () =>
						Effect.as(Effect.annotateCurrentSpan("maple.org_deleted", true), {
							_tag: "Deleted" as const,
						}),
					onSome: ({ entry, layer }) =>
						Effect.andThen(
							Effect.annotateCurrentSpan({
								"cache.hit": layer === "edge",
								"cache.layer": layer,
							}),
							organizationServedIn(entry.metadata, region)
								? ifStillCurrent(
										orgId,
										generation,
										Ref.update(
											remembered,
											HashMap.set(orgId, { entry, heldAtMs: nowMs }),
										),
									)
								: Effect.void,
						).pipe(Effect.as(found(entry.metadata))),
				}),
			),
			Effect.catch((error) =>
				Effect.logWarning("Could not read organization regions; serving the request").pipe(
					Effect.annotateLogs({ orgId, error: error.message }),
					Effect.as<DirectoryAnswer>({ _tag: "Unreachable" }),
				),
			),
		)

	/** The leader's answer once it lands; none if the leader is gone or ran past the cap. */
	const awaitLeader = (
		orgId: OrgId,
		leader: { readonly id: number; readonly startedAtMs: number },
	): Effect.Effect<Option.Option<DirectoryAnswer>> =>
		Effect.gen(function* () {
			const state = yield* Ref.get(coalescing)
			const done = Option.filter(HashMap.get(state.settled, orgId), (entry) => entry.id === leader.id)
			if (Option.isSome(done)) return Option.some(done.value.answer)
			const running = Option.exists(
				HashMap.get(state.running, orgId),
				(entry) => entry.id === leader.id,
			)
			const expired = (yield* Clock.currentTimeMillis) - leader.startedAtMs >= FOLLOWER_WAIT_MS
			if (!running || expired) return Option.none()
			yield* Effect.sleep(FOLLOWER_POLL_MS)
			return yield* awaitLeader(orgId, leader)
		})

	const lead = (read: ReadDirectoryOrganization, orgId: OrgId, id: number, nowMs: number) =>
		readTiers(read, orgId, nowMs).pipe(
			// Settles only while still the running read, so a forgotten read hands nothing on.
			Effect.tap((answer) =>
				Ref.update(coalescing, (state) =>
					Option.exists(HashMap.get(state.running, orgId), (entry) => entry.id === id)
						? {
								running: HashMap.remove(state.running, orgId),
								settled: HashMap.set(state.settled, orgId, { id, answer }),
							}
						: state,
				),
			),
			Effect.ensuring(
				Ref.update(coalescing, (state) =>
					Option.exists(HashMap.get(state.running, orgId), (entry) => entry.id === id)
						? { ...state, running: HashMap.remove(state.running, orgId) }
						: state,
				),
			),
		)

	const read = Effect.fn("OrganizationRegionService.read")(function* (
		orgId: OrgId,
	): Effect.fn.Return<DirectoryAnswer> {
		if (Option.isNone(readOrganization)) return { _tag: "Unreachable" }
		const nowMs = yield* Clock.currentTimeMillis
		const rememberedMap = yield* Ref.get(remembered)
		const local = Option.filter(HashMap.get(rememberedMap, orgId), (held) => isHeldFresh(held, nowMs))
		if (Option.isSome(local)) {
			yield* Effect.annotateCurrentSpan({ "cache.hit": true, "cache.layer": "isolate" })
			return found(local.value.entry.metadata)
		}
		const id = yield* Ref.updateAndGet(readIds, (n) => n + 1)
		// Claim the read, or learn which read is already running. No yield between check and set.
		const leader = yield* Ref.modify(coalescing, (state) => {
			const current = Option.filter(
				HashMap.get(state.running, orgId),
				(entry) => nowMs - entry.startedAtMs < FOLLOWER_WAIT_MS,
			)
			return Option.isSome(current)
				? [current, state]
				: [
						Option.none<{ readonly id: number; readonly startedAtMs: number }>(),
						{ ...state, running: HashMap.set(state.running, orgId, { id, startedAtMs: nowMs }) },
					]
		})
		if (Option.isNone(leader)) return yield* lead(readOrganization.value, orgId, id, nowMs)
		const coalesced = yield* awaitLeader(orgId, leader.value)
		if (Option.isSome(coalesced)) {
			yield* Effect.annotateCurrentSpan({
				"cache.hit": true,
				"cache.layer": "isolate",
				"cache.coalesced": true,
			})
			return coalesced.value
		}
		return yield* readTiers(readOrganization.value, orgId, nowMs)
	})

	const ensureServedHere: OrganizationRegionServiceApi["ensureServedHere"] = Effect.fn(
		"OrganizationRegionService.ensureServedHere",
	)(function* (orgId) {
		const directory = yield* read(orgId)
		if (directory._tag !== "Found") return
		if (organizationRegionsFrom(directory.metadata).includes(region)) return
		const orgRegion = organizationHomeRegion(directory.metadata)
		yield* Effect.annotateCurrentSpan({ "maple.org_region": orgRegion, "maple.region": region })
		return yield* new OrganizationWrongRegionError({
			message: `This organization lives in the ${MAPLE_REGION_LABELS[orgRegion].short} region.`,
			orgId,
			orgRegion,
			region,
		})
	})

	const servedHere: OrganizationRegionServiceApi["servedHere"] = Effect.fn(
		"OrganizationRegionService.servedHere",
	)(function* (orgId) {
		// No directory means one instance, which serves everything.
		if (Option.isNone(readOrganization)) return "here"
		const directory = yield* read(orgId)
		switch (directory._tag) {
			case "Found":
				return organizationHomeRegion(directory.metadata) === region ? "here" : "elsewhere"
			case "Deleted":
				return "deleted"
			case "Unreachable":
				return "unknown"
		}
	})

	const forget: OrganizationRegionServiceApi["forget"] = Effect.fn("OrganizationRegionService.forget")(
		function* (orgId) {
			yield* Ref.update(generations, (map) =>
				HashMap.set(map, orgId, Option.getOrElse(HashMap.get(map, orgId), () => 0) + 1),
			)
			yield* Ref.update(remembered, HashMap.remove(orgId))
			// A read started before the write must not hand its answer to anyone after it.
			yield* Ref.update(coalescing, (state) => ({
				running: HashMap.remove(state.running, orgId),
				settled: HashMap.remove(state.settled, orgId),
			}))
			yield* edgeCache.rawDelete(REGIONS_CACHE_BUCKET, orgId).pipe(
				Effect.catch((error) =>
					Effect.logWarning(
						"Could not drop the shared organization regions; they expire on their TTL",
					).pipe(Effect.annotateLogs({ orgId, error: error.message })),
				),
				// A stalled delete must not hold up the write that called this; the TTL still bounds it.
				Effect.timeoutOrElse({
					duration: SHARED_READ_DEADLINE_MS,
					orElse: () =>
						Effect.logWarning("Dropping the shared organization regions timed out").pipe(
							Effect.annotateLogs({ orgId }),
						),
				}),
			)
		},
	)

	return { region, ensureServedHere, servedHere, forget } satisfies OrganizationRegionServiceApi
})

export class OrganizationRegionService extends Context.Service<
	OrganizationRegionService,
	OrganizationRegionServiceApi
>()("@maple/backend/services/org/OrganizationRegionService", {
	make: Effect.gen(function* () {
		const env = yield* Env
		const clerk =
			env.MAPLE_AUTH_MODE.toLowerCase() === "clerk"
				? Option.map(env.CLERK_SECRET_KEY, (secretKey) =>
						createClerkClient({ secretKey: Redacted.value(secretKey) }),
					)
				: Option.none()
		return yield* makeOrganizationRegionService(
			env.MAPLE_REGION,
			Option.map(
				clerk,
				(client): ReadDirectoryOrganization =>
					(orgId) =>
						clerkRequest("Clerk.organizations.getOrganization", { orgId }, () =>
							client.organizations.getOrganization({ organizationId: orgId }),
						).pipe(
							Effect.asSome,
							Effect.catchIf(
								(error) => error.status === 404,
								() => Effect.succeedNone,
							),
						),
			),
		)
	}),
}) {
	static readonly layer = Layer.effect(this, this.make)

	/** Serves every organization, for tests and single-instance runtimes. */
	static readonly servesAll = Layer.succeed(this, {
		region: "us",
		ensureServedHere: () => Effect.void,
		servedHere: () => Effect.succeed("here"),
		forget: () => Effect.void,
	})
}
