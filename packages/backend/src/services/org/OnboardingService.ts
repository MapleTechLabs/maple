import { orgOnboardingState } from "@maple/db"
import { OnboardingPersistenceError } from "@maple/domain/http"
import type { OrgId } from "@maple/domain/http"
import { and, eq, isNull, lt, or } from "drizzle-orm"
import { Clock, Context, Effect, Layer, Option } from "effect"
import { Database } from "@maple/backend/platform/DatabaseLive"

const toPersistenceError = (error: unknown) =>
	new OnboardingPersistenceError({
		message: error instanceof Error ? error.message : `Onboarding persistence error: ${String(error)}`,
	})

export class OnboardingService extends Context.Service<OnboardingService>()(
	"@maple/api/services/OnboardingService",
	{
		make: Effect.gen(function* () {
			const database = yield* Database

			const findRow = (orgId: OrgId) =>
				database
					.execute((db) =>
						db
							.select()
							.from(orgOnboardingState)
							.where(eq(orgOnboardingState.orgId, orgId))
							.limit(1),
					)
					.pipe(
						Effect.mapError(toPersistenceError),
						Effect.map((rows) => rows[0]),
					)

			const ensureRow = Effect.fn("OnboardingService.ensureRow")(function* (
				orgId: OrgId,
				userId?: string,
				email?: string,
				opts?: { createdAt?: number },
			) {
				const existing = yield* findRow(orgId)
				if (existing) return existing

				const now = yield* Clock.currentTimeMillis
				yield* database
					.execute((db) =>
						db
							.insert(orgOnboardingState)
							.values({
								orgId,
								userId: userId ?? null,
								email: email ?? null,
								demoDataRequested: false,
								createdAt: new Date(opts?.createdAt ?? now),
								updatedAt: new Date(now),
							})
							.onConflictDoNothing(),
					)
					.pipe(Effect.mapError(toPersistenceError))

				const row = yield* findRow(orgId)
				if (!row) {
					return yield* new OnboardingPersistenceError({
						message: "Failed to create onboarding state row",
					})
				}
				return row
			})

			/** The row as it is, or `None`; never creates one. */
			const findState = Effect.fn("OnboardingService.findState")(function* (orgId: OrgId) {
				return Option.fromNullishOr(yield* findRow(orgId))
			})

			/** Stamp first-data time only if not already set. Returns true when newly stamped. */
			const recordFirstDataReceived = Effect.fn("OnboardingService.recordFirstDataReceived")(function* (
				orgId: OrgId,
			) {
				const now = yield* Clock.currentTimeMillis
				const result = yield* database
					.execute((db) =>
						db
							.update(orgOnboardingState)
							.set({ firstDataReceivedAt: new Date(now), updatedAt: new Date(now) })
							.where(
								and(
									eq(orgOnboardingState.orgId, orgId),
									isNull(orgOnboardingState.firstDataReceivedAt),
								),
							)
							.returning({ id: orgOnboardingState.orgId }),
					)
					.pipe(Effect.mapError(toPersistenceError))
				return result.length > 0
			})

			/**
			 * Take the reward claim lease: stamps `rewardReservedAt` if the reward is not
			 * claimed and no live reservation exists (a reservation older than `leaseMs`
			 * is a crashed attempt and may be taken over). Reports whether this call won.
			 */
			const reserveRewardClaim = Effect.fn("OnboardingService.reserveRewardClaim")(function* (
				orgId: OrgId,
				leaseMs: number,
			) {
				const now = yield* Clock.currentTimeMillis
				const result = yield* database
					.execute((db) =>
						db
							.update(orgOnboardingState)
							.set({ rewardReservedAt: new Date(now), updatedAt: new Date(now) })
							.where(
								and(
									eq(orgOnboardingState.orgId, orgId),
									isNull(orgOnboardingState.rewardClaimedAt),
									or(
										isNull(orgOnboardingState.rewardReservedAt),
										lt(orgOnboardingState.rewardReservedAt, new Date(now - leaseMs)),
									),
								),
							)
							.returning({ id: orgOnboardingState.orgId }),
					)
					.pipe(Effect.mapError(toPersistenceError))
				return result.length > 0
			})

			/** Billing confirmed the credit: the claim is final and the lease is released. */
			const finalizeRewardClaim = Effect.fn("OnboardingService.finalizeRewardClaim")(function* (
				orgId: OrgId,
			) {
				const now = yield* Clock.currentTimeMillis
				yield* database
					.execute((db) =>
						db
							.update(orgOnboardingState)
							.set({
								rewardClaimedAt: new Date(now),
								rewardReservedAt: null,
								updatedAt: new Date(now),
							})
							.where(eq(orgOnboardingState.orgId, orgId)),
					)
					.pipe(Effect.mapError(toPersistenceError))
			})

			/** Billing refused before anything was applied: give the lease back so the org can retry now. */
			const releaseRewardClaim = Effect.fn("OnboardingService.releaseRewardClaim")(function* (
				orgId: OrgId,
			) {
				const now = yield* Clock.currentTimeMillis
				yield* database
					.execute((db) =>
						db
							.update(orgOnboardingState)
							.set({ rewardReservedAt: null, updatedAt: new Date(now) })
							.where(eq(orgOnboardingState.orgId, orgId)),
					)
					.pipe(Effect.mapError(toPersistenceError))
			})

			return {
				findState,
				ensureRow,
				recordFirstDataReceived,
				reserveRewardClaim,
				finalizeRewardClaim,
				releaseRewardClaim,
			}
		}),
	},
) {
	static readonly layer = Layer.effect(this, this.make)
}
