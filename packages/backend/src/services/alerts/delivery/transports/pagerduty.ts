import { Duration, Effect, Schema, String as Str } from "effect"
import { HttpClient, HttpClientRequest } from "effect/http"
import { displayGroupKey, formatAlertHeadline, truncate, uptimeSummaryLine } from "../../alert-formatting"
import {
	closesCriticalKey,
	criticalDedupKey,
	keySeverity,
	pagingDedupKey,
	primaryDedupKey,
} from "../paging-dedup"
import type { HttpRequestSpec, HttpTransport, RenderInput, SecretConfigOf } from "../Transport"

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))

type Config = SecretConfigOf<"pagerduty">

const EVENTS_URL = "https://events.pagerduty.com/v2/enqueue"

const resolveRequest = (integrationKey: string, dedupKey: string): HttpRequestSpec => ({
	url: EVENTS_URL,
	headers: { "content-type": "application/json" },
	guarded: false,
	sensitivePath: false,
	body: encodeJson({ routing_key: integrationKey, event_action: "resolve", dedup_key: dedupKey }),
})

/**
 * PagerDuty Events API v2. The body is machine-facing, so `custom_details`
 * carries raw numbers rather than the formatted strings the chat providers
 * render, and a custom template contributes only the summary line and a
 * `message` detail — the envelope itself is fixed by the API.
 */
export const pagerDutyTransport: HttpTransport<Config> = {
	kind: "http",
	type: "pagerduty",
	peerService: "pagerduty",
	providerLabel: "PagerDuty",
	render: (input: RenderInput<Config>) => {
		const { context, templated, linkUrl, chatUrl } = input
		return {
			// Fixed vendor host: nothing user-supplied to guard against, and the
			// path carries no credential (the routing key rides in the body).
			url: EVENTS_URL,
			headers: { "content-type": "application/json" },
			guarded: false,
			sensitivePath: false,
			body: encodeJson({
				routing_key: input.config.integrationKey,
				event_action: context.eventType === "resolve" ? "resolve" : "trigger",
				// A resolve closes the warning-keyed alert here and the critical one
				// in `followUps`.
				dedup_key: primaryDedupKey(context),
				payload: {
					summary: truncate(
						templated?.title ??
							(context.signalType === "uptime"
								? `${formatAlertHeadline(context)}: ${uptimeSummaryLine(context)}`
								: `${context.ruleName} ${context.eventType}`),
						1024,
					),
					source: displayGroupKey(context.groupKey) ?? "maple-alerts",
					// The tier the key was chosen for, so a stale critical event cannot raise the warning alert.
					severity: keySeverity(context) === "critical" ? "critical" : "warning",
					custom_details: {
						...(templated ? { message: templated.body } : undefined),
						ruleName: context.ruleName,
						signalType: context.signalType,
						value: context.value,
						...(context.detail == null ? undefined : { detail: context.detail }),
						threshold: context.threshold,
						thresholdUpper: context.thresholdUpper,
						comparator: context.comparator,
						groupKey: context.groupKey,
						linkUrl,
						chatUrl,
					},
				},
				links: [{ href: linkUrl, text: "Open in Maple" }],
			}),
		}
	},
	// The critical alert closes when the incident resolves or falls back to warning.
	followUps: (input) =>
		closesCriticalKey(input.context)
			? [resolveRequest(input.config.integrationKey, criticalDedupKey(input.context.dedupeKey))]
			: [],
	ack: (input) => ({
		providerMessage: "Delivered to PagerDuty",
		providerReference: pagingDedupKey(input.context, keySeverity(input.context)),
	}),
}

/**
 * A PagerDuty Events API v2 integration ("routing") key is exactly 32
 * alphanumeric characters. A REST API token — the usual wrong paste — is shorter
 * and may contain `+`/`_`/`-`, so the length+charset check alone rejects it.
 */
export const PAGERDUTY_ROUTING_KEY_PATTERN = /^[A-Za-z0-9]{32}$/

export type PagerDutyKeyVerification =
	| { status: "valid" }
	| { status: "invalid"; reason: string }
	/** Network error / timeout / 429 / 5xx — can't conclude; caller should fail open. */
	| { status: "unknown" }

/**
 * Verify a PagerDuty routing key actually works by enqueuing a no-op `resolve`
 * event. PagerDuty validates the routing key before the action, so a valid key
 * returns 2xx (resolving an unknown dedup_key creates no incident and pages no
 * one) and an invalid key returns 400 "Invalid routing key". Never fails — any
 * transport/ambiguous response collapses to `unknown` so the caller owns policy.
 *
 * This runs at destination-save time, not delivery time, so it deliberately does
 * not go through the transport runner: there is no notification to render and no
 * delivery span to attribute it to.
 */
export const verifyPagerDutyRoutingKey = (
	integrationKey: string,
	timeoutMs: number,
	dedupKey: string,
): Effect.Effect<PagerDutyKeyVerification, never, HttpClient.HttpClient> =>
	HttpClient.execute(
		HttpClientRequest.post("https://events.pagerduty.com/v2/enqueue").pipe(
			HttpClientRequest.bodyText(
				encodeJson({
					routing_key: integrationKey,
					event_action: "resolve",
					dedup_key: dedupKey,
				}),
				"application/json",
			),
		),
	).pipe(
		Effect.flatMap((response) => {
			if (response.status >= 200 && response.status < 300) {
				return Effect.succeed<PagerDutyKeyVerification>({ status: "valid" })
			}
			if (response.status === 400) {
				return Effect.orElseSucceed(response.text, () => "").pipe(
					Effect.map((body): PagerDutyKeyVerification => {
						const reason = truncate(Str.replace(/\s+/g, " ")(Str.trim(body)), 500)
						return { status: "invalid", reason: reason || "Invalid routing key" }
					}),
				)
			}
			return Effect.succeed<PagerDutyKeyVerification>({ status: "unknown" })
		}),
		// A timeout is one more way to not know, so it produces the verdict
		// directly rather than a placeholder failure for `orElseSucceed` to
		// swallow one line later. Wrapping the whole pipeline also bounds the
		// 400-body read, which the previous fetch-only timeout left open.
		Effect.timeoutOrElse({
			duration: Duration.millis(timeoutMs),
			orElse: () => Effect.succeed<PagerDutyKeyVerification>({ status: "unknown" }),
		}),
		Effect.orElseSucceed(() => ({ status: "unknown" as const })),
	)
