import { BillingNotConfiguredError, BillingUpstreamError } from "@maple/domain/http"
import type { OrgId } from "@maple/domain/primitives"
import {
	emptyOnboardingChecklistInputs,
	evaluateOnboardingChecklist,
	type OnboardingChecklistEvaluation,
	type OnboardingChecklistInputs,
	OnboardingChecklistUnavailableError,
	onboardingRewardWindowOpen,
	OnboardingRewardNotClaimableError,
} from "@maple/domain/onboarding-checklist"
import { EdgeCacheService } from "@maple/cache"
import { Clock, Context, Effect, Layer, Option, Redacted } from "effect"
import type { TenantContext } from "@maple/backend/services/auth/AuthService"
import { Env } from "@maple/backend/platform/Env"
import { AlertDestinationsService } from "@maple/backend/services/alerts/AlertDestinationsService"
import { AlertRulesService } from "@maple/backend/services/alerts/AlertRulesService"
import { AutumnClient } from "@maple/backend/services/billing/autumn-http"
import { CUSTOMER_CACHE_BUCKET, classifyAutumn } from "@maple/backend/services/billing/autumn-client"
import { VcsRepository } from "@maple/backend/services/integrations/vcs/VcsRepository"
import { ApiKeysService } from "@maple/backend/services/org/ApiKeysService"
import { OnboardingService } from "@maple/backend/services/org/OnboardingService"
import { OrgMembersService } from "@maple/backend/services/org/OrgMembersService"
import { OrganizationService } from "@maple/backend/services/org/OrganizationService"
import { SignalPresenceService } from "@maple/backend/services/org/SignalPresenceService"

export type OnboardingChecklistReport = OnboardingChecklistEvaluation

/**
 * How long a claim may sit unresolved before another attempt may take it over. Long
 * enough for a slow Autumn round trip; short enough that a crashed attempt does not
 * hold the reward hostage.
 */
export const CLAIM_LEASE_MS = 10 * 60 * 1000

export interface OnboardingClaimResult {
	readonly report: OnboardingChecklistReport
	/** True only for the call that performed the redemption; a repeat returns the report with `false`. */
	readonly newlyClaimed: boolean
}

/** Same shape `ensureOk` gives a refused request, so the route's public error set is unchanged. */
const collapseToUpstream = (error: {
	readonly message: string
	readonly code: string
	readonly upstreamStatus: number
}) =>
	Effect.fail(
		new BillingUpstreamError({
			message: `Autumn rejected our request (HTTP ${error.upstreamStatus}, ${error.code}): ${error.message}`,
		}),
	)

export interface OnboardingChecklistServiceApi {
	/** Evaluate every step against the org's current state. Never marks a step done on a failed read. */
	readonly read: (
		tenant: TenantContext,
	) => Effect.Effect<OnboardingChecklistReport, OnboardingChecklistUnavailableError>
	/**
	 * Apply the credit. Re-verifies the steps and the window, reserves the claim
	 * in Postgres, then redeems the reward in Autumn. Idempotent: a claimed org
	 * gets its report back without a second redeem.
	 */
	readonly claim: (
		tenant: TenantContext,
	) => Effect.Effect<
		OnboardingClaimResult,
		| OnboardingChecklistUnavailableError
		| OnboardingRewardNotClaimableError
		| BillingNotConfiguredError
		| BillingUpstreamError
	>
}

const make = Effect.gen(function* () {
	const env = yield* Env
	const edgeCache = yield* EdgeCacheService
	const organizations = yield* OrganizationService
	const onboarding = yield* OnboardingService
	const signals = yield* SignalPresenceService
	const vcs = yield* VcsRepository
	const alertRules = yield* AlertRulesService
	const alertDestinations = yield* AlertDestinationsService
	const members = yield* OrgMembersService
	const apiKeys = yield* ApiKeysService
	const autumn = yield* AutumnClient

	const unavailable = <A, E>(operation: string, effect: Effect.Effect<A, E>) =>
		effect.pipe(
			Effect.tapCause((cause) =>
				Effect.logError("Onboarding checklist persistence failed").pipe(
					Effect.annotateLogs({ operation, cause }),
				),
			),
			Effect.mapError(
				(error) =>
					new OnboardingChecklistUnavailableError({
						message: "Onboarding checklist state could not be read",
						operation,
						cause: error,
					}),
			),
		)

	/**
	 * A step's read failing must leave the step undone, never done: the reward has a
	 * price, and "we could not check" is not "you did it".
	 */
	const degrade = <A, E>(orgId: OrgId, step: string, fallback: A, effect: Effect.Effect<A, E>) =>
		effect.pipe(
			Effect.catchCause((cause) =>
				Effect.logWarning("Onboarding checklist step read failed; treating as not done").pipe(
					Effect.annotateLogs({ orgId, step, cause }),
					Effect.as(fallback),
				),
			),
		)

	/**
	 * The org's creation time is read from the identity provider once, when no onboarding
	 * row exists yet, and persisted on the row; every later read is one Postgres select. A
	 * lookup that fails creates no row, so the next read asks again rather than stamping
	 * "created now" onto an org of unknown age — which would open the window for it.
	 */
	const loadRow = Effect.fn("OnboardingChecklistService.loadRow")(function* (tenant: TenantContext) {
		const existing = yield* unavailable("findState", onboarding.findState(tenant.orgId))
		if (Option.isSome(existing)) {
			return {
				orgCreatedAtMs: existing.value.createdAt.getTime(),
				rewardClaimedAtMs: existing.value.rewardClaimedAt?.getTime() ?? null,
			}
		}

		const createdAt = yield* organizations.retrieve(tenant.orgId).pipe(
			Effect.map((org) => org.createdAtMs),
			Effect.catchCause((cause) =>
				Effect.logWarning("Onboarding checklist could not read the org's creation time").pipe(
					Effect.annotateLogs({ orgId: tenant.orgId, cause }),
					Effect.as<number | null>(null),
				),
			),
		)
		if (createdAt === null) return { orgCreatedAtMs: null, rewardClaimedAtMs: null }

		const row = yield* unavailable(
			"ensureRow",
			onboarding.ensureRow(tenant.orgId, tenant.userId, undefined, { createdAt }),
		)
		return {
			orgCreatedAtMs: row.createdAt.getTime(),
			rewardClaimedAtMs: row.rewardClaimedAt?.getTime() ?? null,
		}
	})

	const fetchStepInputs = Effect.fn("OnboardingChecklistService.fetchStepInputs")(function* (
		tenant: TenantContext,
	) {
		const orgId = tenant.orgId
		return yield* Effect.all(
			{
				telemetryPresent: degrade(
					orgId,
					"send_telemetry",
					false,
					signals
						.read(tenant)
						.pipe(
							Effect.map((report) =>
								report.signals.some(
									(signal) =>
										signal.status === "present" &&
										(signal.signal === "traces" ||
											signal.signal === "logs" ||
											signal.signal === "metrics"),
								),
							),
						),
				),
				githubConnected: degrade(
					orgId,
					"connect_github",
					false,
					vcs
						.listInstallationsByOrg(orgId)
						.pipe(
							Effect.map((installations) =>
								installations.some((i) => i.provider === "github" && i.status === "active"),
							),
						),
				),
				alertRuleCount: degrade(
					orgId,
					"create_alert_rule",
					0,
					alertRules.listRules(orgId).pipe(Effect.map((response) => response.rules.length)),
				),
				alertDestinationCount: degrade(
					orgId,
					"create_alert_rule",
					0,
					alertDestinations
						.listDestinations(orgId)
						.pipe(Effect.map((response) => response.destinations.length)),
				),
				memberCount: degrade(
					orgId,
					"invite_teammate",
					0,
					members.listMembers(orgId).pipe(Effect.map((list) => list.length)),
				),
				mcpKeyUsed: degrade(
					orgId,
					"connect_mcp_agent",
					false,
					apiKeys.hasUsedKeyOfKind(orgId, "mcp"),
				),
			},
			{ concurrency: "unbounded" },
		)
	})

	const read = Effect.fn("OnboardingChecklistService.read")(function* (tenant: TenantContext) {
		const row = yield* loadRow(tenant)
		const now = yield* Clock.currentTimeMillis

		// A claimed or expired org never pays for the fan-out: the answer is decided by the row.
		const inputs: OnboardingChecklistInputs =
			row.rewardClaimedAtMs !== null || !onboardingRewardWindowOpen(row.orgCreatedAtMs, now)
				? emptyOnboardingChecklistInputs(row)
				: { ...row, ...(yield* fetchStepInputs(tenant)) }

		const report = evaluateOnboardingChecklist(inputs, now)
		yield* Effect.annotateCurrentSpan({
			orgId: tenant.orgId,
			"onboarding.status": report.status,
			"onboarding.completed": report.completedCount,
		})
		return report
	})

	const claim = Effect.fn("OnboardingChecklistService.claim")(function* (tenant: TenantContext) {
		const orgId = tenant.orgId
		const report = yield* read(tenant)
		if (report.status === "claimed") return { report, newlyClaimed: false }
		if (report.status !== "claimable") {
			return yield* new OnboardingRewardNotClaimableError({
				message:
					report.status === "expired"
						? "The onboarding reward window has closed."
						: "Finish every step of the checklist before claiming the reward.",
				reason: report.status === "expired" ? "expired" : "incomplete",
			})
		}

		// Checked before the reservation so a misconfigured deployment leaves the row untouched.
		const code = yield* Option.match(env.AUTUMN_ONBOARDING_REWARD_CODE, {
			onNone: () =>
				Effect.fail(
					new BillingNotConfiguredError({ message: "AUTUMN_ONBOARDING_REWARD_CODE is not set" }),
				),
			onSome: (value) => Effect.succeed(Redacted.value(value)),
		})

		// Take the lease first: a lost race means another admin's click is mid-redeem, and
		// that caller gets a retryable refusal. The lease, not the claim stamp, is what is
		// held here — `rewardClaimedAt` goes down only once Autumn has confirmed the credit,
		// so a crash or an unanswered call never reads as "claimed". A lease older than
		// `CLAIM_LEASE_MS` is a dead attempt and may be taken over.
		const reserved = yield* unavailable(
			"reserveRewardClaim",
			onboarding.reserveRewardClaim(orgId, CLAIM_LEASE_MS),
		)
		if (!reserved) {
			return yield* new OnboardingRewardNotClaimableError({
				message: "Another admin is claiming the reward right now. Try again in a moment.",
				reason: "in_progress",
			})
		}

		const release = onboarding
			.releaseRewardClaim(orgId)
			.pipe(
				Effect.catchCause((cause) =>
					Effect.logError("Onboarding reward lease could not be released").pipe(
						Effect.annotateLogs({ orgId, cause }),
					),
				),
			)
		const releaseAndCollapse = (error: {
			readonly message: string
			readonly code: string
			readonly upstreamStatus: number
		}) => release.pipe(Effect.andThen(collapseToUpstream(error)))

		// Nothing has been applied until the redeem call itself, so any failure before it
		// gives the lease back. On the redeem, only a definite 4xx refusal does: a 5xx or a
		// lost response may have applied the credit, so the lease stays until it expires and
		// the failure is logged for reconciliation. `classifyAutumn` keeps the 4xx/5xx split
		// that `ensureOk` collapses.
		yield* autumn.getOrCreateCustomer(orgId, { expand: [] }).pipe(
			Effect.flatMap(classifyAutumn),
			Effect.catchTags({
				"@maple/http/errors/BillingPaymentRequiredError": releaseAndCollapse,
				"@maple/http/errors/BillingConflictError": releaseAndCollapse,
				"@maple/http/errors/BillingRateLimitedError": releaseAndCollapse,
				"@maple/http/errors/BillingRequestError": releaseAndCollapse,
				"@maple/http/errors/BillingUpstreamError": (error) =>
					release.pipe(Effect.andThen(Effect.fail(error))),
			}),
		)
		yield* autumn.redeemReward(orgId, { code }).pipe(
			Effect.flatMap(classifyAutumn),
			Effect.catchTags({
				"@maple/http/errors/BillingPaymentRequiredError": releaseAndCollapse,
				"@maple/http/errors/BillingConflictError": releaseAndCollapse,
				"@maple/http/errors/BillingRateLimitedError": releaseAndCollapse,
				"@maple/http/errors/BillingRequestError": releaseAndCollapse,
				"@maple/http/errors/BillingUpstreamError": (error) =>
					Effect.logError(
						"Onboarding reward redeem unanswered after reservation; needs reconciliation",
					).pipe(Effect.annotateLogs({ orgId, error }), Effect.andThen(Effect.fail(error))),
			}),
		)
		yield* unavailable("finalizeRewardClaim", onboarding.finalizeRewardClaim(orgId))
		yield* edgeCache.invalidate({ bucket: CUSTOMER_CACHE_BUCKET, key: orgId })
		yield* Effect.annotateCurrentSpan({ orgId, "onboarding.rewardClaimed": true })

		return { report: yield* read(tenant), newlyClaimed: true }
	})

	return { read, claim } satisfies OnboardingChecklistServiceApi
})

export class OnboardingChecklistService extends Context.Service<
	OnboardingChecklistService,
	OnboardingChecklistServiceApi
>()("@maple/api/services/OnboardingChecklistService", { make }) {
	static readonly layer = Layer.effect(this, this.make).pipe(
		Layer.provide(
			Layer.mergeAll(
				OrganizationService.layer,
				OnboardingService.layer,
				SignalPresenceService.layer,
				VcsRepository.layer,
				AlertRulesService.layer,
				AlertDestinationsService.layer,
				OrgMembersService.layer,
				ApiKeysService.layer,
				AutumnClient.layer,
			),
		),
	)
}
