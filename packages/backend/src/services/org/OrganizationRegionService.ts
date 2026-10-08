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
import { Clock, Context, Effect, HashMap, Layer, Option, Redacted, Ref, Schema } from "effect"
import { Env } from "@maple/backend/platform/Env"
import { type ClerkRequestError, clerkRequest } from "@maple/backend/services/auth/clerk-request"

/**
 * A region that can no longer change: chosen, or past the choice window (`REGION_CHOICE_WINDOW_MS`,
 * enforced where the choice is written). A minute of reuse is safe.
 */
const REGIONS_TTL_MS = 60_000
/**
 * An organization still inside its choice window may pick EU in onboarding, after which this
 * instance must stop serving it. Short enough to close that window.
 */
const OPEN_REGION_TTL_MS = 5_000

/**
 * The Workers cache tier, shared by every isolate in a data center. A fresh isolate reads it in a
 * few ms instead of paying a ~180 ms Clerk call. Same TTLs as the isolate tier.
 */
const REGIONS_CACHE_BUCKET = "org-regions"

/** One Clerk answer. Every tier measures its age from `readAtMs`, so reuse never adds up across tiers. */
const RegionRead = Schema.Struct({
	metadata: Schema.Unknown,
	createdAtMs: Schema.Number,
	readAtMs: Schema.Number,
})
type RegionRead = typeof RegionRead.Type

/** Keeps a read that refuses this instance out of the shared tier. Recovered where it is raised. */
class RegionReadNotShared extends Schema.TaggedError<RegionReadNotShared>()(
	"@maple/backend/services/org/RegionReadNotShared",
	{ message: Schema.String, read: RegionRead },
) {}

const regionTtlMs = (entry: RegionRead, nowMs: number): number =>
	organizationRegionOpen(entry.metadata, entry.createdAtMs, nowMs) ? OPEN_REGION_TTL_MS : REGIONS_TTL_MS

/** Where a region answer came from, for the `cache.layer` span attribute. */
interface RegionAnswer {
	readonly entry: RegionRead
	readonly layer: "isolate" | "edge" | "origin"
}

const isFresh = (entry: RegionRead, nowMs: number): boolean =>
	nowMs - entry.readAtMs < regionTtlMs(entry, nowMs)

/** The organization fields a region decision needs, as the directory returns them. */
export interface DirectoryOrganization {
	readonly publicMetadata: unknown
	readonly createdAt: number
}

export type ReadDirectoryOrganization = (
	orgId: OrgId,
) => Effect.Effect<DirectoryOrganization, ClerkRequestError>

export interface OrganizationRegionServiceApi {
	/** The instance's own region. */
	readonly region: MapleRegion
	/** Fails when the organization lives in another region. Never fails on a Clerk outage. */
	readonly ensureServedHere: (orgId: OrgId) => Effect.Effect<void, OrganizationWrongRegionError>
	/**
	 * Whether this instance is the organization's home. `None` when Clerk could not say: for
	 * background work that every region receives and exactly one must do, which has to wait
	 * rather than be served on a guess.
	 */
	readonly servedHere: (orgId: OrgId) => Effect.Effect<Option.Option<boolean>>
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
	const remembered = yield* Ref.make(HashMap.empty<OrgId, RegionRead>())

	const readDirectory = Effect.fnUntraced(function* (read: ReadDirectoryOrganization, orgId: OrgId) {
		const readAtMs = yield* Clock.currentTimeMillis
		const organization = yield* read(orgId)
		return { metadata: organization.publicMetadata, createdAtMs: organization.createdAt, readAtMs }
	})

	// Only a yes is shared. An organization whose region was just chosen in onboarding arrives
	// here straight away, and a cached no would refuse it.
	const readShared = (read: ReadDirectoryOrganization, orgId: OrgId, nowMs: number) =>
		edgeCache
			.getOrCompute(
				{
					bucket: REGIONS_CACHE_BUCKET,
					key: orgId,
					schema: RegionRead,
					ttlSeconds: (entry) => Math.ceil(regionTtlMs(entry, entry.readAtMs) / 1000),
				},
				readDirectory(read, orgId).pipe(
					Effect.filterOrFail(
						(entry) => organizationServedIn(entry.metadata, region),
						(entry) =>
							new RegionReadNotShared({
								message: "Organization is not served here",
								read: entry,
							}),
					),
				),
			)
			.pipe(
				Effect.flatMap(({ value, hit }): Effect.Effect<RegionAnswer, ClerkRequestError> => {
					if (!hit) return Effect.succeed({ entry: value, layer: "origin" })
					if (isFresh(value, nowMs)) return Effect.succeed({ entry: value, layer: "edge" })
					// Written once Clerk answered, so the entry can outlive its TTL by that call.
					return Effect.map(readDirectory(read, orgId), (entry) => ({ entry, layer: "origin" }))
				}),
				Effect.catchTag(
					"@maple/backend/services/org/RegionReadNotShared",
					(notShared): Effect.Effect<RegionAnswer> =>
						Effect.succeed({ entry: notShared.read, layer: "origin" }),
				),
			)

	const read = Effect.fn("OrganizationRegionService.read")(function* (orgId: OrgId) {
		if (Option.isNone(readOrganization)) return Option.none<unknown>()
		const nowMs = yield* Clock.currentTimeMillis
		const local = Option.filter(HashMap.get(yield* Ref.get(remembered), orgId), (entry) =>
			isFresh(entry, nowMs),
		)
		if (Option.isSome(local)) {
			yield* Effect.annotateCurrentSpan({ "cache.hit": true, "cache.layer": "isolate" })
			return Option.some(local.value.metadata)
		}
		return yield* readShared(readOrganization.value, orgId, nowMs).pipe(
			Effect.tap(({ entry, layer }) =>
				Effect.andThen(
					Effect.annotateCurrentSpan({ "cache.hit": layer === "edge", "cache.layer": layer }),
					organizationServedIn(entry.metadata, region)
						? Ref.update(remembered, HashMap.set(orgId, entry))
						: Effect.void,
				),
			),
			Effect.map(({ entry }) => Option.some(entry.metadata)),
			Effect.catch((error) =>
				Effect.logWarning("Could not read organization regions; serving the request").pipe(
					Effect.annotateLogs({ orgId, error: error.message }),
					Effect.as(Option.none<unknown>()),
				),
			),
		)
	})

	const ensureServedHere: OrganizationRegionServiceApi["ensureServedHere"] = Effect.fn(
		"OrganizationRegionService.ensureServedHere",
	)(function* (orgId) {
		const metadata = yield* read(orgId)
		if (Option.isNone(metadata)) return
		if (organizationRegionsFrom(metadata.value).includes(region)) return
		const orgRegion = organizationHomeRegion(metadata.value)
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
		if (Option.isNone(readOrganization)) return Option.some(true)
		return Option.map(yield* read(orgId), (metadata) => organizationHomeRegion(metadata) === region)
	})

	const forget: OrganizationRegionServiceApi["forget"] = Effect.fn("OrganizationRegionService.forget")(
		function* (orgId) {
			yield* Ref.update(remembered, HashMap.remove(orgId))
			yield* edgeCache.invalidate({ bucket: REGIONS_CACHE_BUCKET, key: orgId })
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
		servedHere: () => Effect.succeed(Option.some(true)),
		forget: () => Effect.void,
	})
}
