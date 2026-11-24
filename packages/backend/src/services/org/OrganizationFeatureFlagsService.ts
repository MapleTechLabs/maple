import * as Clerk from "@distilled.cloud/clerk"
/**
 * An organization's rollout flags, as the server sees them.
 *
 * The same contract the web app reads (`@maple/domain/organization-feature-flags`), decoded from
 * the same Clerk public metadata, so "flagged on" means one thing on both sides. The web app uses
 * the flags to decide what to show; a server consumer uses them to decide what to run, which is
 * what keeps a merged-but-staged feature from acting for an organization that never saw it.
 *
 * Self-hosted builds have no Clerk to read and get every rollout on, as the web app does. A
 * managed build that cannot reach Clerk fails closed: every rollout off for that call.
 */
import {
	DISABLED_ORGANIZATION_FEATURE_FLAGS,
	ENABLED_ORGANIZATION_FEATURE_FLAGS,
	OrganizationFeatureFlags,
	organizationFeatureFlagsFrom,
} from "@maple/domain/organization-feature-flags"
import type { OrgId } from "@maple/domain/http"
import { EdgeCacheService } from "@maple/cache"
import { Clock, Context, type Duration, Effect, Layer, Option, Schema, String as Str } from "effect"
import { Env } from "@maple/backend/platform/Env"
import { clerkApiFor } from "@maple/auth"

/**
 * Every reuse of an organization's flags is timed from when Clerk answered, not from when a copy
 * was stored, so withdrawing a flag takes effect within {@link FLAGS_TTL_MS} however slow a cache
 * write was. Two tiers: the colo's shared cache serves an answer for its first
 * {@link FLAGS_SHARED_MAX_AGE_MS}, and an isolate's memo keeps it up to the full minute. The shared
 * tier is what makes a cold isolate cheap: isolates live well under a minute, so a memo alone sent
 * most `initialize` requests to Clerk (p50 88 ms, p95 237 ms in prod).
 */
const FLAGS_TTL_MS = 60_000
const FLAGS_SHARED_MAX_AGE_MS = 30_000
const FLAGS_EDGE_BUCKET = "org-feature-flags"
/** Storage lifetime only; {@link FLAGS_SHARED_MAX_AGE_MS} decides whether an entry is served. */
const FLAGS_EDGE_TTL_SECONDS = 30

/** One Clerk answer, with when it was given. */
const ObservedFlags = Schema.Struct({ flags: OrganizationFeatureFlags, observedAtMs: Schema.Number })
type ObservedFlags = typeof ObservedFlags.Type

/** Clerk could not answer. Kept out of the shared cache: one failed read must not turn rollouts off colo-wide. */
class FeatureFlagsUnreadableError extends Schema.TaggedError<FeatureFlagsUnreadableError>()(
	"@maple/backend/services/org/FeatureFlagsUnreadableError",
	{ message: Schema.String },
) {}

/** What `OrganizationFeatureFlagsService.layer` needs from the app root. */
export type OrganizationFeatureFlagsRequirements = Env | EdgeCacheService

export interface OrganizationFeatureFlagsServiceApi {
	/** Never fails: an unreadable organization is an organization with every rollout off. */
	readonly flags: (orgId: OrgId) => Effect.Effect<OrganizationFeatureFlags>
	/**
	 * The flags, or none when they could not be read. For a caller that only decides what to show,
	 * and so should not hide a feature because the provider was away. With `within`, a read that
	 * takes longer answers none, and so does the next minute of calls, without waiting again.
	 */
	readonly known: (
		orgId: OrgId,
		within?: Duration.Duration,
	) => Effect.Effect<Option.Option<OrganizationFeatureFlags>>
}

/**
 * A keyed read with a wait: one that outlasts `within` answers none, and for `quietMs` after so
 * does every call for that key, at once. A slow provider then costs one wait, not one per request.
 */
export const answeringWithin = <K, A>(quietMs: number) => {
	const unanswered = new Map<K, number>()
	return Effect.fnUntraced(function* <R>(
		key: K,
		within: Duration.Duration,
		read: Effect.Effect<Option.Option<A>, never, R>,
	) {
		const nowMs = yield* Clock.currentTimeMillis
		const sinceMs = unanswered.get(key)
		if (sinceMs !== undefined && nowMs - sinceMs < quietMs) return Option.none<A>()
		const answer = yield* Effect.timeoutOption(read, within)
		if (Option.isNone(answer)) {
			unanswered.set(key, nowMs)
			return Option.none<A>()
		}
		unanswered.delete(key)
		return answer.value
	})
}

export class OrganizationFeatureFlagsService extends Context.Service<
	OrganizationFeatureFlagsService,
	OrganizationFeatureFlagsServiceApi
>()("@maple/backend/services/org/OrganizationFeatureFlagsService", {
	make: Effect.gen(function* () {
		const env = yield* Env
		const edgeCache = yield* EdgeCacheService
		const clerkMode = Str.toLowerCase(env.MAPLE_AUTH_MODE) === "clerk"
		const clerk = clerkApiFor(env)

		const cache = new Map<
			OrgId,
			{ readonly flags: Option.Option<OrganizationFeatureFlags>; readonly observedAtMs: number }
		>()

		const read = Effect.fn("OrganizationFeatureFlagsService.read")(function* (orgId: OrgId) {
			if (clerk === undefined) {
				yield* Effect.annotateCurrentSpan("maple.feature_flags.source", "no_clerk_secret")
				return Option.some(DISABLED_ORGANIZATION_FEATURE_FLAGS)
			}
			return yield* clerk.run(Clerk.getOrganization({ organization_id: orgId })).pipe(
				Effect.map((organization) =>
					Option.some(organizationFeatureFlagsFrom(organization.public_metadata)),
				),
				Effect.catch((error) =>
					Effect.logWarning(
						"Could not read organization feature flags; treating every rollout as off",
					).pipe(
						Effect.annotateLogs({ orgId, error: error.message }),
						Effect.as(Option.none<OrganizationFeatureFlags>()),
					),
				),
			)
		})

		// Clerk's answer, stamped when it arrived; a failed read fails so it is never shared.
		const observe = (orgId: OrgId) =>
			Effect.gen(function* () {
				const flags = yield* read(orgId)
				if (Option.isNone(flags)) {
					return yield* new FeatureFlagsUnreadableError({ message: "Clerk did not answer" })
				}
				const observedAtMs = yield* Clock.currentTimeMillis
				return { flags: flags.value, observedAtMs } satisfies ObservedFlags
			})

		const shared = (orgId: OrgId) =>
			edgeCache.getOrCompute(
				{
					bucket: FLAGS_EDGE_BUCKET,
					key: orgId,
					ttlSeconds: FLAGS_EDGE_TTL_SECONDS,
					schema: ObservedFlags,
				},
				observe(orgId),
			)

		// The colo's copy first; only a miss, or a copy older than its serving age, reaches Clerk.
		const readShared = Effect.fnUntraced(function* (orgId: OrgId) {
			const first = yield* shared(orgId)
			const nowMs = yield* Clock.currentTimeMillis
			if (!first.hit) return first.value
			if (nowMs - first.value.observedAtMs < FLAGS_SHARED_MAX_AGE_MS) {
				yield* Effect.annotateCurrentSpan("maple.feature_flags.source", "edge_cache")
				return first.value
			}
			// Stored late, so still in storage past its serving age: replace it with a fresh answer.
			yield* edgeCache.invalidate({ bucket: FLAGS_EDGE_BUCKET, key: orgId })
			const retry = yield* shared(orgId)
			if (!retry.hit || nowMs - retry.value.observedAtMs < FLAGS_SHARED_MAX_AGE_MS) return retry.value
			// The delete did not take: answer from Clerk without the shared tier.
			return yield* observe(orgId)
		})

		const cachedOrRead = Effect.fn("OrganizationFeatureFlagsService.flags")(function* (orgId: OrgId) {
			yield* Effect.annotateCurrentSpan({ orgId })
			if (!clerkMode) return Option.some(ENABLED_ORGANIZATION_FEATURE_FLAGS)
			const nowMs = yield* Clock.currentTimeMillis
			const cached = cache.get(orgId)
			if (cached !== undefined && nowMs - cached.observedAtMs < FLAGS_TTL_MS) {
				yield* Effect.annotateCurrentSpan("maple.feature_flags.source", "cache")
				return cached.flags
			}
			const fresh = yield* readShared(orgId).pipe(
				Effect.map((observed) => ({
					flags: Option.some(observed.flags),
					observedAtMs: observed.observedAtMs,
				})),
				// Fails closed for this isolate's minute, as before the shared tier.
				Effect.catchTag("@maple/backend/services/org/FeatureFlagsUnreadableError", () =>
					Effect.succeed({ flags: Option.none<OrganizationFeatureFlags>(), observedAtMs: nowMs }),
				),
			)
			cache.set(orgId, fresh)
			return fresh.flags
		})

		const inTime = answeringWithin<OrgId, OrganizationFeatureFlags>(FLAGS_TTL_MS)
		const known: OrganizationFeatureFlagsServiceApi["known"] = (orgId, within) =>
			within === undefined ? cachedOrRead(orgId) : inTime(orgId, within, cachedOrRead(orgId))

		const flags: OrganizationFeatureFlagsServiceApi["flags"] = (orgId) =>
			Effect.map(
				cachedOrRead(orgId),
				Option.getOrElse(() => DISABLED_ORGANIZATION_FEATURE_FLAGS),
			)

		return { flags, known } satisfies OrganizationFeatureFlagsServiceApi
	}),
}) {
	static readonly layer = Layer.effect(this, this.make)

	/** A fixed answer, for tests. */
	static readonly fixed = (value: OrganizationFeatureFlags) =>
		Layer.succeed(this, {
			flags: () => Effect.succeed(value),
			known: () => Effect.succeedSome(value),
		})

	/** Every rollout on, for tests and for callers that are gated elsewhere. */
	static readonly allEnabled = this.fixed(ENABLED_ORGANIZATION_FEATURE_FLAGS)

	/** A provider that does not answer, for tests: every rollout reads off and none is known. */
	static readonly unreadable = Layer.succeed(this, {
		flags: () => Effect.succeed(DISABLED_ORGANIZATION_FEATURE_FLAGS),
		known: () => Effect.succeedNone,
	})
}
