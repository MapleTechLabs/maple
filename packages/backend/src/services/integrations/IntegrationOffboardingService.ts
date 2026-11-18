import type { OrgId } from "@maple/domain/http"
import { Array as Arr, Context, Duration, Effect, Layer, Option, Schema } from "effect"
import { CloudflareOAuthService } from "@maple/backend/services/auth/CloudflareOAuthService"
import { GoogleOAuthService } from "@maple/backend/services/auth/GoogleOAuthService"
import { LinearOAuthService } from "@maple/backend/services/auth/LinearOAuthService"
import { ChatWorkspaceService } from "./ChatWorkspaceService"
import { PlanetScaleConnectionService } from "./PlanetScaleConnectionService"
import { SupabaseConnectionService } from "./SupabaseConnectionService"
import { VercelIntegrationService } from "./VercelIntegrationService"
import { VcsInstallationRemovalService } from "./vcs/VcsInstallationRemovalService"

/** How long one provider's teardown may take before the deletion goes on without it. */
const STEP_TIMEOUT = Duration.seconds(15)

/** Providers torn down at a time. */
const STEP_CONCURRENCY = 4

/** A teardown that ran and left something registered at the vendor. */
export class IntegrationTeardownIncompleteError extends Schema.TaggedError<IntegrationTeardownIncompleteError>()(
	"@maple/backend/IntegrationTeardownIncompleteError",
	{ provider: Schema.String, message: Schema.String },
) {}

export type IntegrationTeardownOutcome = "ok" | "failed" | "timed_out"

export interface IntegrationTeardownResult {
	readonly provider: string
	readonly outcome: IntegrationTeardownOutcome
}

/** One integration's vendor-side removal for an org. A no-op for an org that never connected it. */
interface TeardownStep {
	readonly provider: string
	readonly teardown: (orgId: OrgId) => Effect.Effect<unknown, { readonly message: string }>
}

export interface IntegrationOffboardingServiceApi {
	/**
	 * Ends what the org granted Maple at each vendor (tokens, drains, webhooks, App installations,
	 * chat bots) before its rows are purged. Best effort: a vendor that fails or stalls is logged
	 * and reported in the result, and never fails the caller.
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
		const vcs = yield* VcsInstallationRemovalService
		const chat = yield* ChatWorkspaceService

		const steps: ReadonlyArray<TeardownStep> = [
			// OAuth grants: each disconnect revokes the token at the vendor, then drops the row.
			{ provider: "linear", teardown: linear.disconnect },
			{ provider: "search_console", teardown: google.disconnect },
			{ provider: "cloudflare", teardown: cloudflare.disconnect },
			// Log drains first, then the grant they were made with.
			{ provider: "supabase", teardown: supabase.disconnect },
			{
				provider: "vercel",
				// Its disconnect reports drains it could not delete instead of failing.
				teardown: (orgId) =>
					Effect.flatMap(vercel.disconnect(orgId), (result) =>
						result.drainsRemoved
							? Effect.void
							: Effect.fail(
									new IntegrationTeardownIncompleteError({
										provider: "vercel",
										message: "Vercel drains were not all removed",
									}),
								),
					),
			},
			// Webhooks on each database; PlanetScale has no revoke for the grant itself.
			{ provider: "planetscale", teardown: planetscale.disconnect },
			// Uninstalls the GitHub App, which a disconnect in a living org leaves installed.
			{ provider: "github", teardown: vcs.uninstallForDeletedOrganization },
			// Every linked chat workspace, through its connector's own revoke.
			{ provider: "chat", teardown: chat.uninstallAll },
		]

		const runStep = Effect.fn("IntegrationOffboardingService.step")(function* (
			orgId: OrgId,
			step: TeardownStep,
		) {
			yield* Effect.annotateCurrentSpan({ orgId, "maple.offboarding.provider": step.provider })
			const report = (outcome: IntegrationTeardownOutcome, error: string | null) => ({ outcome, error })
			const { outcome, error } = yield* step.teardown(orgId).pipe(
				Effect.timeoutOption(STEP_TIMEOUT),
				Effect.map((done) => report(Option.isSome(done) ? "ok" : "timed_out", null)),
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
				VcsInstallationRemovalService.layer,
				ChatWorkspaceService.layer,
			),
		),
	)
}
