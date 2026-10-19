import type {
	AlertComparator,
	AlertDeliveryEventDocument,
	AlertDestinationType,
	AlertIncidentDocument,
	AlertIncidentHoldReason,
	AlertSignalType,
	InvestigationId,
} from "@maple/domain/http"
import type { V2Investigation } from "@maple/domain/http/v2"
import type { Tone } from "@maple/ui/lib/tone"
import { UNGROUPED_GROUP_KEY } from "@maple/domain/http"
import { formatAlertDuration, formatSignalValue, signalLabels } from "./form-utils"

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
		detail: parts.filter((part) => part != null).join(" · "),
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
	investigation: V2Investigation | null
	renotifyIntervalMinutes: number | null
	destinationTypeLabel: (type: AlertDestinationType) => string
}): ReadonlyArray<IncidentTimelineEntry> {
	const { incident } = input
	const group = incidentGroup(incident)
	const condition = `${signalTitle(incident.signalType)} ${conditionPhrase(incident)}`

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
			input.renotifyIntervalMinutes != null
				? `reminders every ${input.renotifyIntervalMinutes}m while open`
				: null
		events.push({
			key: "breaching",
			at: Date.parse(incident.lastTriggeredAt),
			tone: "crit",
			pending: true,
			title: "Still breaching",
			detail: [
				`Last value ${formatSignalValue(incident.signalType, incident.lastObservedValue)}`,
				reminder,
			]
				.filter((part) => part != null)
				.join(" · "),
			investigation: null,
		})
	}

	// Stable sort keeps the insertion order (opened first) for identical stamps.
	return events.filter((entry) => Number.isFinite(entry.at)).toSorted((a, b) => a.at - b.at)
}
