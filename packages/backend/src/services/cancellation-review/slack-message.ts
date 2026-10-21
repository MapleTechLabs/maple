/**
 * The cancellation report as a Slack message. Block Kit, built as plain data so
 * what a reader sees is asserted in a test rather than eyeballed in a channel.
 */
import type { CancellationReason, CancellationSnapshot } from "@maple/domain/http"
import type { IntegrationEntry } from "@maple/domain/integration-inventory"
import { type CancellationSignal, formatGB, totalGB } from "./signals"

/** What only the posting side knows about the org; never part of the snapshot. */
export interface CancellationReportSubject {
	readonly orgId: string
	readonly orgName: string
	/** Who signed the org up, when onboarding recorded it. */
	readonly contactEmail: string | null
	/** Epoch ms the plan's access ends, when Autumn said. */
	readonly expiresAt: number | null
	readonly links: {
		readonly clerk: string
		readonly autumn: string
		/** Null when Autumn has no Stripe customer for the org. */
		readonly stripe: string | null
	}
	/** Null when the integrations could not be read. */
	readonly integrations: ReadonlyArray<IntegrationEntry> | null
	/** Orgs the members also belong to; null when they could not be read. */
	readonly otherOrgs: ReadonlyArray<OtherOrg> | null
}

export interface OtherOrg {
	readonly orgId: string
	readonly name: string
	readonly createdAtMs: number
	readonly membersCount: number | null
	/** Emails of this org's members who are also in that one. */
	readonly sharedMembers: ReadonlyArray<string>
	readonly clerkUrl: string
}

export interface CancellationReport {
	readonly subject: CancellationReportSubject
	readonly snapshot: CancellationSnapshot
	readonly reason: CancellationReason
	readonly signals: ReadonlyArray<CancellationSignal>
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
			field(
				"Telemetry, last 30d",
				`${formatGB(totalGB(ingest.recent))} (${formatGB(totalGB(ingest.prior))} before)`,
			),
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
		fields.push(field("Set up", `${adoption.dashboards} dashboards, ${adoption.alertRules} alert rules`))
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

const linksLine = ({ links }: CancellationReportSubject): string =>
	[
		`<${links.clerk}|Clerk>`,
		...(links.stripe === null ? [] : [`<${links.stripe}|Stripe>`]),
		`<${links.autumn}|Autumn>`,
	].join("  ·  ")

/** Favicons, because Slack renders neither SVG nor its own app icons in a message. */
const iconOf = (domain: string) => `https://www.google.com/s2/favicons?domain=${domain}&sz=64`

const PROVIDER_LABELS = {
	github: { label: "GitHub", domain: "github.com" },
	cloudflare: { label: "Cloudflare", domain: "cloudflare.com" },
	railway: { label: "Railway", domain: "railway.com" },
	planetscale: { label: "PlanetScale", domain: "planetscale.com" },
	prometheus: { label: "Prometheus", domain: "prometheus.io" },
	slack: { label: "Slack", domain: "slack.com" },
	discord: { label: "Discord", domain: "discord.com" },
	hazel: { label: "Hazel", domain: null },
} satisfies Record<string, { readonly label: string; readonly domain: string | null }>

const providerOf = (key: string): { readonly label: string; readonly domain: string | null } =>
	key in PROVIDER_LABELS
		? PROVIDER_LABELS[key as keyof typeof PROVIDER_LABELS]
		: { label: key, domain: null }

const groupBy = <A>(items: ReadonlyArray<A>, key: (item: A) => string): Map<string, Array<A>> => {
	const groups = new Map<string, Array<A>>()
	for (const item of items) groups.set(key(item), [...(groups.get(key(item)) ?? []), item])
	return groups
}

const plural = (count: number, noun: string) =>
	`${count} ${count === 1 ? noun : noun.endsWith("y") ? `${noun.slice(0, -1)}ies` : `${noun}s`}`

/** One row per integration; chat splits into its connectors, which are different products. */
const integrationRows = (
	integrations: ReadonlyArray<IntegrationEntry>,
): ReadonlyArray<{ readonly key: string; readonly detail: string }> =>
	integrations.flatMap((integration) => {
		const status = integration.status === "healthy" ? "" : `  ·  ${integration.status}`
		if (integration.provider === "chat") {
			const byConnector = groupBy(integration.resources, (resource) => resource.note ?? "chat")
			return [...byConnector].map(([connector, workspaces]) => ({
				key: connector,
				detail: workspaces.map((workspace) => escape(workspace.name)).join(", "),
			}))
		}
		const kinds = groupBy(integration.resources, (resource) => resource.kind)
		const counts = [...kinds].map(([kind, resources]) => plural(resources.length, kind)).join(", ")
		return [
			{
				key: integration.provider,
				detail: [integration.account === null ? null : escape(integration.account), counts || null]
					.filter((part) => part !== null)
					.join("  ·  ")
					.concat(status),
			},
		]
	})

const integrationBlocks = (
	integrations: ReadonlyArray<IntegrationEntry> | null,
): ReadonlyArray<Record<string, unknown>> => {
	if (integrations === null) return []
	const heading = { type: "section", text: { type: "mrkdwn", text: "*Integrations*" } }
	if (integrations.length === 0) {
		return [heading, { type: "context", elements: [{ type: "mrkdwn", text: "None connected" }] }]
	}
	return [
		heading,
		...integrationRows(integrations).map(({ key, detail }) => {
			const provider = providerOf(key)
			const text = detail.length > 0 ? `*${provider.label}*  ${detail}` : `*${provider.label}*`
			return {
				type: "context",
				elements: [
					...(provider.domain === null
						? []
						: [{ type: "image", image_url: iconOf(provider.domain), alt_text: provider.label }]),
					{ type: "mrkdwn", text },
				],
			}
		}),
	]
}

const otherOrgsBlock = (otherOrgs: ReadonlyArray<OtherOrg> | null): Record<string, unknown> | null => {
	if (otherOrgs === null) return null
	const lines =
		otherOrgs.length === 0
			? ["None"]
			: otherOrgs.map((org) => {
					const parts = [
						`created ${day(org.createdAtMs)}`,
						...(org.membersCount === null ? [] : [plural(org.membersCount, "member")]),
						`via ${org.sharedMembers.map(escape).join(", ")}`,
					]
					return `• <${org.clerkUrl}|${escape(org.name)}> \`${org.orgId}\`  ${parts.join(", ")}`
				})
	return {
		type: "section",
		text: { type: "mrkdwn", text: `*Members' other orgs*\n${lines.join("\n")}` },
	}
}

/** `text` is the notification and screen-reader fallback; `blocks` is what the channel shows. */
export const buildCancellationMessage = (
	report: CancellationReport,
): { readonly text: string; readonly blocks: ReadonlyArray<Record<string, unknown>> } => {
	const { subject, snapshot, reason, signals } = report
	const title = `${snapshot.plan.phase === "ended" ? "Plan ended" : "Plan cancelled"}: ${subject.orgName}`

	const verdict = [field("Likely reason", REASON_LABELS[reason])]
	if (subject.contactEmail !== null) verdict.push(field("Contact", escape(subject.contactEmail)))

	const blocks: Array<Record<string, unknown>> = [
		{ type: "header", text: { type: "plain_text", text: title.slice(0, 150), emoji: true } },
		{ type: "context", elements: [{ type: "mrkdwn", text: planLine(report) }] },
		{ type: "context", elements: [{ type: "mrkdwn", text: linksLine(subject) }] },
		{ type: "section", fields: verdict },
	]
	if (signals.length > 0) {
		blocks.push({
			type: "section",
			text: {
				type: "mrkdwn",
				text: signals
					.map((signal) => `${TONE_EMOJI[signal.tone]}  ${escape(signal.text)}`)
					.join("\n"),
			},
		})
	}
	const usage = usageFields(snapshot)
	if (usage.length > 0) blocks.push({ type: "divider" }, { type: "section", fields: usage })
	blocks.push(...integrationBlocks(subject.integrations))
	const others = otherOrgsBlock(subject.otherOrgs)
	if (others !== null) blocks.push(others)

	const missing = unread(snapshot)
	if (missing.length > 0) {
		blocks.push({
			type: "context",
			elements: [{ type: "mrkdwn", text: `Could not read: ${missing.join(", ")}` }],
		})
	}

	// Unlike the header's plain text, the fallback is mrkdwn: an org name is escaped here.
	return { text: `${escape(title)} (${REASON_LABELS[reason]})`, blocks }
}
