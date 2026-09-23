/**
 * Slack's half of `POST /connectors/slack/webhook`.
 *
 * One route carries three different things — the URL-verification handshake, delivered events, and
 * interactivity payloads — because Slack's app configuration takes one request URL per surface and
 * this connector points all of them here. What arrives is told apart by its content type and then
 * by its `type` field, never by a path.
 *
 * The order in this file IS the security property: the raw body is read, the signature is verified
 * against it, and only then is a byte of it parsed. Everything below the check runs on text the
 * app's signing secret vouched for.
 *
 * Nothing is awaited that Slack is waiting on. The handler answers 200 and hands the events back
 * to the host, which relays them afterwards — Slack drops an event that is not acknowledged within
 * three seconds and retries it, and an agent turn is not a three-second operation.
 */
import { Clock, Effect, Option } from "effect"
import { HttpServerResponse, type HttpServerRequest } from "effect/unstable/http"
import {
	ConnectorIngressError,
	type ConnectorConfig,
	type InboundEvent,
	type WebhookIngress,
	type WebhookIngressResult,
} from "../../ingress"
import { RETRY_HEADER, SIGNATURE_HEADER, SIGNING_SECRET_CONFIG, TIMESTAMP_HEADER } from "./api"
import { blockActionsToInbound, eventCallbackToInbound } from "./events"
import { SLACK_CONNECTOR_ID } from "./id"
import { decodeBlockActions, decodeEventRequest } from "./payloads"
import { verifySlackSignature } from "./signature"

/**
 * Everything Slack is told, and it is always the same.
 *
 * Slack does not read a body except on the URL-verification handshake, and telling a caller which
 * of the checks below refused it is telling an attacker which one to fix. The reason goes on the
 * span instead, where the host puts it.
 */
const accepted = HttpServerResponse.empty({ status: 200 })

const rejected = (reason: string, cause?: unknown) =>
	new ConnectorIngressError({
		connector: SLACK_CONNECTOR_ID,
		message: reason,
		...(cause === undefined ? undefined : { cause }),
	})

/** Nothing happened, and Slack is told it went fine — which is what stops the retry. */
const nothing: WebhookIngressResult = { response: accepted, events: [] }

const result = (events: ReadonlyArray<InboundEvent>): WebhookIngressResult => ({
	response: accepted,
	events,
})

/**
 * Slack's form-encoded interactivity body, which carries its JSON under one field.
 *
 * Read off the raw text rather than through a request-body helper, because the text is what was
 * signed and re-reading the body would be a second parse of something that might not match it.
 */
const interactivityPayload = (body: string): string | undefined =>
	new URLSearchParams(body).get("payload") ?? undefined

const isFormEncoded = (request: HttpServerRequest.HttpServerRequest): boolean =>
	(request.headers["content-type"] ?? "").includes("application/x-www-form-urlencoded")

/**
 * One event, one delivery.
 *
 * Slack retries an event it believes was not acknowledged, up to three times. This handler answers
 * inside its own request, so a retry means Slack did not hear the 200 rather than that the event
 * went unhandled — and relaying it again would answer the same question twice in the same thread.
 * Acknowledged and dropped.
 *
 * That is the whole deduplication story, deliberately: `event_id` deduplication needs storage, and
 * ingress is a pure function the host may run in any isolate. Slack's own retry header is the one
 * duplicate signal available without inventing that storage, and it covers the case that actually
 * happens.
 */
const isRetry = (request: HttpServerRequest.HttpServerRequest): boolean =>
	request.headers[RETRY_HEADER] !== undefined

const handle = Effect.fnUntraced(function* (
	request: HttpServerRequest.HttpServerRequest,
	config: ConnectorConfig,
) {
	const signingSecret = config.get(SIGNING_SECRET_CONFIG)
	if (signingSecret === undefined) {
		// Unreachable through the host, which skips a connector whose declared configuration is
		// missing. Present so this can never degrade into an unverified mode if that ever changes.
		return yield* Effect.fail(rejected("Slack ingress has no signing secret"))
	}
	const body = yield* request.text.pipe(
		Effect.mapError((cause) => rejected("Slack's request body could not be read", cause)),
	)
	const now = yield* Clock.currentTimeMillis
	const verdict = verifySlackSignature({
		signature: request.headers[SIGNATURE_HEADER],
		timestamp: request.headers[TIMESTAMP_HEADER],
		body,
		signingSecret,
		now,
	})
	if (verdict._tag === "rejected") {
		return yield* Effect.fail(rejected(`Slack request rejected: ${verdict.reason}`))
	}

	if (isFormEncoded(request)) {
		const payload = interactivityPayload(body)
		if (payload === undefined) return nothing
		return Option.match(decodeBlockActions(payload), {
			// A modal submission, a shortcut, a view close — all arrive here and none of them is
			// something Maple rendered. Acknowledged so Slack stops asking.
			onNone: () => nothing,
			onSome: (actions) => result(blockActionsToInbound(actions)),
		})
	}

	return Option.match(decodeEventRequest(body), {
		// A body that is not JSON, and a body that is JSON but not one of the two payloads this
		// connector reads, are the same thing here: signed, and nothing to do about it.
		onNone: () => nothing,
		onSome: (request_) => {
			if (request_.type === "url_verification") {
				// Answered inline, and the one case with a body: Slack accepts the bare challenge as
				// text, which is the narrowest of the three forms it documents.
				return { response: HttpServerResponse.text(request_.challenge), events: [] }
			}
			return isRetry(request) ? nothing : result(eventCallbackToInbound(request_))
		},
	})
})

export const slackIngress: WebhookIngress = {
	kind: "webhook",
	requiredConfig: [{ name: SIGNING_SECRET_CONFIG, secret: true }],
	handle,
}
