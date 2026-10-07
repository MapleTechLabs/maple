/**
 * The cancellation report as a Slack message. Block Kit, built as plain data so
 * what a reader sees is asserted in a test rather than eyeballed in a channel.
 */
import type { CancellationAssessment, CancellationReason, CancellationSnapshot } from "@maple/domain/http"
import { type CancellationSignal, formatGB, totalGB } from "./signals"

/** What only the posting side knows about the org; never part of the snapshot. */
export interface CancellationReportSubject {
	readonly orgId: string
	readonly orgName: string
	/** Who signed the org up, when onboarding recorded it. */
	readonly contactEmail: string | null
	/** Epoch ms the plan's access ends, when Autumn said. */
	readonly expiresAt: number | null
}

export interface CancellationReport {
	readonly subject: CancellationReportSubject
	readonly snapshot: CancellationSnapshot
	readonly ruleReason: CancellationReason
	readonly signals: ReadonlyArray<CancellationSignal>
	/** Null when the decision model did not answer. */
	readonly assessment: CancellationAssessment | null
}

const REASON_LABELS = {
	never_activated: "Never got going",
	stopped_sending: "Stopped sending telemetry",
	not_engaged: "Nobody was using it",
	cost: "Cost",
	payment_failure: "Payment failed",
	unclear: "Not visible in usage",
} satisfies Record<CancellationReason, string>

const TONE_EMOJI = {
	concern: ":red_circle:",
	healthy: ":large_green_circle:",
	neutral: ":white_circle:",
} satisfies Record<CancellationSignal["tone"], string>

/** Slack reads `&`, `<` and `>` as markup; an org name is free text. */
const escape = (text: string): string =>
	text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")

const percent = (value: number): string => `${Math.round(value * 100)}%`

const day = (epochMs: number): string =>
	new Date(epochMs).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" })

const field = (label: string, value: string) => ({ type: "mrkdwn", text: `*${label}*\n${value}` })

const planLine = ({ subject, snapshot }: CancellationReport): string => {
	const { plan } = snapshot
	const parts = [`\`${plan.planId}\`${plan.trial ? " (trial)" : ""}`]
	if (plan.phase === "ended") {
		parts.push("access ended")
	} else if (subject.expiresAt !== null && plan.daysUntilEnd !== null) {
		parts.push(`access until ${day(subject.expiresAt)} (${plan.daysUntilEnd}d left)`)
	} else {
		parts.push("cancels at period end")
	}
	if (plan.tenureDays !== null) parts.push(`subscribed ${plan.tenureDays}d`)
	parts.push(`org \`${subject.orgId}\``)
	return parts.join("  ·  ")
}

const usageFields = (snapshot: CancellationSnapshot) => {
	const { org, ingest, visits, adoption, billing } = snapshot
	const fields: Array<ReturnType<typeof field>> = []
	if (ingest !== null) {
		fields.push(
			field("Telemetry, last 30d", `${formatGB(totalGB(ingest.recent))} (${formatGB(totalGB(ingest.prior))} before)`),
		)
	}
	if (visits !== null) {
		fields.push(
			field(
				"Days in the app, last 30d",
				`${visits.recent.activeDays} (${visits.prior.activeDays} before)`,
			),
		)
	}
	if (adoption !== null) {
		fields.push(
			field(
				"Set up",
				`${adoption.dashboards} dashboards, ${adoption.alertRules} alert rules, ${adoption.integrations} integrations`,
			),
		)
	}
	if (billing !== null && billing.lastInvoiceTotal !== null) {
		fields.push(
			field(
				"Last invoice",
				billing.previousInvoiceTotal === null
					? `$${billing.lastInvoiceTotal}`
					: `$${billing.lastInvoiceTotal} ($${billing.previousInvoiceTotal} before)`,
			),
		)
	}
	if (org?.members != null) fields.push(field("Members", String(org.members)))
	return fields
}

const unread = (snapshot: CancellationSnapshot): ReadonlyArray<string> =>
	(
		[
			["org", snapshot.org],
			["telemetry", snapshot.ingest],
			["app visits", snapshot.visits],
			["setup", snapshot.adoption],
			["billing", snapshot.billing],
		] as const
	)
		.filter(([, section]) => section === null)
		.map(([name]) => name)

/** `text` is the notification and screen-reader fallback; `blocks` is what the channel shows. */
export const buildCancellationMessage = (
	report: CancellationReport,
): { readonly text: string; readonly blocks: ReadonlyArray<Record<string, unknown>> } => {
	const { subject, snapshot, ruleReason, signals, assessment } = report
	const title = `${snapshot.plan.phase === "ended" ? "Plan ended" : "Plan cancelled"}: ${subject.orgName}`

	const verdict = [field("Likely reason", REASON_LABELS[ruleReason])]
	if (assessment !== null) {
		verdict.push(
			field(
				"Model read",
				`${REASON_LABELS[assessment.reason]} (${percent(assessment.reasonConfidence)})${
					assessment.reason === ruleReason ? "" : " :warning: differs"
				}`,
			),
			field("Win-back odds", percent(assessment.winBack)),
		)
	}
	if (subject.contactEmail !== null) verdict.push(field("Contact", escape(subject.contactEmail)))

	const blocks: Array<Record<string, unknown>> = [
		{ type: "header", text: { type: "plain_text", text: title.slice(0, 150), emoji: true } },
		{ type: "context", elements: [{ type: "mrkdwn", text: planLine(report) }] },
		{ type: "section", fields: verdict },
	]
	if (signals.length > 0) {
		blocks.push({
			type: "section",
			text: {
				type: "mrkdwn",
				text: signals.map((signal) => `${TONE_EMOJI[signal.tone]}  ${escape(signal.text)}`).join("\n"),
			},
		})
	}
	const usage = usageFields(snapshot)
	if (usage.length > 0) blocks.push({ type: "divider" }, { type: "section", fields: usage })

	const footer = [
		...(unread(snapshot).length > 0 ? [`Could not read: ${unread(snapshot).join(", ")}`] : []),
		assessment === null ? "No model read" : `Model: ${assessment.model}`,
	]
	blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: footer.join("  ·  ") }] })

	// Unlike the header's plain text, the fallback is mrkdwn: an org name is escaped here.
	return { text: `${escape(title)} (${REASON_LABELS[ruleReason]})`, blocks }
}
