import * as PG from "@maple-dev/effect-orm/postgres"
import { OrgOnboardingState, type OrgOnboardingStateRow } from "@maple/db/tables"
import { OnboardingPersistenceError, OnboardingStateResponse } from "@maple/domain/http"
import type { OrgId } from "@maple/domain/http"
import { Clock, Context, Effect, Layer, Option } from "effect"
import { Database } from "@maple/backend/platform/DatabaseLive"

const toPersistenceError = (error: unknown) =>
	new OnboardingPersistenceError({
		message: error instanceof Error ? error.message : `Onboarding persistence error: ${String(error)}`,
	})

export type OnboardingEmailField =
	| "welcomeEmailSentAt"
	| "connectNudgeEmailSentAt"
	| "stalledEmailSentAt"
	| "activationEmailSentAt"

interface OnboardingUpdateInput {
	role?: string
	demoDataRequested?: boolean
	markOnboardingComplete?: boolean
	markChecklistDismissed?: boolean
}

function rowToResponse(row: OrgOnboardingStateRow): OnboardingStateResponse {
	return new OnboardingStateResponse({
		role: row.role ?? null,
		demoDataRequested: row.demoDataRequested,
		onboardingCompletedAt: row.onboardingCompletedAt,
		checklistDismissedAt: row.checklistDismissedAt,
		firstDataReceivedAt: row.firstDataReceivedAt,
		rewardClaimedAt: row.rewardClaimedAt,
		rewardReservedAt: row.rewardReservedAt,
		createdAt: row.createdAt,
		updatedAt: row.updatedAt,
	})
}

const emailSentStamp = (field: OnboardingEmailField, now: number) => {
	switch (field) {
		case "welcomeEmailSentAt":
			return { welcomeEmailSentAt: now }
		case "connectNudgeEmailSentAt":
			return { connectNudgeEmailSentAt: now }
		case "stalledEmailSentAt":
			return { stalledEmailSentAt: now }
		case "activationEmailSentAt":
			return { activationEmailSentAt: now }
	}
}

export class OnboardingService extends Context.Service<OnboardingService>()(
	"@maple/api/services/OnboardingService",
	{
		make: Effect.gen(function* () {
			const database = yield* Database

			const findRow = (orgId: OrgId) =>
				database
					.execute((db) =>
						db.run(
							PG.from(OrgOnboardingState)
								.select()
								.where(($) => [$.orgId.eq(orgId)])
								.limit(1),
						),
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
						db.run(
							PG.insertInto(OrgOnboardingState)
								.values({
									orgId,
									userId: userId ?? null,
									email: email ?? null,
									demoDataRequested: false,
									createdAt: opts?.createdAt ?? now,
									updatedAt: now,
								})
								.onConflictDoNothing(),
						),
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

			const getState = Effect.fn("OnboardingService.getState")(function* (
				orgId: OrgId,
				userId?: string,
				email?: string,
			) {
				yield* Effect.annotateCurrentSpan("orgId", orgId)
				const row = yield* ensureRow(orgId, userId, email)
				return rowToResponse(row)
			})

			const updateState = Effect.fn("OnboardingService.updateState")(function* (
				orgId: OrgId,
				userId: string | undefined,
				email: string | undefined,
				input: OnboardingUpdateInput,
			) {
				yield* Effect.annotateCurrentSpan("orgId", orgId)
				yield* ensureRow(orgId, userId, email)

				const now = yield* Clock.currentTimeMillis
				yield* database
					.execute((db) =>
						db.run(
							PG.update(OrgOnboardingState)
								.set({
									...(input.role != null ? { role: input.role } : undefined),
									...(input.demoDataRequested != null
										? {
												demoDataRequested: input.demoDataRequested,
											}
										: undefined),
									...(input.markOnboardingComplete
										? { onboardingCompletedAt: now }
										: undefined),
									...(input.markChecklistDismissed
										? { checklistDismissedAt: now }
										: undefined),
									...(userId != null ? { userId } : undefined),
									...(email != null ? { email } : undefined),
									updatedAt: now,
								})
								.where(($) => [$.orgId.eq(orgId)]),
						),
					)
					.pipe(Effect.mapError(toPersistenceError))

				const row = yield* findRow(orgId)
				if (!row) {
					return yield* new OnboardingPersistenceError({
						message: "Onboarding state row missing after update",
					})
				}
				return rowToResponse(row)
			})

			/** Stamp first-data time only if not already set. Returns true when newly stamped. */
			const recordFirstDataReceived = Effect.fn("OnboardingService.recordFirstDataReceived")(function* (
				orgId: OrgId,
			) {
				const now = yield* Clock.currentTimeMillis
				const result = yield* database
					.execute((db) =>
						db.run(
							PG.update(OrgOnboardingState)
								.set({ firstDataReceivedAt: now, updatedAt: now })
								.where(($) => [$.orgId.eq(orgId), $.firstDataReceivedAt.isNull()])
								.returning(($) => ({ id: $.orgId })),
						),
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
						db.run(
							PG.update(OrgOnboardingState)
								.set({ rewardReservedAt: now, updatedAt: now })
								.where(($) => [
									$.orgId.eq(orgId),
									$.rewardClaimedAt.isNull(),
									PG.or($.rewardReservedAt.isNull(), $.rewardReservedAt.lt(now - leaseMs)),
								])
								.returning(($) => ({ id: $.orgId })),
						),
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
						db.run(
							PG.update(OrgOnboardingState)
								.set({
									rewardClaimedAt: now,
									rewardReservedAt: null,
									updatedAt: now,
								})
								.where(($) => [$.orgId.eq(orgId)]),
						),
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
						db.run(
							PG.update(OrgOnboardingState)
								.set({ rewardReservedAt: null, updatedAt: now })
								.where(($) => [$.orgId.eq(orgId)]),
						),
					)
					.pipe(Effect.mapError(toPersistenceError))
			})

			const markEmailSent = Effect.fn("OnboardingService.markEmailSent")(function* (
				orgId: OrgId,
				field: OnboardingEmailField,
			) {
				const now = yield* Clock.currentTimeMillis
				yield* database
					.execute((db) =>
						db.run(
							PG.update(OrgOnboardingState)
								.set({ ...emailSentStamp(field, now), updatedAt: now })
								.where(($) => [$.orgId.eq(orgId)]),
						),
					)
					.pipe(Effect.mapError(toPersistenceError))
			})

			const listAll = Effect.fn("OnboardingService.listAll")(function* () {
				return yield* database
					.execute((db) => db.run(PG.from(OrgOnboardingState).select()))
					.pipe(Effect.mapError(toPersistenceError))
			})

			/**
			 * Mark an org as already-onboarded so the activation email sequence never
			 * fires for it — used for orgs that predate the onboarding-emails feature.
			 * One-shot: the `onboardingCompletedAt IS NULL` guard means re-running is a
			 * no-op once an org has been suppressed.
			 */
			const suppressOnboardingEmails = Effect.fn("OnboardingService.suppressOnboardingEmails")(
				function* (orgId: OrgId) {
					const now = yield* Clock.currentTimeMillis
					yield* database
						.execute((db) =>
							db.run(
								PG.update(OrgOnboardingState)
									.set({
										welcomeEmailSentAt: now,
										connectNudgeEmailSentAt: now,
										stalledEmailSentAt: now,
										activationEmailSentAt: now,
										onboardingCompletedAt: now,
										updatedAt: now,
									})
									.where(($) => [$.orgId.eq(orgId), $.onboardingCompletedAt.isNull()]),
							),
						)
						.pipe(Effect.mapError(toPersistenceError))
				},
			)

			return {
				findState,
				getState,
				updateState,
				ensureRow,
				recordFirstDataReceived,
				reserveRewardClaim,
				finalizeRewardClaim,
				releaseRewardClaim,
				markEmailSent,
				suppressOnboardingEmails,
				listAll,
			}
		}),
	},
) {
	static readonly layer = Layer.effect(this, this.make)
}
