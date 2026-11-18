import type { OrgId } from "@maple/domain/http"
import { Array as Arr, Context, Duration, Effect, Layer, Option } from "effect"
import { CloudflareOAuthService } from "@maple/backend/services/auth/CloudflareOAuthService"
import { GoogleOAuthService } from "@maple/backend/services/auth/GoogleOAuthService"
import { LinearOAuthService } from "@maple/backend/services/auth/LinearOAuthService"
import { ChatWorkspaceService } from "./ChatWorkspaceService"
import { PlanetScaleConnectionService } from "./PlanetScaleConnectionService"
import { SupabaseConnectionService } from "./SupabaseConnectionService"
import { VercelIntegrationService } from "./VercelIntegrationService"

/** How long one provider's teardown may take before the deletion goes on without it. */
const STEP_TIMEOUT = Duration.seconds(15)

/** Providers torn down at a time. */
const STEP_CONCURRENCY = 4

export type IntegrationTeardownOutcome = "ok" | "failed" | "timed_out"

export interface IntegrationTeardownResult {
	readonly provider: string
	readonly outcome: IntegrationTeardownOutcome
}

/**
 * One integration's vendor-side removal for an org, answering what it left at the vendor (`null`
 * when its side is ended). A no-op for an org that never connected it.
 */
interface TeardownStep {
	readonly provider: string
	readonly teardown: (orgId: OrgId) => Effect.Effect<string | null, { readonly message: string }>
}

export interface IntegrationOffboardingServiceApi {
	/**
	 * Ends what the org granted Maple at each vendor (tokens, drains, webhooks, chat bots) before
	 * its rows are purged. Best effort: a vendor that fails or stalls is logged and reported in the
	 * result, and never fails the caller.
	 */
	readonly teardown: (orgId: OrgId) => Effect.Effect<ReadonlyArray<IntegrationTeardownResult>>
}

/**
 * The vendor-side half of deleting an organization. Each step is the integration's own disconnect,
 * so a revoke is written once; an integration that holds a grant at a vendor adds one line to `steps`.
 */
export class IntegrationOffboardingService extends Context.Service<
	IntegrationOffboardingService,
	IntegrationOffboardingServiceApi
>()("@maple/backend/services/IntegrationOffboardingService", {
	make: Effect.gen(function* () {
		const linear = yield* LinearOAuthService
		const google = yield* GoogleOAuthService
		const cloudflare = yield* CloudflareOAuthService
		const supabase = yield* SupabaseConnectionService
		const vercel = yield* VercelIntegrationService
		const planetscale = yield* PlanetScaleConnectionService
		const chat = yield* ChatWorkspaceService

		/** A disconnect that revokes one OAuth grant and reports whether the vendor took it. */
		const grant =
			<E extends { readonly message: string }>(
				disconnect: (orgId: OrgId) => Effect.Effect<{ readonly grantRevoked: boolean }, E>,
			) =>
			(orgId: OrgId) =>
				Effect.map(disconnect(orgId), (result) =>
					result.grantRevoked ? null : "the grant was not revoked at the vendor",
				)

		const steps: ReadonlyArray<TeardownStep> = [
			// OAuth grants: each disconnect revokes the stored tokens at the vendor, then drops the row.
			{ provider: "linear", teardown: grant(linear.disconnect) },
			{ provider: "search_console", teardown: grant(google.disconnect) },
			{ provider: "cloudflare", teardown: grant(cloudflare.disconnect) },
			{
				provider: "supabase",
				// Log drains first, then the grant they were made with.
				teardown: (orgId) =>
					Effect.map(supabase.disconnect(orgId), (result) => {
						if (!result.drainsRemoved) return "log drains were not all removed"
						return result.grantRevoked ? null : "the grant was not revoked at the vendor"
					}),
			},
			{
				provider: "vercel",
				teardown: (orgId) =>
					Effect.map(vercel.disconnect(orgId), (result) =>
						result.drainsRemoved ? null : "drains were not all removed",
					),
			},
			{
				provider: "planetscale",
				// Webhooks on each database; PlanetScale has no revoke for the grant itself.
				teardown: (orgId) =>
					Effect.map(planetscale.disconnect(orgId), (result) =>
						result.webhooksRemoved ? null : "webhooks were not all removed",
					),
			},
			{
				provider: "chat",
				// Every linked chat workspace, through its connector's own revoke.
				teardown: (orgId) =>
					Effect.map(chat.uninstallAll(orgId), (result) => {
						if (result.revokeFailures > 0) return "a workspace's grant was not revoked"
						return result.unlinkFailures > 0 ? "a workspace could not be unlinked" : null
					}),
			},
		]

		const runStep = Effect.fn("IntegrationOffboardingService.step")(function* (
			orgId: OrgId,
			step: TeardownStep,
		) {
			yield* Effect.annotateCurrentSpan({ orgId, "maple.offboarding.provider": step.provider })
			const report = (outcome: IntegrationTeardownOutcome, error: string | null) => ({ outcome, error })
			const { outcome, error } = yield* step.teardown(orgId).pipe(
				Effect.timeoutOption(STEP_TIMEOUT),
				Effect.map(
					Option.match({
						onNone: () => report("timed_out", null),
						// A teardown that ran and left something behind is a failure of the step.
						onSome: (left) => (left === null ? report("ok", null) : report("failed", left)),
					}),
				),
				Effect.catch((failure) => Effect.succeed(report("failed", failure.message))),
				// A defect's text is not logged: nothing vouches for what it carries.
				Effect.catchDefect(() => Effect.succeed(report("failed", "the teardown died"))),
			)
			yield* Effect.annotateCurrentSpan({ "maple.offboarding.outcome": outcome })
			if (outcome !== "ok") {
				yield* Effect.logWarning("Integration teardown did not complete; deleting the org anyway", {
					orgId,
					provider: step.provider,
					outcome,
					...(error === null ? undefined : { error }),
				})
			}
			return { provider: step.provider, outcome } satisfies IntegrationTeardownResult
		})

		const teardown = Effect.fn("IntegrationOffboardingService.teardown")(function* (orgId: OrgId) {
			yield* Effect.annotateCurrentSpan({ orgId })
			const results = yield* Effect.forEach(steps, (step) => runStep(orgId, step), {
				concurrency: STEP_CONCURRENCY,
			})
			const incomplete = Arr.filter(results, (result) => result.outcome !== "ok")
			yield* Effect.annotateCurrentSpan({
				"maple.offboarding.incomplete_count": incomplete.length,
				"maple.offboarding.incomplete_providers": Arr.join(
					Arr.map(incomplete, (result) => result.provider),
					",",
				),
			})
			return results
		})

		return { teardown } satisfies IntegrationOffboardingServiceApi
	}),
}) {
	static readonly layer = Layer.effect(this, this.make).pipe(
		Layer.provide(
			Layer.mergeAll(
				LinearOAuthService.layer,
				GoogleOAuthService.layer,
				CloudflareOAuthService.layer,
				SupabaseConnectionService.layer,
				VercelIntegrationService.layer,
				PlanetScaleConnectionService.layer,
				ChatWorkspaceService.layer,
			),
		),
	)
}
