import { Array as Arr, Schema, String as Str } from "effect"
import { buildSummaryLine } from "../../AlertDeliveryDispatch"
import {
	displayGroup,
	formatAlertHeadline,
	formatEventTypeLabel,
	formatSeverityLabel,
	formatWindow,
	hasSignalHeadline,
	truncate,
} from "../../alert-formatting"
import type { DispatchContext } from "../context"
import { closesCriticalKey, criticalDedupKey, keySeverity, primaryDedupKey } from "../paging-dedup"
import type { HttpRequestSpec, HttpTransport, RenderInput, SecretConfigOf } from "../Transport"

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))

type Config = SecretConfigOf<"incident-io">

const eventsUrl = (alertSourceConfigId: string): string =>
	`https://api.incident.io/v2/alert_events/http/${encodeURIComponent(alertSourceConfigId)}`

const request = (config: Config, body: Record<string, unknown>): HttpRequestSpec => ({
	// Fixed vendor host; the path carries only the alert source id, which is not a credential.
	url: eventsUrl(config.alertSourceConfigId),
	headers: { "content-type": "application/json", authorization: `Bearer ${config.token}` },
	guarded: false,
	sensitivePath: false,
	body: encodeJson(body),
})

const resolveEvent = (title: string, dedupKey: string) => ({
	title,
	status: "resolved",
	deduplication_key: dedupKey,
})

const defaultTitle = (context: DispatchContext): string =>
	hasSignalHeadline(context.signalType)
		? formatAlertHeadline(context)
		: `${context.ruleName} ${Str.toLowerCase(formatEventTypeLabel(context.eventType))}`

const defaultDescription = (context: DispatchContext, linkUrl: string, chatUrl: string): string => {
	const group = displayGroup(context)
	return Arr.join(
		[
			buildSummaryLine(context, (value) => `**${value}**`),
			"",
			`**Severity:** ${formatSeverityLabel(context.severity)} · **Window:** ${formatWindow(context.windowMinutes)}${group == null ? "" : ` · **Group:** ${group}`}`,
			...(context.sparkline ? ["", context.sparkline] : []),
			"",
			`[Open in Maple](${linkUrl}) · [Ask Maple AI](${chatUrl})`,
		],
		"\n",
	)
}

/**
 * incident.io HTTP alert source (Alert Events V2). One alert per dedup key: a `firing` event opens
 * it and a `resolved` event with the same key closes it, so keys follow PagerDuty's: one per rule
 * and group, plus a separate critical key for a rule with two tiers (`paging-dedup`).
 * `metadata` carries raw fields so alert routes and attributes can match on them.
 */
export const incidentIoTransport: HttpTransport<Config> = {
	kind: "http",
	type: "incident-io",
	peerService: "incident-io",
	providerLabel: "incident.io",
	render: (input: RenderInput<Config>) => {
		const { context, templated, linkUrl, chatUrl } = input
		const severity = keySeverity(context)
		return request(input.config, {
			title: truncate(templated?.title ?? defaultTitle(context), 500),
			status: context.eventType === "resolve" ? "resolved" : "firing",
			deduplication_key: primaryDedupKey(context),
			description: truncate(templated?.body ?? defaultDescription(context, linkUrl, chatUrl), 10_000),
			source_url: linkUrl,
			metadata: {
				severity,
				event_type: context.eventType,
				rule_id: context.ruleId,
				rule_name: context.ruleName,
				signal_type: context.signalType,
				value: context.value,
				...(context.detail == null ? undefined : { detail: context.detail }),
				threshold: context.threshold,
				threshold_upper: context.thresholdUpper,
				comparator: context.comparator,
				group_key: context.groupKey,
				window_minutes: context.windowMinutes,
				incident_id: context.incidentId,
				maple_url: linkUrl,
				ask_maple_url: chatUrl,
			},
		})
	},
	followUps: (input) => {
		const { context, config } = input
		const title = truncate(input.templated?.title ?? defaultTitle(context), 500)
		// A test opens a real alert; close it straight away so it never lingers on the source.
		if (context.eventType === "test")
			return [request(config, resolveEvent(title, primaryDedupKey(context)))]
		return closesCriticalKey(context)
			? [request(config, resolveEvent(title, criticalDedupKey(context.dedupeKey)))]
			: []
	},
	describeStatus: (status) => {
		if (status === 401 || status === 403) {
			return "incident.io rejected the token. Copy it again from the HTTP alert source's setup page"
		}
		if (status === 404) {
			return "incident.io has no alert source with this ID. Check the alert source config ID"
		}
		if (status === 429) return "incident.io rate-limited this alert source (120 events per minute)"
		return null
	},
	ack: (input) => ({
		providerMessage: "Delivered to incident.io",
		providerReference: primaryDedupKey(input.context),
	}),
}
