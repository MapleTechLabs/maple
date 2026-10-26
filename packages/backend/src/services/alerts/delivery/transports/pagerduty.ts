import { Duration, Effect } from "effect"
import { HttpClient, HttpClientRequest } from "effect/http"
import type { AlertSeverity } from "@maple/domain/http"
import { displayGroupKey, formatAlertHeadline, truncate, uptimeSummaryLine } from "../../alert-formatting"
import type { DispatchContext } from "../context"
import type { HttpRequestSpec, HttpTransport, RenderInput, SecretConfigOf } from "../Transport"

type Config = SecretConfigOf<"pagerduty">

const EVENTS_URL = "https://events.pagerduty.com/v2/enqueue"

/**
 * A rule with both a warning and a critical tier pages critical under its own
 * dedup key: re-triggering the warning alert's key would only update that alert,
 * and an acknowledged alert does not page again, so an escalation could go
 * unheard. Every other rule keeps the incident's single key, which is what its
 * already-open alerts were raised under.
 */
const criticalHasOwnKey = (context: Pick<DispatchContext, "ruleSeverities">): boolean =>
	context.ruleSeverities !== undefined &&
	context.ruleSeverities.includes("warning") &&
	context.ruleSeverities.includes("critical")

const criticalDedupKey = (dedupeKey: string): string => `${dedupeKey}:critical`

/**
 * The tier a delivery's key is chosen from: the queued event's, unless the
 * incident has since fallen below it. A critical trigger retried after a
 * de-escalation must not re-open (and re-page) the alert it closed.
 */
const keySeverity = (context: Pick<DispatchContext, "severity" | "incidentSeverity">): AlertSeverity =>
	context.severity === "critical" && context.incidentSeverity === "warning" ? "warning" : context.severity

export const pagerDutyDedupKey = (
	context: Pick<DispatchContext, "dedupeKey" | "ruleSeverities">,
	severity: AlertSeverity,
): string =>
	severity === "critical" && criticalHasOwnKey(context)
		? criticalDedupKey(context.dedupeKey)
		: context.dedupeKey

const resolveRequest = (integrationKey: string, dedupKey: string): HttpRequestSpec => ({
	url: EVENTS_URL,
	headers: { "content-type": "application/json" },
	guarded: false,
	sensitivePath: false,
	body: JSON.stringify({ routing_key: integrationKey, event_action: "resolve", dedup_key: dedupKey }),
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
			body: JSON.stringify({
				routing_key: input.config.integrationKey,
				event_action: context.eventType === "resolve" ? "resolve" : "trigger",
				// A resolve closes the warning-keyed alert here and the critical one
				// in `followUps`.
				dedup_key: pagerDutyDedupKey(
					context,
					context.eventType === "resolve" ? "warning" : keySeverity(context),
				),
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
				links: [
					{ href: linkUrl, text: "Open in Maple" },
					{ href: chatUrl, text: "Ask Maple AI" },
				],
			}),
		}
	},
	// The critical alert closes when the incident resolves or falls back to
	// warning. The rule may have dropped its critical tier since the key was
	// minted, so an incident that peaked at critical closes it too. Resolving a
	// key PagerDuty has never seen is a no-op.
	followUps: (input) => {
		const { context } = input
		const mayHoldCriticalKey = criticalHasOwnKey(context) || context.incidentPeakSeverity === "critical"
		// Judged by where the incident is now, not by the queued event: a warning
		// reminder delivered after an escalation must leave the critical page open.
		const closesCritical =
			context.eventType === "resolve" ||
			(context.eventType !== "test" && (context.incidentSeverity ?? context.severity) === "warning")
		return mayHoldCriticalKey && closesCritical
			? [resolveRequest(input.config.integrationKey, criticalDedupKey(context.dedupeKey))]
			: []
	},
	ack: (input) => ({
		providerMessage: "Delivered to PagerDuty",
		providerReference: pagerDutyDedupKey(input.context, keySeverity(input.context)),
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
				JSON.stringify({
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
						const reason = truncate(body.trim().replace(/\s+/g, " "), 500)
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
