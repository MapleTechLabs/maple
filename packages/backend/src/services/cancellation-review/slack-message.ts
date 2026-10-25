/**
 * The cancellation report as a Slack message. Block Kit, built as plain data so
 * what a reader sees is asserted in a test rather than eyeballed in a channel.
 */
import type { CancellationReason, CancellationSnapshot } from "@maple/domain/http"
import type { IntegrationEntry } from "@maple/domain/integration-inventory"
import { type CancellationSignal, dollars, formatGB, totalGB } from "./signals"

/** Where a person looks the org up. */
export interface OrgLinks {
	readonly clerk: string
	readonly autumn: string
	/** Null when Autumn has no Stripe customer for the org, or could not be read. */
	readonly stripe: string | null
}

/** What only the posting side knows about the org; never part of the snapshot. */
export interface CancellationReportSubject {
	readonly orgId: string
	readonly orgName: string
	/** Who signed the org up, when onboarding recorded it. */
	readonly contactEmail: string | null
	/** Epoch ms the plan's access ends, when Autumn said. */
	readonly expiresAt: number | null
	readonly links: OrgLinks
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
	readonly links: OrgLinks
	/** The org's active plan, `plan: null` for none; null when Autumn could not be read. */
	readonly billing: { readonly plan: string | null } | null
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

/** Neutral gets no mark: a column of white circles drowns out the red and green ones. */
const TONE_MARK = {
	concern: ":red_circle: ",
	healthy: ":large_green_circle: ",
	neutral: "",
} satisfies Record<CancellationSignal["tone"], string>

/** Slack reads `&`, `<` and `>` as markup; an org name is free text. */
const escape = (text: string): string =>
	text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")

const day = (epochMs: number): string =>
	new Date(epochMs).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" })

const plural = (count: number, noun: string) =>
	`${count} ${
		count === 1 || noun.endsWith("s")
			? noun
			: /[^aeiou]y$/.test(noun)
				? `${noun.slice(0, -1)}ies`
				: `${noun}s`
	}`

const SEPARATOR = "  ·  "

const title = ({ subject, snapshot }: CancellationReport): string =>
	`${subject.orgName} ${snapshot.plan.phase === "ended" ? "ended" : "cancelled"} the ${snapshot.plan.planId} ${
		snapshot.plan.trial ? "trial" : "plan"
	}`

const planContext = ({ subject, snapshot }: CancellationReport): string => {
	const { plan } = snapshot
	const parts: Array<string> = []
	if (plan.phase === "ended") {
		parts.push(subject.expiresAt === null ? "Access ended" : `Access ended ${day(subject.expiresAt)}`)
	} else if (subject.expiresAt !== null && plan.daysUntilEnd !== null) {
		parts.push(`Access until ${day(subject.expiresAt)} (${plan.daysUntilEnd}d left)`)
	} else {
		parts.push("Cancels at period end")
	}
	if (plan.tenureDays !== null) parts.push(`subscribed ${plural(plan.tenureDays, "day")}`)
	if (subject.contactEmail !== null) parts.push(`contact ${escape(subject.contactEmail)}`)
	parts.push(`\`${subject.orgId}\``)
	return parts.join(SEPARATOR)
}

const linkButtons = (links: OrgLinks) => ({
	type: "actions",
	elements: (
		[
			["Clerk", links.clerk],
			["Stripe", links.stripe],
			["Autumn", links.autumn],
		] as const
	).flatMap(([label, url]) =>
		url === null
			? []
			: [
					{
						type: "button",
						text: { type: "plain_text", text: label },
						url,
						action_id: `open_${label.toLowerCase()}`,
					},
				],
	),
})

const linksText = (links: OrgLinks): string =>
	[
		`<${links.clerk}|Clerk>`,
		...(links.stripe === null ? [] : [`<${links.stripe}|Stripe>`]),
		`<${links.autumn}|Autumn>`,
	].join(SEPARATOR)

interface Stat {
	readonly topic: CancellationSignal["topic"]
	readonly label: string
	readonly value: string
	readonly notes: ReadonlyArray<string>
}

const gb = (value: number) => (value === 0 ? "0 GB" : formatGB(value))

/** How this window compares with the one before, in the stat's own unit. */
const trend = (recent: number, prior: number, format: (value: number) => string): string =>
	recent === prior ? "same as the month before" : `${recent > prior ? "up" : "down"} from ${format(prior)}`

/** One number per section of the snapshot; the signal sentences only colour them. */
const stats = (snapshot: CancellationSnapshot): ReadonlyArray<Stat> => {
	const { org, ingest, visits, adoption, billing } = snapshot
	const out: Array<Stat> = []
	if (ingest !== null) {
		const recent = totalGB(ingest.recent)
		out.push({
			topic: "telemetry",
			label: "Telemetry, 30d",
			value: gb(recent),
			notes:
				ingest.daysSinceLastData === null
					? ["nothing in the last year"]
					: [
							trend(recent, totalGB(ingest.prior), gb),
							...(ingest.daysSinceLastData >= 2
								? [`last data ${ingest.daysSinceLastData} days ago`]
								: []),
						],
		})
	}
	if (visits !== null) {
		const { recent, prior, daysSinceLastVisit } = visits
		out.push({
			topic: "visits",
			label: "In the app, 30d",
			value: plural(recent.activeDays, "day"),
			notes: [
				trend(recent.activeDays, prior.activeDays, String),
				...(recent.peakDailyUsers > 0
					? [
							`peak ${recent.peakDailyUsers} ${recent.peakDailyUsers === 1 ? "person" : "people"} a day`,
						]
					: []),
				...(daysSinceLastVisit === null
					? ["no visit in 60 days"]
					: daysSinceLastVisit >= 2
						? [`last visit ${daysSinceLastVisit} days ago`]
						: []),
			],
		})
	}
	if (org?.members != null) {
		out.push({
			topic: "members",
			label: "Members",
			value: String(org.members),
			notes: [
				...(org.members === 1 ? ["single-member org"] : []),
				...(org.supportChannel ? ["shared support channel"] : []),
			],
		})
	}
	if (billing !== null) {
		const { lastInvoiceTotal: last, previousInvoiceTotal: previous } = billing
		out.push({
			topic: "billing",
			label: "Last invoice",
			value: last === null ? "None yet" : dollars(last),
			notes: [
				...(last === null
					? []
					: previous === null
						? ["first invoice"]
						: previous === 0 && last > 0
							? ["first paid, $0 before"]
							: [trend(last, previous, dollars)]),
				...(billing.overAllowance.length > 0
					? [`over allowance on ${billing.overAllowance.map(escape).join(", ")}`]
					: []),
			],
		})
	}
	if (adoption !== null) {
		out.push({
			topic: "setup",
			label: "Set up",
			value: plural(adoption.dashboards, "dashboard"),
			notes: [plural(adoption.alertRules, "alert rule")],
		})
	}
	return out
}

/** The worst tone among a topic's sentences: one red line outweighs any green. */
const toneOf = (
	signals: ReadonlyArray<CancellationSignal>,
	topic: CancellationSignal["topic"],
): CancellationSignal["tone"] => {
	const tones = signals.filter((signal) => signal.topic === topic).map((signal) => signal.tone)
	return tones.includes("concern") ? "concern" : tones.includes("healthy") ? "healthy" : "neutral"
}

const statField = (stat: Stat, tone: CancellationSignal["tone"]) => ({
	type: "mrkdwn",
	text: [
		`${TONE_MARK[tone]}${stat.label}`,
		`*${stat.value}*`,
		...(stat.notes.length > 0 ? [stat.notes.join(" · ")] : []),
	].join("\n"),
})

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

const context = (text: string) => ({ type: "context", elements: [{ type: "mrkdwn", text }] })
const heading = (text: string) => ({ type: "section", text: { type: "mrkdwn", text: `*${text}*` } })

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

/** Cloudflare's resources are one row per zone and dataset; the datasets read better as a count. */
const CLOUDFLARE_NAMED_KINDS = new Set(["zone", "workers", "logpush", "hyperdrive"])

const STATUS_MARK = {
	disconnected: ":red_circle: ",
	failing: ":red_circle: ",
	stale: ":large_yellow_circle: ",
	paused: "",
	pending: "",
	healthy: "",
} satisfies Record<IntegrationEntry["status"], string>

const resourceCounts = (integration: IntegrationEntry): string => {
	const kinds = groupBy(integration.resources, (resource) => resource.kind)
	const datasets = [...kinds.keys()].filter(
		(kind) => integration.provider === "cloudflare" && !CLOUDFLARE_NAMED_KINDS.has(kind),
	)
	return [
		...[...kinds]
			.filter(([kind]) => !datasets.includes(kind))
			.map(([kind, resources]) => plural(resources.length, kind.replaceAll("_", " "))),
		...(datasets.length > 0 ? [plural(datasets.length, "dataset")] : []),
	].join(SEPARATOR)
}

/** One row per integration; chat splits into its connectors, which are different products. */
const integrationRows = (
	integrations: ReadonlyArray<IntegrationEntry>,
): ReadonlyArray<{ readonly key: string; readonly detail: string }> =>
	integrations.flatMap((integration) => {
		if (integration.provider === "chat") {
			const byConnector = groupBy(integration.resources, (resource) => resource.note ?? "chat")
			return [...byConnector].map(([connector, workspaces]) => ({
				key: connector,
				detail: workspaces.map((workspace) => escape(workspace.name)).join(", "),
			}))
		}
		const status =
			integration.status === "healthy"
				? null
				: `${STATUS_MARK[integration.status]}${integration.status}`
		return [
			{
				key: integration.provider,
				detail: [
					integration.account === null ? null : escape(integration.account),
					resourceCounts(integration) || null,
					status,
				]
					.filter((part) => part !== null)
					.join(SEPARATOR),
			},
		]
	})

const integrationBlocks = (
	integrations: ReadonlyArray<IntegrationEntry> | null,
): ReadonlyArray<Record<string, unknown>> => {
	if (integrations === null) return []
	if (integrations.length === 0) return [heading("Integrations"), context("None connected")]
	return [
		heading("Integrations"),
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

/** Two blocks each; Slack refuses a message past 50 blocks. */
export const OTHER_ORGS_SHOWN = 8

/** Always shown: "none" is the answer that says the customer is not just moving orgs. */
const otherOrgsBlocks = (
	otherOrgs: ReadonlyArray<OtherOrg> | null,
): ReadonlyArray<Record<string, unknown>> => {
	if (otherOrgs === null)
		return [heading("Members' other orgs"), context("Could not check: the Clerk lookup failed")]
	if (otherOrgs.length === 0) {
		return [heading("Members' other orgs"), context("None. Every member belongs only to this org.")]
	}
	const hidden = otherOrgs.length - OTHER_ORGS_SHOWN
	return [
		heading("Members' other orgs"),
		...otherOrgs.slice(0, OTHER_ORGS_SHOWN).flatMap((org) => {
			const facts = [
				`Created ${day(org.createdAtMs)}`,
				...(org.membersCount === null ? [] : [plural(org.membersCount, "member")]),
				...(org.billing === null
					? []
					: [org.billing.plan === null ? "no plan" : `\`${org.billing.plan}\``]),
				`via ${org.sharedMembers.map(escape).join(", ")}`,
				linksText(org.links),
			]
			return [
				{
					type: "section",
					text: { type: "mrkdwn", text: `*${escape(org.name)}*  \`${org.orgId}\`` },
				},
				context(facts.join(SEPARATOR)),
			]
		}),
		...(hidden > 0 ? [context(`And ${hidden} older ${hidden === 1 ? "org" : "orgs"}`)] : []),
	]
}

/** `text` is the notification and screen-reader fallback; `blocks` is what the channel shows. */
export const buildCancellationMessage = (
	report: CancellationReport,
): { readonly text: string; readonly blocks: ReadonlyArray<Record<string, unknown>> } => {
	const { subject, snapshot, reason, signals } = report
	const shown = stats(snapshot)
	// Sentences about a section with no stat (the plan itself) have nowhere to fold into.
	const flags = signals.filter((signal) => !shown.some((stat) => stat.topic === signal.topic))

	const blocks: Array<Record<string, unknown>> = [
		{ type: "header", text: { type: "plain_text", text: title(report).slice(0, 150), emoji: true } },
		context(planContext(report)),
		linkButtons(subject.links),
		{ type: "section", text: { type: "mrkdwn", text: `*Likely reason:* ${REASON_LABELS[reason]}` } },
	]
	if (flags.length > 0) {
		blocks.push(
			context(flags.map((signal) => `${TONE_MARK[signal.tone]}${escape(signal.text)}`).join(SEPARATOR)),
		)
	}
	if (shown.length > 0) {
		blocks.push({
			type: "section",
			fields: shown.map((stat) => statField(stat, toneOf(signals, stat.topic))),
		})
	}
	const integrations = integrationBlocks(subject.integrations)
	if (integrations.length > 0) blocks.push({ type: "divider" }, ...integrations)
	blocks.push({ type: "divider" }, ...otherOrgsBlocks(subject.otherOrgs))

	const missing = unread(snapshot)
	if (missing.length > 0) blocks.push(context(`Could not read: ${missing.join(", ")}`))

	// Unlike the header's plain text, the fallback is mrkdwn: an org name is escaped here.
	return { text: `${escape(title(report))} (${REASON_LABELS[reason]})`, blocks }
}
