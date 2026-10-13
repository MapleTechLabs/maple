import { Schema } from "effect"
import type { ProductEventInput, ProductEventName } from "./ProductEventsService"

/**
 * Autumn webhook payload → product events. Autumn delivers through Svix with a
 * `{ type, data }` envelope; `billing.updated` fires "when a customer's plans
 * change — activated, scheduled, updated, or expired" and carries one
 * `plan_changes[]` entry per affected plan (docs.useautumn.com/documentation/webhooks).
 *
 * Mapping (Autumn `customer_id` IS the Maple org id — see `autumn-client.ts`):
 * - `activated`  → `plan_started`   (a `scheduled` plan is not started yet)
 * - `updated`    → `plan_changed`
 * - `expired`    → `plan_cancelled`
 *
 * Autumn's payload has NO subscription id — only `plan_id` and lifecycle
 * timestamps — so `subscription_id` is not attributable here. `started_at`
 * (epoch ms) is carried as `subscription_started_at`; together with `plan_id`
 * it identifies one subscription across the webhook and the inline `attach`
 * emit, which is what a consumer would dedupe on.
 */

const AutumnSubscription = Schema.Struct({
	plan_id: Schema.String,
	status: Schema.optionalKey(Schema.String),
	past_due: Schema.optionalKey(Schema.NullOr(Schema.Boolean)),
	started_at: Schema.optionalKey(Schema.NullOr(Schema.Number)),
	trial_ends_at: Schema.optionalKey(Schema.NullOr(Schema.Number)),
	canceled_at: Schema.optionalKey(Schema.NullOr(Schema.Number)),
	expires_at: Schema.optionalKey(Schema.NullOr(Schema.Number)),
})

const AutumnPurchase = Schema.Struct({
	plan_id: Schema.String,
	status: Schema.optionalKey(Schema.String),
})

const AutumnPlanChange = Schema.Struct({
	action: Schema.String,
	subscription: Schema.optionalKey(Schema.NullOr(AutumnSubscription)),
	purchase: Schema.optionalKey(Schema.NullOr(AutumnPurchase)),
	/** Sparse: only the lifecycle fields this change touched, holding their previous values. */
	previous_attributes: Schema.optionalKey(Schema.NullOr(Schema.Record(Schema.String, Schema.Unknown))),
})

export const AutumnBillingUpdatedData = Schema.Struct({
	customer_id: Schema.String,
	entity_id: Schema.optionalKey(Schema.NullOr(Schema.String)),
	plan_changes: Schema.Array(AutumnPlanChange),
	tags: Schema.optionalKey(Schema.Array(Schema.String)),
})

export const AutumnWebhookEnvelope = Schema.Struct({
	type: Schema.String,
	id: Schema.optionalKey(Schema.String),
	/** Epoch ms; present on some event types. */
	occurred_at: Schema.optionalKey(Schema.Number),
	data: Schema.Unknown,
})
export type AutumnWebhookEnvelope = Schema.Schema.Type<typeof AutumnWebhookEnvelope>

export const decodeAutumnEnvelope = Schema.decodeUnknownEffect(Schema.fromJsonString(AutumnWebhookEnvelope))
export const decodeAutumnBillingUpdated = Schema.decodeUnknownEffect(AutumnBillingUpdatedData)
type AutumnBillingUpdatedData = Schema.Schema.Type<typeof AutumnBillingUpdatedData>

export const AUTUMN_BILLING_UPDATED = "billing.updated"

const ACTION_EVENT: ReadonlyMap<string, ProductEventName> = new Map([
	["activated", "plan_started"],
	["updated", "plan_changed"],
	["expired", "plan_cancelled"],
])

/** Ready-to-track events for one `billing.updated` delivery — possibly none. */
export const planEventsFromBillingUpdated = (
	data: AutumnBillingUpdatedData,
	envelope: { readonly id?: string | undefined; readonly occurred_at?: number | undefined },
): ReadonlyArray<ProductEventInput> => {
	// Entity-scoped plans (per-seat / per-project sub-customers) are not org plans.
	if (data.entity_id !== undefined && data.entity_id !== null && data.entity_id.length > 0) return []
	const events: Array<ProductEventInput> = []
	for (const change of data.plan_changes) {
		const name = ACTION_EVENT.get(change.action)
		if (name === undefined) continue
		const planId = change.subscription?.plan_id ?? change.purchase?.plan_id
		if (planId === undefined) continue
		const startedAt = change.subscription?.started_at ?? undefined
		events.push({
			name,
			groupId: data.customer_id,
			timestamp: name === "plan_started" ? (startedAt ?? envelope.occurred_at) : envelope.occurred_at,
			attributes: {
				plan_id: planId,
				trigger: "webhook",
				kind:
					change.subscription !== undefined && change.subscription !== null
						? "subscription"
						: "purchase",
				...(startedAt !== undefined && startedAt !== null
					? { subscription_started_at: String(startedAt) }
					: undefined),
				...(change.subscription?.trial_ends_at != null ? { trial: "true" } : undefined),
				...(envelope.id !== undefined ? { webhook_message_id: envelope.id } : undefined),
				...(data.tags !== undefined && data.tags.length > 0
					? { tags: data.tags.join(",") }
					: undefined),
			},
		})
	}
	return events
}

/**
 * A customer leaving a plan, as one `billing.updated` delivery describes it.
 *
 * `scheduled` is the moment they asked: Autumn sends `updated` with `canceled_at`
 * newly set while the plan stays active until `expires_at`. `ended` is the plan
 * actually going away, which is the only signal for an immediate cancel or a
 * subscription Stripe gave up collecting on. A scheduled cancel later produces
 * its own `ended`; the review keys on `(orgId, planId, startedAt)` so one
 * subscription is looked at once. A plan switch also ends the old plan: the
 * review tells that apart by asking Autumn what the org holds now.
 */
export interface PlanCancellation {
	readonly orgId: string
	readonly planId: string
	readonly phase: "scheduled" | "ended"
	readonly startedAt: number | null
	readonly canceledAt: number | null
	readonly expiresAt: number | null
	readonly trial: boolean
	readonly pastDue: boolean
}

/** The legacy free tier is not a plan anyone cancels (`isPlanSubscription`, @maple/domain/billing). */
const isFreePlan = (planId: string): boolean => planId.toLowerCase() === "free"

/**
 * `trial_ends_at` stays on a subscription after it converts, so a set value
 * alone does not mean the plan was cancelled during its trial.
 */
const isTrialing = (subscription: {
	readonly trial_ends_at?: number | null | undefined
	readonly canceled_at?: number | null | undefined
	readonly expires_at?: number | null | undefined
}): boolean => {
	const leftAt = subscription.canceled_at ?? subscription.expires_at
	return subscription.trial_ends_at != null && (leftAt == null || subscription.trial_ends_at >= leftAt)
}

export const cancellationsFromBillingUpdated = (
	data: AutumnBillingUpdatedData,
): ReadonlyArray<PlanCancellation> => {
	if (data.entity_id !== undefined && data.entity_id !== null && data.entity_id.length > 0) return []
	const cancellations: Array<PlanCancellation> = []
	for (const change of data.plan_changes) {
		const subscription = change.subscription
		if (subscription == null || isFreePlan(subscription.plan_id)) continue
		const previous = change.previous_attributes ?? {}
		const phase =
			change.action === "updated" &&
			subscription.canceled_at != null &&
			"canceled_at" in previous &&
			previous.canceled_at === null
				? "scheduled"
				: change.action === "expired"
					? "ended"
					: undefined
		if (phase === undefined) continue
		cancellations.push({
			orgId: data.customer_id,
			planId: subscription.plan_id,
			phase,
			startedAt: subscription.started_at ?? null,
			canceledAt: subscription.canceled_at ?? null,
			expiresAt: subscription.expires_at ?? null,
			trial: isTrialing(subscription),
			pastDue: subscription.past_due === true,
		})
	}
	return cancellations
}
