import type {
	AlertComparator,
	AlertDeliveryEventDocument,
	AlertIncidentAckSource,
	AlertDestinationType,
	AlertIncidentDocument,
	AlertIncidentHoldReason,
	AlertSignalType,
	InvestigationId,
} from "@maple/domain/http"
import type { V2AlertIncidentEvent, V2Investigation } from "@maple/domain/http/v2"
import type { Tone } from "@maple/ui/lib/tone"
import { UNGROUPED_GROUP_KEY } from "@maple/domain/http"
import { formatAlertDuration, formatSignalValue, signalLabels } from "./form-utils"
import { Array as Arr, Order } from "effect"

export interface IncidentTimelineEntry {
	readonly key: string
	/** Epoch ms. */
	readonly at: number
	readonly tone: Tone
	/** A state that is still in effect rather than an event that happened. */
	readonly pending: boolean
	readonly title: string
	readonly detail: string | null
	readonly investigation: { readonly id: InvestigationId; readonly headline: string | null } | null
}

export const holdReasonLabel: Record<AlertIncidentHoldReason, string> = {
	no_data: "The service stopped reporting. Resolves when telemetry returns or after six hours.",
	volume_collapsed: "Traffic dropped well below its usual level. Resolves when data returns.",
	sampling_changed: "Sampling changed while the breach cleared. Resolves when the signal settles.",
	probe_failed: "Maple could not verify telemetry. Resolves on the next successful check.",
} satisfies Record<AlertIncidentHoldReason, string>

const ackSourceLabel: Record<AlertIncidentAckSource, string> = {
	web: "the dashboard",
	api: "the API",
	mcp: "MCP",
	slack: "Slack",
	discord: "Discord",
} satisfies Record<AlertIncidentAckSource, string>

/** "Dana Kim", or who it was when the source named nobody: an MCP agent or a teammate. */
export function ackActorLabel(name: string | null, source: AlertIncidentAckSource | null): string {
	if (name != null) return name
	return source === "mcp" ? "an agent over MCP" : "a teammate"
}

/** "Acknowledged by Dana Kim", or null when nobody has acknowledged the incident. */
export function acknowledgedLine(
	incident: Pick<AlertIncidentDocument, "acknowledgedAt" | "acknowledgedByName" | "acknowledgedVia">,
): string | null {
	return incident.acknowledgedAt == null
		? null
		: `Acknowledged by ${ackActorLabel(incident.acknowledgedByName, incident.acknowledgedVia)}`
}

function activityEntry(event: V2AlertIncidentEvent): IncidentTimelineEntry {
	const who = ackActorLabel(event.actor?.name ?? null, event.source)
	const from = event.source != null ? `From ${ackSourceLabel[event.source]}` : null
	const base = {
		key: `activity:${event.id}`,
		at: Date.parse(event.created_at),
		pending: false,
		investigation: null,
	}
	switch (event.type) {
		case "acknowledged":
			return {
				...base,
				tone: "info",
				title: `Acknowledged by ${who}`,
				detail: Arr.join(
					Arr.filter([from, "reminders paused"], (p) => p != null),
					" · ",
				),
			}
		case "unacknowledged":
			return {
				...base,
				tone: "neutral",
				title: `Unacknowledged by ${who}`,
				detail: Arr.join(
					Arr.filter([from, "reminders resume"], (p) => p != null),
					" · ",
				),
			}
		case "ack_cleared":
			return {
				...base,
				tone: "warn",
				title: "Acknowledgement cleared",
				detail: "The incident escalated, so it notified again",
			}
		case "paged": {
			const page = event.page
			const channel =
				page === undefined ? "" : page.channel === "email" ? " by email" : ` by ${page.channel} DM`
			return {
				...base,
				tone: page?.status === "failed" ? "warn" : "info",
				title: `Paged ${page?.name ?? page?.user_id ?? "a member"}${channel}`,
				detail: page === undefined || page.status === "sent" ? null : page.status,
			}
		}
	}
}

const comparatorWords: Record<AlertComparator, string> = {
	gt: "above",
	gte: "at or above",
	lt: "below",
	lte: "at or below",
	eq: "equal to",
	neq: "not equal to",
	between: "between",
	not_between: "outside",
} satisfies Record<AlertComparator, string>

/** "above 5%", "between 200ms and 400ms". */
export function conditionPhrase(input: {
	signalType: AlertSignalType
	comparator: AlertComparator
	threshold: number
	thresholdUpper: number | null
}): string {
	const value = (n: number) => formatSignalValue(input.signalType, n)
	const words = comparatorWords[input.comparator]
	return input.thresholdUpper != null
		? `${words} ${value(input.threshold)} and ${value(input.thresholdUpper)}`
		: `${words} ${value(input.threshold)}`
}

/** The incident's group, or null for an ungrouped rule. */
export function incidentGroup(incident: Pick<AlertIncidentDocument, "groupKey">): string | null {
	return incident.groupKey == null || incident.groupKey === UNGROUPED_GROUP_KEY ? null : incident.groupKey
}

export function signalTitle(signalType: AlertSignalType): string {
	return signalType === "builder_query" || signalType === "raw_query"
		? "Query value"
		: signalLabels[signalType]
}

function deliveryEntry(
	event: AlertDeliveryEventDocument,
	typeLabel: (type: AlertDestinationType) => string,
): IncidentTimelineEntry | null {
	if (event.eventType === "test") return null
	const name = event.destinationName
	const failed = event.status === "failed"
	const sending = event.status === "queued" || event.status === "processing"
	const title = sending
		? `Sending to ${name}`
		: event.eventType === "resolve"
			? failed
				? `All-clear to ${name} failed`
				: `Sent all-clear to ${name}`
			: event.eventType === "renotify"
				? failed
					? `Reminder to ${name} failed`
					: `Reminded ${name}`
				: failed
					? `Could not notify ${name}`
					: `Notified ${name}`
	const reason = failed
		? (event.errorMessage ?? (event.responseCode != null ? `HTTP ${event.responseCode}` : null))
		: null
	const parts = [
		typeLabel(event.destinationType),
		reason,
		event.attemptNumber > 1 ? `attempt ${event.attemptNumber}` : null,
	]
	return {
		key: `delivery:${event.id}`,
		at: Date.parse(event.attemptedAt ?? event.scheduledAt),
		tone: failed ? "crit" : sending ? "neutral" : event.eventType === "resolve" ? "ok" : "info",
		pending: sending,
		title,
		detail: Arr.join(
			Arr.filter(parts, (part) => part != null),
			" · ",
		),
		investigation: null,
	}
}

function investigationEntries(investigation: V2Investigation): ReadonlyArray<IncidentTimelineEntry> {
	const started: IncidentTimelineEntry = {
		key: `investigation:${investigation.id}:started`,
		at: Date.parse(investigation.created_at),
		tone: "neutral",
		pending: investigation.status === "investigating",
		title:
			investigation.seeded_by === "system"
				? "Investigation started automatically"
				: "Investigation started",
		detail: investigation.status === "investigating" ? "Still running" : null,
		investigation:
			investigation.status === "investigating" ? { id: investigation.id, headline: null } : null,
	}
	if (investigation.status === "failed") {
		return [
			started,
			{
				key: `investigation:${investigation.id}:failed`,
				at: Date.parse(investigation.updated_at),
				tone: "crit",
				pending: false,
				title: "Investigation failed",
				detail: investigation.error,
				investigation: { id: investigation.id, headline: null },
			},
		]
	}
	if (investigation.diagnosed_at == null || investigation.report == null) return [started]
	return [
		started,
		{
			key: `investigation:${investigation.id}:diagnosed`,
			at: Date.parse(investigation.diagnosed_at),
			tone: "warn",
			pending: false,
			title: "Investigation finished",
			detail: investigation.confidence != null ? `${investigation.confidence} confidence` : null,
			investigation: {
				id: investigation.id,
				headline: investigation.report.headline ?? investigation.report.summary,
			},
		},
	]
}

/**
 * One chronological story of an incident from the rows that exist today: the
 * incident's own lifecycle stamps, its delivery attempts and its investigation.
 */
export function buildIncidentTimeline(input: {
	incident: AlertIncidentDocument
	deliveries: ReadonlyArray<AlertDeliveryEventDocument>
	/** Acknowledgement history, oldest first. */
	activity: ReadonlyArray<V2AlertIncidentEvent>
	investigation: V2Investigation | null
	renotifyIntervalMinutes: number | null
	destinationTypeLabel: (type: AlertDestinationType) => string
}): ReadonlyArray<IncidentTimelineEntry> {
	const { incident } = input
	const group = incidentGroup(incident)
	// An uptime rule has no threshold to read out; an SLO's reads its tier factor, not today's burn.
	const condition =
		incident.signalType === "uptime"
			? `${incident.ruleName} went down`
			: incident.signalType === "slo_burn_rate"
				? `SLO burning its error budget at ${formatSignalValue(incident.signalType, incident.threshold)} or more`
				: `${signalTitle(incident.signalType)} ${conditionPhrase(incident)}`

	const opened: IncidentTimelineEntry = {
		key: "opened",
		at: Date.parse(incident.firstTriggeredAt),
		tone: incident.severity === "critical" ? "crit" : "warn",
		pending: false,
		title: "Incident opened",
		detail: group != null ? `${condition} on ${group}` : condition,
		investigation: null,
	}

	const events: Array<IncidentTimelineEntry> = [opened]
	for (const delivery of input.deliveries) {
		const entry = deliveryEntry(delivery, input.destinationTypeLabel)
		if (entry != null) events.push(entry)
	}
	for (const event of input.activity) events.push(activityEntry(event))
	if (input.investigation != null) events.push(...investigationEntries(input.investigation))

	if (incident.status === "resolved" && incident.resolvedAt != null) {
		events.push({
			key: "resolved",
			at: Date.parse(incident.resolvedAt),
			tone: "ok",
			pending: false,
			title: "Resolved",
			detail: `After ${formatAlertDuration(incident.firstTriggeredAt, incident.resolvedAt)}`,
			investigation: null,
		})
	} else if (incident.holdReason != null && incident.heldSince != null) {
		events.push({
			key: "held",
			at: Date.parse(incident.heldSince),
			tone: "neutral",
			pending: true,
			title: "Waiting on data",
			detail: holdReasonLabel[incident.holdReason],
			investigation: null,
		})
	} else if (incident.status === "open") {
		const reminder =
			incident.acknowledgedAt != null
				? "reminders paused while acknowledged"
				: input.renotifyIntervalMinutes != null
					? `reminders every ${input.renotifyIntervalMinutes}m while open`
					: null
		events.push({
			key: "breaching",
			at: Date.parse(incident.lastTriggeredAt),
			tone: "crit",
			pending: true,
			title: "Still breaching",
			detail: Arr.join(
				Arr.filter(
					[
						`Last value ${formatSignalValue(incident.signalType, incident.lastObservedValue)}`,
						reminder,
					],
					(part) => part != null,
				),
				" · ",
			),
			investigation: null,
		})
	}

	// Stable sort keeps the insertion order (opened first) for identical stamps. The state still in
	// effect ends the story even when an ack came after its stamp (a hold's start, the last check).
	const isCurrent = (entry: IncidentTimelineEntry) => CURRENT_STATE_KEYS.has(entry.key)
	return [
		...Arr.sort(
			Arr.filter(events, (entry) => !isCurrent(entry) && Number.isFinite(entry.at)),
			Order.mapInput(Order.Number, (entry: { readonly at: number }) => entry.at),
		),
		...Arr.filter(events, isCurrent),
	]
}

const CURRENT_STATE_KEYS: ReadonlySet<string> = new Set(["held", "breaching"])
