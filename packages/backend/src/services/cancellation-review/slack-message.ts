/**
 * The cancellation report as a Slack message. Block Kit, built as plain data so
 * what a reader sees is asserted in a test rather than eyeballed in a channel.
 */
import type {
	CancellationCompanyGuess,
	CancellationModelRead,
	CancellationReason,
	CancellationSnapshot,
	CancellationStripeFeedback,
} from "@maple/domain/http"
import type { IntegrationEntry } from "@maple/domain/integration-inventory"
import { type CancellationSignal, dollars, formatGB, totalGB } from "./signals"
import { Array as Arr, Order, String as Str } from "effect"

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
	/** The org's browser sessions on Maple's own replays page; null when that org is not known. */
	readonly sessionsUrl: string | null
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
	/** The model's second read; null when it did not answer. */
	readonly modelRead: CancellationModelRead | null
	/** Null when Stripe could not be read. */
	readonly stripeFeedback: CancellationStripeFeedback | null
	/** Sources only the model reads that could not be read, by name. */
	readonly unreadEvidence: ReadonlyArray<string>
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
	Str.replaceAll(">", "&gt;")(Str.replaceAll("<", "&lt;")(Str.replaceAll("&", "&amp;")(text)))

const day = (epochMs: number): string =>
	new Date(epochMs).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" })

const plural = (count: number, noun: string) =>
	`${count} ${
		count === 1 || Str.endsWith("s")(noun)
			? noun
			: /[^aeiou]y$/.test(noun)
				? `${Str.slice(0, -1)(noun)}ies`
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
	return Arr.join(parts, SEPARATOR)
}

const linkButtons = (links: OrgLinks, sessionsUrl: string | null) => ({
	type: "actions",
	elements: Arr.flatMap(
		[
			["Clerk", links.clerk],
			["Stripe", links.stripe],
			["Autumn", links.autumn],
			["Sessions", sessionsUrl],
		] as const,
		([label, url]) =>
			url === null
				? []
				: [
						{
							type: "button",
							text: { type: "plain_text", text: label },
							url,
							action_id: `open_${Str.toLowerCase(label)}`,
						},
					],
	),
})

const linksText = (links: OrgLinks): string =>
	Arr.join(
		[
			`<${links.clerk}|Clerk>`,
			...(links.stripe === null ? [] : [`<${links.stripe}|Stripe>`]),
			`<${links.autumn}|Autumn>`,
		],
		SEPARATOR,
	)

interface Stat {
	readonly topic: CancellationSignal["topic"]
	readonly label: string
	/** The last 30 days, or the current value for stats with no window. */
	readonly now: string
	/** The same figure a month earlier; null where there is none to compare. */
	readonly before: string | null
	readonly notes: ReadonlyArray<string>
}

const gb = (value: number) => (value === 0 ? "0 GB" : formatGB(value))

/** One row per section of the snapshot; the signal sentences only colour them. */
const stats = (snapshot: CancellationSnapshot): ReadonlyArray<Stat> => {
	const { org, ingest, visits, adoption, billing } = snapshot
	const out: Array<Stat> = []
	if (ingest !== null) {
		out.push({
			topic: "telemetry",
			label: "Telemetry",
			now: gb(totalGB(ingest.recent)),
			before: ingest.daysSinceLastData === null ? null : gb(totalGB(ingest.prior)),
			notes:
				ingest.daysSinceLastData === null
					? ["nothing in the last year"]
					: ingest.daysSinceLastData >= 2
						? [`last data ${ingest.daysSinceLastData} days ago`]
						: [],
		})
	}
	if (visits !== null) {
		const { recent, prior, daysSinceLastVisit } = visits
		out.push({
			topic: "visits",
			label: "Days in the app",
			now: String(recent.activeDays),
			before: String(prior.activeDays),
			notes: [
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
			now: String(org.members),
			before: null,
			notes: org.supportChannel ? ["shared support channel"] : [],
		})
	}
	if (billing !== null) {
		const { lastInvoiceTotal: last, previousInvoiceTotal: previous } = billing
		out.push({
			topic: "billing",
			label: "Last invoice",
			now: last === null ? "None yet" : dollars(last),
			before: last === null || previous === null ? null : dollars(previous),
			notes: [
				...(last !== null && previous === null ? ["first invoice"] : []),
				...(billing.overAllowance.length > 0
					? [`over allowance on ${Arr.join(billing.overAllowance, ", ")}`]
					: []),
			],
		})
	}
	if (adoption !== null) {
		out.push({
			topic: "setup",
			label: "Dashboards / alerts",
			now: `${adoption.dashboards} / ${adoption.alertRules}`,
			before: null,
			notes: [],
		})
	}
	return out
}

/** The worst tone among a topic's sentences: one red line outweighs any green. */
const toneOf = (
	signals: ReadonlyArray<CancellationSignal>,
	topic: CancellationSignal["topic"],
): CancellationSignal["tone"] => {
	const tones = Arr.map(
		Arr.filter(signals, (signal) => signal.topic === topic),
		(signal) => signal.tone,
	)
	return tones.includes("concern") ? "concern" : tones.includes("healthy") ? "healthy" : "neutral"
}

const TONE_EMOJI = {
	concern: "red_circle",
	healthy: "large_green_circle",
	neutral: null,
} satisfies Record<CancellationSignal["tone"], string | null>

const TONE_ORDER = { concern: 0, healthy: 1, neutral: 2 } satisfies Record<CancellationSignal["tone"], number>

/** Table cells are rich text, not mrkdwn: nothing in them needs escaping. */
const cell = (elements: ReadonlyArray<Record<string, unknown>>): Record<string, unknown> => ({
	type: "rich_text",
	elements: [{ type: "rich_text_section", elements }],
})

const bold = (text: string) => cell([{ type: "text", text, style: { bold: true } }])

/** Worrying rows first, then healthy, then the ones with nothing to say. */
const statsTable = (shown: ReadonlyArray<Stat>, signals: ReadonlyArray<CancellationSignal>) => {
	const ranked = Arr.sort(
		Arr.map(shown, (stat) => ({ stat, tone: toneOf(signals, stat.topic) })),
		Order.mapInput(
			Order.Number,
			({ tone }: { readonly tone: CancellationSignal["tone"] }) => TONE_ORDER[tone],
		),
	)
	const rows = Arr.map(ranked, ({ stat, tone }) => {
		const emoji = TONE_EMOJI[tone]
		const before = [...(stat.before === null ? [] : [stat.before]), ...stat.notes]
		return [
			cell([
				...(emoji === null
					? []
					: [
							{ type: "emoji", name: emoji },
							{ type: "text", text: " " },
						]),
				{ type: "text", text: stat.label },
			]),
			bold(stat.now),
			{ type: "raw_text", text: before.length > 0 ? Arr.join(before, " · ") : "—" },
		]
	})
	return {
		type: "table",
		column_settings: [null, null, { is_wrapped: true }],
		rows: [[bold("Last 30 days"), bold("Now"), bold("Month before")], ...rows],
	}
}

const unread = (snapshot: CancellationSnapshot): ReadonlyArray<string> =>
	Arr.map(
		Arr.filter(
			[
				["org", snapshot.org],
				["telemetry", snapshot.ingest],
				["app visits", snapshot.visits],
				["setup", snapshot.adoption],
				["billing", snapshot.billing],
			] as const,
			([, section]) => section === null,
		),
		([name]) => name,
	)

const context = (text: string) => ({ type: "context", elements: [{ type: "mrkdwn", text }] })
/** Text the customer or the model wrote: shown as written, a URL in it never turned into a link. */
const quoted = (text: string) => ({ type: "context", elements: [{ type: "mrkdwn", text, verbatim: true }] })
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
	const datasets = Arr.filter(
		[...kinds.keys()],
		(kind) => integration.provider === "cloudflare" && !CLOUDFLARE_NAMED_KINDS.has(kind),
	)
	return Arr.join(
		[
			...Arr.map(
				Arr.filter([...kinds], ([kind]) => !datasets.includes(kind)),
				([kind, resources]) => plural(resources.length, Str.replaceAll("_", " ")(kind)),
			),
			...(datasets.length > 0 ? [plural(datasets.length, "dataset")] : []),
		],
		SEPARATOR,
	)
}

/** One row per integration; chat splits into its connectors, which are different products. */
const integrationRows = (
	integrations: ReadonlyArray<IntegrationEntry>,
): ReadonlyArray<{ readonly key: string; readonly detail: string }> =>
	Arr.flatMap(integrations, (integration) => {
		if (integration.provider === "chat") {
			const byConnector = groupBy(integration.resources, (resource) => resource.note ?? "chat")
			return Arr.map([...byConnector], ([connector, workspaces]) => ({
				key: connector,
				detail: Arr.join(
					Arr.map(workspaces, (workspace) => escape(workspace.name)),
					", ",
				),
			}))
		}
		const status =
			integration.status === "healthy"
				? null
				: `${STATUS_MARK[integration.status]}${integration.status}`
		return [
			{
				key: integration.provider,
				detail: Arr.join(
					Arr.filter(
						[
							integration.account === null ? null : escape(integration.account),
							resourceCounts(integration) || null,
							status,
						],
						(part) => part !== null,
					),
					SEPARATOR,
				),
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
		...Arr.map(integrationRows(integrations), ({ key, detail }) => {
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
		...Arr.flatMap(otherOrgs.slice(0, OTHER_ORGS_SHOWN), (org) => {
			const facts = [
				`Created ${day(org.createdAtMs)}`,
				...(org.membersCount === null ? [] : [plural(org.membersCount, "member")]),
				...(org.billing === null
					? []
					: [org.billing.plan === null ? "no plan" : `\`${org.billing.plan}\``]),
				`via ${Arr.join(Arr.map(org.sharedMembers, escape), ", ")}`,
				linksText(org.links),
			]
			return [
				{
					type: "section",
					text: { type: "mrkdwn", text: `*${escape(org.name)}*  \`${org.orgId}\`` },
				},
				context(Arr.join(facts, SEPARATOR)),
			]
		}),
		...(hidden > 0 ? [context(`And ${hidden} older ${hidden === 1 ? "org" : "orgs"}`)] : []),
	]
}

/** Slack refuses a text object past 3000 characters, which would lose the whole report. */
const MAX_FREE_TEXT = 500
const clip = (value: string): string =>
	value.length > MAX_FREE_TEXT ? `${Str.slice(0, MAX_FREE_TEXT - 1)(value)}…` : value

/** Stripe's survey answers are snake_case enum values (`too_expensive`); the comment is free text. */
const stripeFeedbackText = (feedback: CancellationStripeFeedback | null): string | null => {
	if (feedback === null || (feedback.feedback === null && feedback.comment === null)) return null
	return Arr.join(
		[
			"*Told Stripe:*",
			...(feedback.feedback === null ? [] : [Str.replaceAll("_", " ")(feedback.feedback)]),
			...(feedback.comment === null ? [] : [`“${escape(clip(feedback.comment))}”`]),
		],
		" ",
	)
}

/** The reason line: the model's when it overrode the rules, which then stay visible beside it. */
const reasonText = (reason: CancellationReason, modelRead: CancellationModelRead | null): string =>
	modelRead?.verdict === "override" && modelRead.reason !== null
		? `*Likely reason:* ${escape(clip(modelRead.reason))}  _(model's read; rules said: ${REASON_LABELS[reason]})_`
		: `*Likely reason:* ${REASON_LABELS[reason]}`

/** Who the model thinks the customer is: "Acme Robotics, Berlin, DE: what it does (medium: domain, homepage)". */
const companyText = (company: CancellationCompanyGuess): string =>
	Arr.join(
		[
			`:office: *${escape(clip(company.name))}*`,
			company.location === null ? "" : `, ${escape(clip(company.location))}`,
			company.oneLiner === null ? "" : `: ${escape(clip(company.oneLiner))}`,
			`  _(${company.confidence} confidence${company.basis === "" ? "" : `: ${escape(clip(company.basis))}`})_`,
		],
		"",
	)

/** The model's findings, stated as fact, then its opinion. */
const modelBlocks = (modelRead: CancellationModelRead | null): ReadonlyArray<Record<string, unknown>> => {
	if (modelRead === null) return []
	return [
		...(modelRead.findings.length === 0
			? []
			: [
					{
						type: "section",
						text: {
							type: "mrkdwn",
							text: Arr.join(
								[
									"*What stands out*",
									...Arr.map(modelRead.findings, (f) => `• ${escape(clip(f))}`),
								],
								"\n",
							),
							verbatim: true,
						},
					},
				]),
		...(modelRead.conclusion === ""
			? []
			: [quoted(`:robot_face: *Model's read:* ${escape(clip(modelRead.conclusion))}`)]),
	]
}

/** `text` is the notification and screen-reader fallback; `blocks` is what the channel shows. */
export const buildCancellationMessage = (
	report: CancellationReport,
): { readonly text: string; readonly blocks: ReadonlyArray<Record<string, unknown>> } => {
	const { subject, snapshot, reason, signals, modelRead } = report
	const shown = stats(snapshot)
	// Sentences about a section with no stat (the plan itself) have nowhere to fold into.
	const flags = Arr.filter(signals, (signal) => !Arr.some(shown, (stat) => stat.topic === signal.topic))

	const blocks: Array<Record<string, unknown>> = [
		{ type: "header", text: { type: "plain_text", text: Str.slice(0, 150)(title(report)), emoji: true } },
		context(planContext(report)),
		linkButtons(subject.links, subject.sessionsUrl),
		...(modelRead?.company == null ? [] : [quoted(companyText(modelRead.company))]),
		// Verbatim: an override's reason is the model's words.
		{ type: "section", text: { type: "mrkdwn", text: reasonText(reason, modelRead), verbatim: true } },
	]
	const told = stripeFeedbackText(report.stripeFeedback)
	if (told !== null) blocks.push(quoted(told))
	blocks.push(...modelBlocks(modelRead))
	if (flags.length > 0) {
		blocks.push(
			context(
				Arr.join(
					Arr.map(flags, (signal) => `${TONE_MARK[signal.tone]}${escape(signal.text)}`),
					SEPARATOR,
				),
			),
		)
	}
	if (shown.length > 0) {
		blocks.push(statsTable(shown, signals))
	}
	const integrations = integrationBlocks(subject.integrations)
	if (integrations.length > 0) blocks.push({ type: "divider" }, ...integrations)
	blocks.push({ type: "divider" }, ...otherOrgsBlocks(subject.otherOrgs))

	const missing = [...unread(snapshot), ...report.unreadEvidence]
	if (missing.length > 0) blocks.push(context(`Could not read: ${Arr.join(missing, ", ")}`))

	// Unlike the header's plain text, the fallback is mrkdwn: an org name is escaped here.
	const shownReason =
		modelRead?.verdict === "override" && modelRead.reason !== null
			? escape(clip(modelRead.reason))
			: REASON_LABELS[reason]
	return { text: `${escape(title(report))} (${shownReason})`, blocks }
}
