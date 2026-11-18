import { assert, describe, it } from "@effect/vitest"
import { Effect, Fiber, Layer, Array as Arr } from "effect"
import { TestClock } from "effect/testing"
import { IntegrationsPersistenceError, type OrgId } from "@maple/domain/http"
import {
	fakeOffboardingProviders,
	OFFBOARDED_PROVIDERS,
	type FakeOffboardingOptions,
	type OffboardedProvider,
} from "@maple/backend/testing/offboarding-providers"
import { ORG_A } from "@maple/backend/testing/test-two-orgs"
import { IntegrationOffboardingService } from "./IntegrationOffboardingService"

const offboardingOver = (options: FakeOffboardingOptions) =>
	Layer.effect(IntegrationOffboardingService, IntegrationOffboardingService.make).pipe(
		Layer.provide(fakeOffboardingProviders(options)),
	)

const vendorDown = (provider: OffboardedProvider) =>
	Effect.fail(new IntegrationsPersistenceError({ message: `${provider} is down` }))

/** The providers whose teardown ended as `outcome`. */
const withOutcome = (
	results: ReadonlyArray<{ readonly provider: string; readonly outcome: string }>,
	outcome: string,
) =>
	Arr.map(
		Arr.filter(results, (result) => result.outcome === outcome),
		(result) => result.provider,
	)

describe("IntegrationOffboardingService.teardown", () => {
	it.effect("runs every integration's vendor teardown for the org", () => {
		const calls: Array<{ readonly provider: OffboardedProvider; readonly orgId: OrgId }> = []
		return Effect.gen(function* () {
			const offboarding = yield* IntegrationOffboardingService
			const results = yield* offboarding.teardown(ORG_A)
			assert.sameMembers(
				Arr.map(calls, (call) => call.provider),
				[...OFFBOARDED_PROVIDERS],
			)
			assert.isTrue(Arr.every(calls, (call) => call.orgId === ORG_A))
			assert.sameMembers(withOutcome(results, "ok"), [...OFFBOARDED_PROVIDERS])
		}).pipe(
			Effect.provide(
				offboardingOver({
					teardown: (provider, orgId) => Effect.sync(() => void calls.push({ provider, orgId })),
				}),
			),
		)
	})

	it.effect("reports a vendor that fails or dies and still runs the others", () =>
		Effect.gen(function* () {
			const offboarding = yield* IntegrationOffboardingService
			const results = yield* offboarding.teardown(ORG_A)
			assert.sameMembers(withOutcome(results, "failed"), ["linear", "vercel"])
			assert.lengthOf(withOutcome(results, "ok"), OFFBOARDED_PROVIDERS.length - 2)
		}).pipe(
			Effect.provide(
				offboardingOver({
					teardown: (provider) =>
						provider === "linear"
							? vendorDown(provider)
							: provider === "vercel"
								? Effect.die("a bug in the teardown")
								: Effect.void,
				}),
			),
		),
	)

	it.effect("gives up on a vendor that never answers and reports it timed out", () => {
		const started: Array<OffboardedProvider> = []
		return Effect.gen(function* () {
			const offboarding = yield* IntegrationOffboardingService
			const pending = yield* Effect.forkChild(offboarding.teardown(ORG_A))
			yield* TestClock.adjust("1 minute")
			const results = yield* Fiber.join(pending)
			assert.deepStrictEqual(withOutcome(results, "timed_out"), ["supabase"])
			// The stalled vendor held nobody else up.
			assert.sameMembers(started, [...OFFBOARDED_PROVIDERS])
		}).pipe(
			Effect.provide(
				offboardingOver({
					teardown: (provider) =>
						Effect.andThen(
							Effect.sync(() => void started.push(provider)),
							provider === "supabase" ? Effect.never : Effect.void,
						),
				}),
			),
		)
	})

	it.effect("reports a vendor that refused while its disconnect completed", () =>
		Effect.gen(function* () {
			const offboarding = yield* IntegrationOffboardingService
			const results = yield* offboarding.teardown(ORG_A)
			// Every integration's own disconnect succeeded; each vendor refused its side.
			assert.sameMembers(withOutcome(results, "failed"), [...OFFBOARDED_PROVIDERS])
		}).pipe(
			Effect.provide(offboardingOver({ teardown: () => Effect.void, refusedBy: OFFBOARDED_PROVIDERS })),
		),
	)
})
