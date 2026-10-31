import { OrgId } from "@maple/domain/http"
import { BillingCustomerResolver } from "@maple/backend/services/billing/BillingCustomerResolver"
import { Clock, Effect, Option, Schema } from "effect"
import { HttpRouter, type HttpServerRequest } from "effect/http"
import { Env } from "@maple/backend/platform/Env"
import { CancellationReviewService } from "@maple/backend/services/cancellation-review/CancellationReviewService"
import {
	AUTUMN_BILLING_UPDATED,
	cancellationsFromBillingUpdated,
	decodeAutumnBillingUpdated,
	decodeAutumnEnvelope,
	planEventsFromBillingUpdated,
} from "@maple/backend/services/product-events/autumn-events"
import { ProductEventsService } from "@maple/backend/services/product-events/ProductEventsService"
import { receiveSvixWebhook, webhookText } from "./svix-receiver"

/**
 * Autumn webhook receiver: `billing.updated` → `plan_started` / `plan_changed`
 * / `plan_cancelled` product events, `group_id` = the Autumn customer id, which
 * is the Maple org id. Public route; authenticity is the Svix signature
 * (`AUTUMN_WEBHOOK_SECRET`). Other event types are acknowledged with 200.
 *
 * A cancelled plan is also reviewed (`CancellationReviewService`), after the
 * product events are recorded, so the funnel never waits on the review. A
 * review that could not finish answers 503 for Svix to redeliver; that
 * redelivery records the delivery's events again, under the same
 * `webhook_message_id`.
 */
const ROUTE = "/webhooks/autumn"

const decodeOrgId = Schema.decodeUnknownOption(OrgId)

export const AutumnWebhookRouter = HttpRouter.use((router) =>
	Effect.gen(function* () {
		const env = yield* Env
		const productEvents = yield* ProductEventsService
		const cancellationReviews = yield* CancellationReviewService
		const billingCustomers = yield* BillingCustomerResolver

		const handle = Effect.fn("AutumnWebhook.receive")(function* (
			req: HttpServerRequest.HttpServerRequest,
		) {
			yield* Effect.annotateCurrentSpan({ "http.request.method": req.method, "http.route": ROUTE })

			const received = yield* receiveSvixWebhook({
				provider: "autumn",
				secret: env.AUTUMN_WEBHOOK_SECRET,
				request: req,
			})
			if (received._tag === "rejected") return received.response

			const envelope = yield* decodeAutumnEnvelope(received.body).pipe(Effect.option)
			if (Option.isNone(envelope)) {
				yield* Effect.annotateCurrentSpan({
					"http.response.status_code": 400,
					"maple.webhook.outcome": "rejected",
					"maple.webhook.reason": "parse_rejected",
				})
				return webhookText("Unrecognized payload", 400)
			}
			yield* Effect.annotateCurrentSpan({ "maple.webhook.event": envelope.value.type })

			if (envelope.value.type === AUTUMN_BILLING_UPDATED) {
				const data = yield* decodeAutumnBillingUpdated(envelope.value.data).pipe(
					Effect.tapError((error) =>
						Effect.logInfo("Autumn billing.updated payload failed to decode").pipe(
							Effect.annotateLogs({ error: String(error) }),
						),
					),
					Effect.option,
				)
				if (Option.isSome(data)) {
					// Linking cancels the org's own plans: that is billing moving, not churn. An unread link
					// answers 503 so the delivery comes back, rather than reporting churn that was not.
					const linked = yield* Option.match(decodeOrgId(data.value.customer_id), {
						onNone: () => Effect.succeed(Option.some(false)),
						onSome: (orgId) =>
							billingCustomers.readLink(orgId).pipe(
								Effect.map((link) => Option.some(Option.isSome(link))),
								Effect.catchTag(
									"@maple/http/errors/BillingAccountPersistenceError",
									(error) =>
										Effect.logWarning(
											"Could not read the org's billing link; asking Svix to redeliver",
										).pipe(
											Effect.annotateLogs({ orgId, error: error.message }),
											Effect.as(Option.none<boolean>()),
										),
								),
							),
					})
					if (Option.isNone(linked)) {
						yield* Effect.annotateCurrentSpan({
							orgId: data.value.customer_id,
							"http.response.status_code": 503,
							"maple.webhook.outcome": "link_unread",
						})
						return webhookText("Could not read the billing link", 503)
					}
					const billedThroughAnother = linked.value
					// A review ends in a Slack post; without a channel there is nothing to do.
					const cancellations =
						Option.isSome(env.MAPLE_CANCELLATION_SLACK_CHANNEL_ID) && !billedThroughAnother
							? cancellationsFromBillingUpdated(data.value)
							: []
					const events = billedThroughAnother
						? []
						: planEventsFromBillingUpdated(data.value, {
								id: envelope.value.id ?? received.messageId,
								occurred_at: envelope.value.occurred_at,
							})
					yield* Effect.annotateCurrentSpan({
						orgId: data.value.customer_id,
						"maple.webhook.outcome": "handled",
						"maple.webhook.emitted": events.length,
						"maple.webhook.cancellations": cancellations.length,
						"maple.billing.linked": billedThroughAnother,
					})
					yield* Effect.forEach(events, (event) => productEvents.track(event), { discard: true })

					const receivedAt = yield* Clock.currentTimeMillis
					const reviewed = yield* Effect.forEach(
						cancellations,
						({ orgId: rawOrgId, ...cancellation }) =>
							Option.match(decodeOrgId(rawOrgId), {
								// Not an id this instance could have issued; nothing to review.
								onNone: () =>
									Effect.logWarning(
										"Autumn customer id is not an org id; cancellation not reviewed",
									).pipe(Effect.annotateLogs({ rawOrgId })),
								onSome: (orgId) =>
									cancellationReviews.review({ ...cancellation, orgId, receivedAt }),
							}),
						{ discard: true },
					).pipe(
						Effect.as(true),
						Effect.catchTag(
							"@maple/backend/cancellation-review/CancellationReviewError",
							(error) =>
								Effect.logWarning(
									"Cancellation review did not finish; asking Svix to redeliver",
								).pipe(
									Effect.annotateLogs({
										orgId: data.value.customer_id,
										step: error.step,
										error: error.message,
									}),
									Effect.as(false),
								),
						),
					)
					if (!reviewed) {
						yield* Effect.annotateCurrentSpan({
							orgId: data.value.customer_id,
							"http.response.status_code": 503,
							"maple.webhook.outcome": "review_failed",
						})
						return webhookText("Could not review the cancellation", 503)
					}
				} else {
					yield* Effect.annotateCurrentSpan({ "maple.webhook.outcome": "parse_rejected" })
				}
			} else {
				yield* Effect.annotateCurrentSpan({ "maple.webhook.outcome": "ignored" })
			}

			yield* Effect.annotateCurrentSpan({ "http.response.status_code": 200 })
			return webhookText("ok", 200)
		})

		yield* router.add("POST", ROUTE, handle)
	}),
)
