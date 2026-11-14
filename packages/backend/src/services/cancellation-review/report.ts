/**
 * The cancellation report's content, apart from where it is posted: what each
 * section says and in what order it reads. The marks two chat dialects write
 * differently (bold, a link, an emoji, what free text must escape) come from a
 * `Markup`, so Slack (`slack-message.ts`) and a chat connector
 * (`chat-message.ts`) lay out the same sentences.
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

/** The emoji the report uses, by Slack's names for them. */
export type ReportEmoji =
	| "red_circle"
	| "large_green_circle"
	| "large_yellow_circle"
	| "office"
	| "robot_face"

/** What a chat dialect writes its own way. Italics (`_…_`) and code (`` `…` ``) read the same in both. */
export interface Markup {
	/** Free text (an org name, the customer's words) made inert in the dialect. */
	readonly escape: (text: string) => string
	readonly bold: (text: string) => string
	readonly link: (label: string, url: string) => string
	readonly emoji: (name: ReportEmoji) => string
	/** What starts a line of a list. */
	readonly bullet: string
}

export const REASON_LABELS = {
	same_day_cancel: "Cancelled the day they subscribed",
	never_activated: "Never got going",
	stopped_sending: "Stopped sending telemetry",
	not_engaged: "Nobody was using it",
	cost: "Cost",
	payment_failure: "Payment failed",
	unclear: "Not visible in usage",
} satisfies Record<CancellationReason, string>

/** Neutral gets no mark: a column of white circles drowns out the red and green ones. */
export const TONE_EMOJI = {
	concern: "red_circle",
	healthy: "large_green_circle",
	neutral: null,
} satisfies Record<CancellationSignal["tone"], ReportEmoji | null>

export const mark = (m: Markup, emoji: ReportEmoji | null): string =>
	emoji === null ? "" : `${m.emoji(emoji)} `

export const day = (epochMs: number): string =>
	new Date(epochMs).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" })

export const plural = (count: number, noun: string) =>
	`${count} ${
		count === 1 || Str.endsWith("s")(noun)
			? noun
			: /[^aeiou]y$/.test(noun)
				? `${Str.slice(0, -1)(noun)}ies`
				: `${noun}s`
	}`

export const SEPARATOR = "  ·  "

/** Unescaped: a plain-text header shows it as written; a dialect escapes it where it is markup. */
export const title = ({ subject, snapshot }: CancellationReport): string =>
	`${subject.orgName} ${snapshot.plan.phase === "ended" ? "ended" : "cancelled"} the ${snapshot.plan.planId} ${
		snapshot.plan.trial ? "trial" : "plan"
	}`

export const planContext = (m: Markup, { subject, snapshot }: CancellationReport): string => {
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
	if (subject.contactEmail !== null) parts.push(`contact ${m.escape(subject.contactEmail)}`)
	parts.push(`\`${subject.orgId}\``)
	return Arr.join(parts, SEPARATOR)
}

/** The org's own links, in the order they are shown; the ones it has none for left out. */
export const orgLinkList = (
	links: OrgLinks,
	sessionsUrl: string | null,
): ReadonlyArray<readonly [label: string, url: string]> =>
	Arr.flatMap(
		[
			["Clerk", links.clerk],
			["Stripe", links.stripe],
			["Autumn", links.autumn],
			["Sessions", sessionsUrl],
		] as const,
		([label, url]) => (url === null ? [] : [[label, url] as const]),
	)

export const linksText = (m: Markup, links: OrgLinks): string =>
	Arr.join(
		Arr.map(orgLinkList(links, null), ([label, url]) => m.link(label, url)),
		SEPARATOR,
	)

export interface Stat {
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
export const stats = (snapshot: CancellationSnapshot): ReadonlyArray<Stat> => {
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

const TONE_ORDER = { concern: 0, healthy: 1, neutral: 2 } satisfies Record<CancellationSignal["tone"], number>

/** Worrying rows first, then healthy, then the ones with nothing to say. */
export const rankedStats = (shown: ReadonlyArray<Stat>, signals: ReadonlyArray<CancellationSignal>) =>
	Arr.sort(
		Arr.map(shown, (stat) => ({ stat, tone: toneOf(signals, stat.topic) })),
		Order.mapInput(
			Order.Number,
			({ tone }: { readonly tone: CancellationSignal["tone"] }) => TONE_ORDER[tone],
		),
	)

/** Sentences about a section with no stat (the plan itself) have nowhere to fold into. */
export const flags = (
	signals: ReadonlyArray<CancellationSignal>,
	shown: ReadonlyArray<Stat>,
): ReadonlyArray<CancellationSignal> =>
	Arr.filter(signals, (signal) => !Arr.some(shown, (stat) => stat.topic === signal.topic))

export const flagsText = (m: Markup, flagged: ReadonlyArray<CancellationSignal>): string =>
	Arr.join(
		Arr.map(flagged, (signal) => `${mark(m, TONE_EMOJI[signal.tone])}${m.escape(signal.text)}`),
		SEPARATOR,
	)

export const unreadSources = ({ snapshot, unreadEvidence }: CancellationReport): ReadonlyArray<string> => [
	...Arr.map(
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
	),
	...unreadEvidence,
]

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

/** `domain` is where an icon can be fetched from, for a dialect that shows one. */
export const providerOf = (key: string): { readonly label: string; readonly domain: string | null } =>
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

const STATUS_EMOJI = {
	disconnected: "red_circle",
	failing: "red_circle",
	stale: "large_yellow_circle",
	paused: null,
	pending: null,
	healthy: null,
} satisfies Record<IntegrationEntry["status"], ReportEmoji | null>

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
export const integrationRows = (
	m: Markup,
	integrations: ReadonlyArray<IntegrationEntry>,
): ReadonlyArray<{ readonly key: string; readonly detail: string }> =>
	Arr.flatMap(integrations, (integration) => {
		if (integration.provider === "chat") {
			const byConnector = groupBy(integration.resources, (resource) => resource.note ?? "chat")
			return Arr.map([...byConnector], ([connector, workspaces]) => ({
				key: connector,
				detail: Arr.join(
					Arr.map(workspaces, (workspace) => m.escape(workspace.name)),
					", ",
				),
			}))
		}
		const status =
			integration.status === "healthy"
				? null
				: `${mark(m, STATUS_EMOJI[integration.status])}${integration.status}`
		return [
			{
				key: integration.provider,
				detail: Arr.join(
					Arr.filter(
						[
							integration.account === null ? null : m.escape(integration.account),
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

export const integrationText = (m: Markup, row: { readonly key: string; readonly detail: string }) => {
	const { label } = providerOf(row.key)
	return row.detail.length > 0 ? `${m.bold(label)}  ${row.detail}` : m.bold(label)
}

export const NO_INTEGRATIONS = "None connected"

/** Two Slack blocks each, and Slack refuses a message past 50 blocks. */
export const OTHER_ORGS_SHOWN = 8

/** Always shown: "none" is the answer that says the customer is not just moving orgs. */
export const NO_OTHER_ORGS = "None. Every member belongs only to this org."

export const OTHER_ORGS_UNREAD = "Could not check: the Clerk lookup failed"

export const otherOrgName = (m: Markup, org: OtherOrg): string =>
	`${m.bold(m.escape(org.name))}  \`${org.orgId}\``

export const otherOrgFacts = (m: Markup, org: OtherOrg): string =>
	Arr.join(
		[
			`Created ${day(org.createdAtMs)}`,
			...(org.membersCount === null ? [] : [plural(org.membersCount, "member")]),
			...(org.billing === null
				? []
				: [org.billing.plan === null ? "no plan" : `\`${org.billing.plan}\``]),
			`via ${Arr.join(Arr.map(org.sharedMembers, m.escape), ", ")}`,
			linksText(m, org.links),
		],
		SEPARATOR,
	)

/** Null when every org the members belong to is shown. */
export const otherOrgsHidden = (otherOrgs: ReadonlyArray<OtherOrg>): string | null => {
	const hidden = otherOrgs.length - OTHER_ORGS_SHOWN
	return hidden > 0 ? `And ${hidden} older ${hidden === 1 ? "org" : "orgs"}` : null
}

/** Slack refuses a text object past 3000 characters, which would lose the whole report. */
const MAX_FREE_TEXT = 500
export const clip = (value: string): string =>
	value.length > MAX_FREE_TEXT ? `${Str.slice(0, MAX_FREE_TEXT - 1)(value)}…` : value

/** Stripe's survey answers are snake_case enum values (`too_expensive`); the comment is free text. */
export const stripeFeedbackText = (m: Markup, feedback: CancellationStripeFeedback | null): string | null => {
	if (feedback === null || (feedback.feedback === null && feedback.comment === null)) return null
	return Arr.join(
		[
			m.bold("Told Stripe:"),
			...(feedback.feedback === null ? [] : [Str.replaceAll("_", " ")(feedback.feedback)]),
			...(feedback.comment === null ? [] : [`“${m.escape(clip(feedback.comment))}”`]),
		],
		" ",
	)
}

/** The reason line: the model's when it overrode the rules, which then stay visible beside it. */
export const reasonText = (
	m: Markup,
	reason: CancellationReason,
	modelRead: CancellationModelRead | null,
): string =>
	modelRead?.verdict === "override" && modelRead.reason !== null
		? `${m.bold("Likely reason:")} ${m.escape(clip(modelRead.reason))}  _(model's read; rules said: ${REASON_LABELS[reason]})_`
		: `${m.bold("Likely reason:")} ${REASON_LABELS[reason]}`

/** The reason as the notification shows it, unescaped. */
export const shownReason = (reason: CancellationReason, modelRead: CancellationModelRead | null): string =>
	modelRead?.verdict === "override" && modelRead.reason !== null
		? clip(modelRead.reason)
		: REASON_LABELS[reason]

/** Who the model thinks the customer is: "Acme Robotics, Berlin, DE: what it does (medium: domain, homepage)". */
export const companyText = (m: Markup, company: CancellationCompanyGuess): string =>
	Arr.join(
		[
			`${m.emoji("office")} ${m.bold(m.escape(clip(company.name)))}`,
			company.location === null ? "" : `, ${m.escape(clip(company.location))}`,
			company.oneLiner === null ? "" : `: ${m.escape(clip(company.oneLiner))}`,
			`  _(${company.confidence} confidence${company.basis === "" ? "" : `: ${m.escape(clip(company.basis))}`})_`,
		],
		"",
	)

/** The model's findings, stated as fact; null when it found nothing. */
export const findingsText = (m: Markup, findings: ReadonlyArray<string>): string | null =>
	findings.length === 0
		? null
		: Arr.join(
				[m.bold("What stands out"), ...Arr.map(findings, (f) => `${m.bullet}${m.escape(clip(f))}`)],
				"\n",
			)

/** The model's opinion, after its findings; null when it gave none. */
export const conclusionText = (m: Markup, conclusion: string): string | null =>
	conclusion === ""
		? null
		: `${m.emoji("robot_face")} ${m.bold("Model's read:")} ${m.escape(clip(conclusion))}`
