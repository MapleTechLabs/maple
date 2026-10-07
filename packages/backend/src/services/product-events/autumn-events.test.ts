import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import { cancellationsFromBillingUpdated, decodeAutumnBillingUpdated } from "./autumn-events"

const subscription = (overrides: Record<string, unknown> = {}) => ({
	plan_id: "startup",
	status: "active",
	past_due: false,
	started_at: 1_759_248_000_000,
	canceled_at: null,
	expires_at: null,
	trial_ends_at: null,
	current_period_start: 1_761_840_000_000,
	current_period_end: 1_764_432_000_000,
	...overrides,
})

const cancellations = (planChanges: ReadonlyArray<unknown>, extra: Record<string, unknown> = {}) =>
	decodeAutumnBillingUpdated({ customer_id: "org_42", plan_changes: planChanges, ...extra }).pipe(
		Effect.map(cancellationsFromBillingUpdated),
	)

describe("cancellationsFromBillingUpdated", () => {
	it.effect("reads a newly set canceled_at as a scheduled cancellation", () =>
		Effect.gen(function* () {
			const result = yield* cancellations([
				{
					action: "updated",
					subscription: subscription({
						canceled_at: 1_761_840_000_000,
						expires_at: 1_764_432_000_000,
					}),
					previous_attributes: { canceled_at: null, expires_at: null },
				},
			])
			assert.deepStrictEqual(result, [
				{
					orgId: "org_42",
					planId: "startup",
					phase: "scheduled",
					startedAt: 1_759_248_000_000,
					canceledAt: 1_761_840_000_000,
					expiresAt: 1_764_432_000_000,
					trial: false,
					pastDue: false,
				},
			])
		}),
	)

	it.effect("ignores an update that did not touch canceled_at", () =>
		Effect.gen(function* () {
			// A renewal on a subscription already scheduled to cancel: `canceled_at` is
			// set, but it was set before this delivery.
			const result = yield* cancellations([
				{
					action: "updated",
					subscription: subscription({ canceled_at: 1_761_840_000_000 }),
					previous_attributes: { current_period_end: 1_761_840_000_000 },
				},
			])
			assert.deepStrictEqual(result, [])
		}),
	)

	it.effect("ignores a reversed cancellation", () =>
		Effect.gen(function* () {
			const result = yield* cancellations([
				{
					action: "updated",
					subscription: subscription(),
					previous_attributes: { canceled_at: 1_761_840_000_000, expires_at: 1_764_432_000_000 },
				},
			])
			assert.deepStrictEqual(result, [])
		}),
	)

	it.effect("reads an expired plan as ended, carrying past_due and trial", () =>
		Effect.gen(function* () {
			const result = yield* cancellations([
				{
					action: "expired",
					subscription: subscription({
						status: "expired",
						past_due: true,
						expires_at: 1_764_432_000_000,
						trial_ends_at: 1_760_457_600_000,
					}),
					previous_attributes: { status: "active" },
				},
			])
			assert.deepStrictEqual(
				result.map(({ phase, pastDue, trial }) => ({ phase, pastDue, trial })),
				[{ phase: "ended", pastDue: true, trial: true }],
			)
		}),
	)

	it.effect("reports the ended plan of a switch, leaving the consumer to recognise it", () =>
		Effect.gen(function* () {
			// The payload cannot tell a replacement plan from an add-on starting in
			// the same delivery, so nothing is dropped here.
			const result = yield* cancellations([
				{ action: "activated", subscription: subscription({ plan_id: "scale" }) },
				{ action: "expired", subscription: subscription({ status: "expired" }) },
			])
			assert.deepStrictEqual(
				result.map(({ planId, phase }) => ({ planId, phase })),
				[{ planId: "startup", phase: "ended" }],
			)
		}),
	)

	it.effect("skips the free tier, one-off purchases and entity-scoped plans", () =>
		Effect.gen(function* () {
			const free = yield* cancellations([
				{ action: "expired", subscription: subscription({ plan_id: "free", status: "expired" }) },
			])
			const purchase = yield* cancellations([
				{ action: "expired", purchase: { plan_id: "credits", status: "expired" } },
			])
			const entity = yield* cancellations(
				[{ action: "expired", subscription: subscription({ status: "expired" }) }],
				{ entity_id: "seat_1" },
			)
			assert.deepStrictEqual([free, purchase, entity], [[], [], []])
		}),
	)
})
