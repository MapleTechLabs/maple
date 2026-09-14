import { orgOnboardingState } from "@maple/db"
import type { OrgOnboardingStateRow } from "@maple/db"
import { OnboardingPersistenceError, OnboardingStateResponse } from "@maple/domain/http"
import type { OrgId } from "@maple/domain/http"
import { and, eq, isNull } from "drizzle-orm"
import { Clock, Context, Effect, Layer, Option } from "effect"
import { Database } from "@maple/backend/platform/DatabaseLive"
import { dateToMs } from "@maple/backend/platform/time"

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
		onboardingCompletedAt: dateToMs(row.onboardingCompletedAt),
		checklistDismissedAt: dateToMs(row.checklistDismissedAt),
		firstDataReceivedAt: dateToMs(row.firstDataReceivedAt),
		rewardClaimedAt: dateToMs(row.rewardClaimedAt),
		createdAt: row.createdAt.getTime(),
		updatedAt: row.updatedAt.getTime(),
	})
}

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
						db
							.update(orgOnboardingState)
							.set({
								...(input.role != null ? { role: input.role } : undefined),
								...(input.demoDataRequested != null
									? {
											demoDataRequested: input.demoDataRequested,
										}
									: undefined),
								...(input.markOnboardingComplete
									? { onboardingCompletedAt: new Date(now) }
									: undefined),
								...(input.markChecklistDismissed
									? { checklistDismissedAt: new Date(now) }
									: undefined),
								...(userId != null ? { userId } : undefined),
								...(email != null ? { email } : undefined),
								updatedAt: new Date(now),
							})
							.where(eq(orgOnboardingState.orgId, orgId)),
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
			 * Reserve the onboarding reward: stamps `rewardClaimedAt` only if it is
			 * still null and reports whether this call won. The stamp goes down BEFORE
			 * the upstream redeem so two concurrent claims cannot both reach Autumn.
			 */
			const markRewardClaimed = Effect.fn("OnboardingService.markRewardClaimed")(function* (
				orgId: OrgId,
			) {
				const now = yield* Clock.currentTimeMillis
				const result = yield* database
					.execute((db) =>
						db
							.update(orgOnboardingState)
							.set({ rewardClaimedAt: new Date(now), updatedAt: new Date(now) })
							.where(
								and(
									eq(orgOnboardingState.orgId, orgId),
									isNull(orgOnboardingState.rewardClaimedAt),
								),
							)
							.returning({ id: orgOnboardingState.orgId }),
					)
					.pipe(Effect.mapError(toPersistenceError))
				return result.length > 0
			})

			/** Roll back a reservation whose upstream redeem failed, so the org can try again. */
			const clearRewardClaim = Effect.fn("OnboardingService.clearRewardClaim")(function* (
				orgId: OrgId,
			) {
				const now = yield* Clock.currentTimeMillis
				yield* database
					.execute((db) =>
						db
							.update(orgOnboardingState)
							.set({ rewardClaimedAt: null, updatedAt: new Date(now) })
							.where(eq(orgOnboardingState.orgId, orgId)),
					)
					.pipe(Effect.mapError(toPersistenceError))
			})

			const markEmailSent = Effect.fn("OnboardingService.markEmailSent")(function* (
				orgId: OrgId,
				field: OnboardingEmailField,
			) {
				const now = yield* Clock.currentTimeMillis
				const set: Partial<typeof orgOnboardingState.$inferInsert> = { updatedAt: new Date(now) }
				if (field === "welcomeEmailSentAt") set.welcomeEmailSentAt = new Date(now)
				else if (field === "connectNudgeEmailSentAt") set.connectNudgeEmailSentAt = new Date(now)
				else if (field === "stalledEmailSentAt") set.stalledEmailSentAt = new Date(now)
				else set.activationEmailSentAt = new Date(now)

				yield* database
					.execute((db) =>
						db.update(orgOnboardingState).set(set).where(eq(orgOnboardingState.orgId, orgId)),
					)
					.pipe(Effect.mapError(toPersistenceError))
			})

			const listAll = Effect.fn("OnboardingService.listAll")(function* () {
				return yield* database
					.execute((db) => db.select().from(orgOnboardingState))
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
							db
								.update(orgOnboardingState)
								.set({
									welcomeEmailSentAt: new Date(now),
									connectNudgeEmailSentAt: new Date(now),
									stalledEmailSentAt: new Date(now),
									activationEmailSentAt: new Date(now),
									onboardingCompletedAt: new Date(now),
									updatedAt: new Date(now),
								})
								.where(
									and(
										eq(orgOnboardingState.orgId, orgId),
										isNull(orgOnboardingState.onboardingCompletedAt),
									),
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
				markRewardClaimed,
				clearRewardClaim,
				markEmailSent,
				suppressOnboardingEmails,
				listAll,
			}
		}),
	},
) {
	static readonly layer = Layer.effect(this, this.make)
}
