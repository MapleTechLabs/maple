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
import { OrganizationWrongRegionError, type OrgId } from "@maple/domain/http"
import {
	type MapleRegion,
	MAPLE_REGION_LABELS,
	organizationHomeRegion,
	organizationRegionsFrom,
} from "@maple/domain/organization-regions"
import { Clock, Context, Effect, Layer, Option, Redacted } from "effect"
import { Env } from "@maple/backend/platform/Env"
import { clerkRequest } from "@maple/backend/services/auth/clerk-request"

/** Regions are set when an organization is created and never change, so a minute is generous. */
const REGIONS_TTL_MS = 60_000

export interface OrganizationRegionServiceApi {
	/** The instance's own region. */
	readonly region: MapleRegion
	/** Fails when the organization lives in another region. Never fails on a Clerk outage. */
	readonly ensureServedHere: (orgId: OrgId) => Effect.Effect<void, OrganizationWrongRegionError>
}

export class OrganizationRegionService extends Context.Service<
	OrganizationRegionService,
	OrganizationRegionServiceApi
>()("@maple/backend/services/org/OrganizationRegionService", {
	make: Effect.gen(function* () {
		const env = yield* Env
		const region = env.MAPLE_REGION
		const clerk =
			env.MAPLE_AUTH_MODE.toLowerCase() === "clerk"
				? Option.match(env.CLERK_SECRET_KEY, {
						onNone: () => undefined,
						onSome: (secretKey) => createClerkClient({ secretKey: Redacted.value(secretKey) }),
					})
				: undefined

		const cache = new Map<OrgId, { readonly metadata: unknown; readonly atMs: number }>()

		const read = Effect.fn("OrganizationRegionService.read")(function* (orgId: OrgId) {
			if (clerk === undefined) return Option.none<unknown>()
			const nowMs = yield* Clock.currentTimeMillis
			const cached = cache.get(orgId)
			if (cached !== undefined && nowMs - cached.atMs < REGIONS_TTL_MS) {
				return Option.some(cached.metadata)
			}
			return yield* clerkRequest("Clerk.organizations.getOrganization", { orgId }, () =>
				clerk.organizations.getOrganization({ organizationId: orgId }),
			).pipe(
				Effect.map((organization) => {
					cache.set(orgId, { metadata: organization.publicMetadata, atMs: nowMs })
					return Option.some<unknown>(organization.publicMetadata)
				}),
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

		return { region, ensureServedHere } satisfies OrganizationRegionServiceApi
	}),
}) {
	static readonly layer = Layer.effect(this, this.make)

	/** Serves every organization, for tests and single-instance runtimes. */
	static readonly servesAll = Layer.succeed(this, {
		region: "us",
		ensureServedHere: () => Effect.void,
	})
}
