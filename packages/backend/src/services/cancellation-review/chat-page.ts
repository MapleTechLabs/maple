/**
 * The cancellation report as an HTML page, for a chat connector that shows one in a message
 * (Hazel's HTML renders). The same content as the Slack message, laid out to be read at a glance:
 * a header with the org's links, the likely reason, one strip of stats, what stands out, then the
 * account's company, integrations and other orgs in a row below.
 *
 * The page sits on the channel's background and takes Hazel's theme through its CSS variables
 * (`--card`, `--destructive`, …), so it follows light and dark mode. Everything free-text is
 * escaped; the page runs sandboxed either way.
 */
import type { ChatBlock } from "@maple/chat-platform"
import type { CancellationModelRead } from "@maple/domain/http"
import type { IntegrationEntry } from "@maple/domain/integration-inventory"
import { Array as Arr, Option, String as Str } from "effect"
import { buildCancellationChatBlocks } from "./chat-message"
import {
	type CancellationReport,
	clip,
	day,
	flags,
	integrationRows,
	type Markup,
	NO_INTEGRATIONS,
	NO_OTHER_ORGS,
	OTHER_ORGS_SHOWN,
	OTHER_ORGS_UNREAD,
	type OtherOrg,
	orgLinkList,
	otherOrgsHidden,
	plural,
	providerOf,
	rankedStats,
	REASON_LABELS,
	type Stat,
	stats,
	title,
	unreadSources,
} from "./report"
import type { CancellationSignal } from "./signals"

/** The frame's height until the page reports its own; Hazel takes 80 to 2000. */
const INITIAL_HEIGHT = 900

const escapeHtml = (text: string): string =>
	Str.replaceAll(
		'"',
		"&quot;",
	)(Str.replaceAll(">", "&gt;")(Str.replaceAll("<", "&lt;")(Str.replaceAll("&", "&amp;")(text))))

/** Only http(s) links: anything else is dropped rather than put in an `href`. */
const link = (label: string, url: string, className: string): string =>
	/^https?:\/\//i.test(url)
		? `<a class="${className}" href="${escapeHtml(url)}" target="_blank" rel="noreferrer">${escapeHtml(label)}</a>`
		: `<span class="${className}">${escapeHtml(label)}</span>`

/** Favicons, because the page has no icon set of its own. */
const iconOf = (domain: string) =>
	`<img class="icon" alt="" src="https://www.google.com/s2/favicons?domain=${domain}&amp;sz=64">`

/** Where each header link's icon comes from; Sessions open in Maple, so they take its icon. */
const LINK_ICON_DOMAINS = [
	["Clerk", "clerk.com"],
	["Stripe", "stripe.com"],
	["Autumn", "useautumn.com"],
	["Sessions", "maple.dev"],
] as const

/** An icon-only link, its name kept as the tooltip and accessible label. */
const iconLink = (name: string, url: string): string => {
	const domain = Option.getOrUndefined(
		Arr.findFirst(LINK_ICON_DOMAINS, ([label]) => label === name).pipe(Option.map(([, d]) => d)),
	)
	if (domain === undefined || !/^https?:\/\//i.test(url)) return link(name, url, "")
	const tip = name === "Sessions" ? "Session replays" : `Open in ${name}`
	return `<a class="button" href="${escapeHtml(url)}" target="_blank" rel="noreferrer" title="${tip}" aria-label="${tip}">${iconOf(domain)}</a>`
}

const TONE_CLASS = {
	concern: "concern",
	healthy: "healthy",
	neutral: "neutral",
} satisfies Record<CancellationSignal["tone"], string>

const dot = (tone: CancellationSignal["tone"]) => `<span class="dot ${TONE_CLASS[tone]}"></span>`

const label = (text: string) => `<div class="label">${escapeHtml(text)}</div>`

const STYLE = `
*{box-sizing:border-box}
a{color:inherit;text-decoration:none}
.report{display:flex;flex-direction:column;gap:20px;max-width:880px}
.header{display:flex;justify-content:space-between;align-items:flex-start;gap:8px 24px;flex-wrap:wrap}
.heading{display:flex;flex-direction:column;gap:4px;min-width:0;flex:1 1 320px}
.title-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.title{font-size:16px;font-weight:600;line-height:1.35}
.pill{display:inline-block;padding:1px 6px;border-radius:4px;font-size:10px;font-weight:600;line-height:1.6;background:var(--muted);white-space:nowrap;text-transform:uppercase;letter-spacing:0.05em}
.pill.ended{color:var(--destructive)}
.pill.cancelled{color:var(--warning)}
.meta{display:flex;flex-wrap:wrap;gap:2px 0;font-size:13px;color:var(--muted-foreground)}
.meta span+span::before{content:"\\00b7";padding:0 6px}
.buttons{display:flex;gap:4px}
.button{display:inline-flex;align-items:center;justify-content:center;width:30px;height:30px;border-radius:6px;opacity:0.85}
.button:hover{background:var(--muted);opacity:1}
.button .icon{width:16px;height:16px}
.label{font-size:11px;font-weight:600;letter-spacing:0.06em;text-transform:uppercase;color:var(--muted-foreground)}
.verdict{display:flex;flex-direction:column;gap:6px}
.reason-row{display:flex;flex-wrap:wrap;align-items:baseline;gap:2px 10px}
.reason{font-size:15px;font-weight:600;line-height:1.4}
.muted{color:var(--muted-foreground)}
.small{font-size:12px}
.conclusion{max-width:68ch;font-size:14px;line-height:1.55;color:var(--secondary-foreground);margin:0}
.told{display:flex;gap:6px;font-size:13px;color:var(--secondary-foreground)}
.told-label{flex-shrink:0;color:var(--muted-foreground)}
.skipped{color:var(--muted-foreground)}
.card{border:1px solid var(--border);border-radius:var(--radius);background:var(--card)}
.stats{display:flex;flex-direction:column;gap:12px;padding:14px 16px}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:16px 20px}
.tile{display:flex;flex-direction:column;gap:2px;min-width:0}
.tile-label{display:flex;align-items:center;gap:6px;font-size:12px;color:var(--muted-foreground)}
.value{font-size:18px;font-weight:600;line-height:1.3;font-variant-numeric:tabular-nums}
.note{font-size:12px;line-height:1.4;color:var(--muted-foreground)}
.before{font-size:12px;line-height:1.4;color:var(--muted-foreground);font-variant-numeric:tabular-nums}
.dot{display:inline-block;width:6px;height:6px;border-radius:999px;flex-shrink:0;background:var(--muted-foreground)}
.dot.neutral{opacity:0.4}
.dot.concern{background:var(--destructive)}
.dot.healthy{background:var(--success)}
.dot.stale{background:var(--warning)}
.findings{display:flex;flex-direction:column;gap:8px}
.finding{display:flex;gap:10px;align-items:flex-start;max-width:76ch;font-size:14px;line-height:1.55}
.finding .dot{margin-top:8px}
.account{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:20px 24px;padding-top:16px;border-top:1px solid var(--border)}
.section{display:flex;flex-direction:column;gap:6px;min-width:0}
.section-head{display:flex;align-items:center;gap:8px}
.confidence{font-size:11px;font-weight:500}
.confidence.high{color:var(--success)}
.confidence.medium{color:var(--warning)}
.confidence.low{color:var(--muted-foreground)}
.strong{font-size:14px;font-weight:600;line-height:1.4}
.one-liner{font-size:13px;line-height:1.5;color:var(--secondary-foreground)}
.integration{display:flex;align-items:center;gap:8px;font-size:13px}
.integration .name{font-weight:500;flex-shrink:0}
.integration .detail{flex:1;min-width:0;font-size:12px;color:var(--muted-foreground)}
.integration .dot{margin-right:4px;vertical-align:middle}
.icon{width:14px;height:14px;flex-shrink:0;border-radius:3px}
.org{display:flex;flex-direction:column;gap:2px}
.org+.org{margin-top:6px}
.org-title{display:flex;justify-content:space-between;gap:8px;font-size:13px;font-weight:500}
.links{display:flex;gap:10px;font-size:12px;font-weight:500}
.links a{color:var(--accent)}
.footer{display:flex;flex-wrap:wrap;gap:4px 16px;font-size:12px;color:var(--muted-foreground)}
.code{font-family:var(--font-mono);font-size:11px;user-select:all}
`

const header = (report: CancellationReport): string => {
	const { subject, snapshot } = report
	const { plan } = snapshot
	const ended = plan.phase === "ended"
	const meta = [
		ended
			? subject.expiresAt === null
				? "Access ended"
				: `Access ended ${day(subject.expiresAt)}`
			: subject.expiresAt !== null && plan.daysUntilEnd !== null
				? `Access until ${day(subject.expiresAt)} (${plan.daysUntilEnd}d left)`
				: "Cancels at period end",
		...(plan.tenureDays === null ? [] : [`Subscribed ${plural(plan.tenureDays, "day")}`]),
		...(subject.contactEmail === null ? [] : [subject.contactEmail]),
	]
	const buttons = Arr.map(orgLinkList(subject.links, subject.sessionsUrl), ([name, url]) =>
		iconLink(name, url),
	)
	return `<div class="header">
<div class="heading">
<div class="title-row"><span class="pill ${ended ? "ended" : "cancelled"}">${ended ? "Ended" : "Cancelled"}</span><span class="title">${escapeHtml(title(report))}</span></div>
<div class="meta">${Arr.join(
		Arr.map(meta, (part) => `<span>${escapeHtml(part)}</span>`),
		"",
	)}</div>
</div>
<div class="buttons">${Arr.join(buttons, "")}</div>
</div>`
}

const reasonLine = (report: CancellationReport): string => {
	const { reason, modelRead } = report
	const overridden = modelRead?.verdict === "override" && modelRead.reason !== null
	return overridden
		? `<span class="reason">${escapeHtml(clip(modelRead.reason ?? ""))}</span><span class="muted small">Model&#8217;s read &#183; rules said &#8220;${escapeHtml(REASON_LABELS[reason])}&#8221;</span>`
		: `<span class="reason">${escapeHtml(REASON_LABELS[reason])}</span>`
}

/** Null when Stripe could not be read: the footer names it instead. */
const toldStripe = (report: CancellationReport): string | null => {
	const feedback = report.stripeFeedback
	if (feedback === null) return null
	const said = [
		...(feedback.feedback === null ? [] : [escapeHtml(Str.replaceAll("_", " ")(feedback.feedback))]),
		...(feedback.comment === null ? [] : [`&#8220;${escapeHtml(clip(feedback.comment))}&#8221;`]),
	]
	return `<div class="told"><span class="told-label">Told Stripe</span>${
		said.length === 0
			? `<span class="skipped">Skipped the survey</span>`
			: `<span>${Arr.join(said, " &#183; ")}</span>`
	}</div>`
}

const verdict = (report: CancellationReport): string => {
	const conclusion = report.modelRead?.conclusion ?? ""
	const told = toldStripe(report)
	return `<div class="verdict">
${label("Likely reason")}<div class="reason-row">${reasonLine(report)}</div>
${conclusion === "" ? "" : `<p class="conclusion">${escapeHtml(clip(conclusion))}</p>`}
${told ?? ""}
</div>`
}

/** A tile is narrower than a table row: the setup stat's long label moves into its note. */
const tileStat = (stat: Stat): Stat =>
	stat.topic === "setup" ? { ...stat, label: "Setup", notes: ["dashboards / alerts", ...stat.notes] } : stat

const tiles = (report: CancellationReport): string => {
	const shown = stats(report.snapshot)
	if (shown.length === 0) return ""
	return `<div class="card stats"><div class="tiles">${Arr.join(
		Arr.map(
			rankedStats(Arr.map(shown, tileStat), report.signals),
			({ stat, tone }) => `<div class="tile">
<div class="tile-label">${dot(tone)}<span>${escapeHtml(stat.label)}</span></div>
<div class="value">${escapeHtml(stat.now)}</div>
${stat.before === null ? "" : `<div class="before">month before ${escapeHtml(stat.before)}</div>`}
${stat.notes.length === 0 ? "" : `<div class="note">${escapeHtml(Arr.join(stat.notes, " · "))}</div>`}
</div>`,
		),
		"",
	)}</div></div>`
}

/** The signals no tile shows (the plan itself), then the model's findings. */
const findings = (report: CancellationReport): string => {
	const flagged = flags(report.signals, stats(report.snapshot))
	const rows = [
		...Arr.map(flagged, (signal) => ({ tone: signal.tone, text: signal.text })),
		...Arr.map(report.modelRead?.findings ?? [], (text) => ({
			tone: "neutral" as const,
			text: clip(text),
		})),
	]
	if (rows.length === 0) return ""
	return `<div class="findings">${label("What stands out")}${Arr.join(
		Arr.map(
			rows,
			(row) => `<div class="finding">${dot(row.tone)}<span>${escapeHtml(row.text)}</span></div>`,
		),
		"",
	)}</div>`
}

const company = (modelRead: CancellationModelRead | null): string => {
	const guess = modelRead?.company ?? null
	if (guess === null) return ""
	return `<div class="section">
<div class="section-head">${label("Company")}<span class="confidence ${guess.confidence}">${escapeHtml(
		`${Str.capitalize(guess.confidence)} confidence`,
	)}</span></div>
<div class="strong">${escapeHtml(clip(guess.name))}${guess.location === null ? "" : `<span class="muted small"> &#183; ${escapeHtml(clip(guess.location))}</span>`}</div>
${guess.oneLiner === null ? "" : `<div class="one-liner">${escapeHtml(clip(guess.oneLiner))}</div>`}
${guess.basis === "" ? "" : `<div class="note">${escapeHtml(Str.capitalize(clip(guess.basis)))}</div>`}
</div>`
}

/** Integration rows are built by the report; this writes their marks as HTML. */
const htmlMarkup: Markup = {
	escape: escapeHtml,
	bold: (text) => `<strong>${text}</strong>`,
	link: (name, url) => link(name, url, ""),
	emoji: (name) =>
		name === "red_circle"
			? dot("concern")
			: name === "large_green_circle"
				? dot("healthy")
				: name === "large_yellow_circle"
					? `<span class="dot stale"></span>`
					: "",
	bullet: "",
}

const integrationRow = (row: { readonly key: string; readonly detail: string }): string => {
	const { label: name, domain } = providerOf(row.key)
	return `<div class="integration">${domain === null ? "" : iconOf(domain)}<span class="name">${escapeHtml(name)}</span><span class="detail">${row.detail}</span></div>`
}

const integrations = (entries: ReadonlyArray<IntegrationEntry> | null): string => {
	if (entries === null) return ""
	return `<div class="section">${label("Integrations")}${
		entries.length === 0
			? `<div class="note">${escapeHtml(NO_INTEGRATIONS)}</div>`
			: Arr.join(Arr.map(integrationRows(htmlMarkup, entries), integrationRow), "")
	}</div>`
}

const otherOrgRow = (org: OtherOrg): string => {
	const plan = org.billing === null ? null : (org.billing.plan ?? "No plan")
	const facts = [
		`Created ${day(org.createdAtMs)}`,
		...(org.membersCount === null ? [] : [plural(org.membersCount, "member")]),
		`via ${Arr.join(org.sharedMembers, ", ")}`,
	]
	return `<div class="org">
<div class="org-title"><span>${escapeHtml(org.name)}</span>${plan === null ? "" : `<span class="muted small">${escapeHtml(plan)}</span>`}</div>
<div class="note">${escapeHtml(Arr.join(facts, " · "))}</div>
<div class="links">${Arr.join(
		Arr.map(orgLinkList(org.links, null), ([name, url]) => link(name, url, "")),
		"",
	)}</div>
</div>`
}

const otherOrgs = (orgs: ReadonlyArray<OtherOrg> | null): string => {
	const body =
		orgs === null
			? `<div class="note">${escapeHtml(OTHER_ORGS_UNREAD)}</div>`
			: orgs.length === 0
				? `<div class="note">${escapeHtml(NO_OTHER_ORGS)}</div>`
				: Arr.join(Arr.map(orgs.slice(0, OTHER_ORGS_SHOWN), otherOrgRow), "") +
					(otherOrgsHidden(orgs) === null
						? ""
						: `<div class="note">${escapeHtml(otherOrgsHidden(orgs) ?? "")}</div>`)
	return `<div class="section">${label("Members’ other orgs")}${body}</div>`
}

/** The whole page, a complete document. */
export const cancellationReportHtml = (report: CancellationReport): string => {
	const missing = unreadSources(report)
	const account = `${company(report.modelRead)}${integrations(report.subject.integrations)}${otherOrgs(report.subject.otherOrgs)}`
	const footer = [
		`<span class="code">${escapeHtml(report.subject.orgId)}</span>`,
		...(missing.length === 0
			? []
			: [`<span>Could not read: ${escapeHtml(Arr.join(missing, ", "))}</span>`]),
	]
	return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title(report))}</title><style>${STYLE}</style></head><body>
<div class="report">
${header(report)}
${verdict(report)}
${tiles(report)}
${findings(report)}
${account === "" ? "" : `<div class="account">${account}</div>`}
<div class="footer">${Arr.join(footer, "")}</div>
</div>
</body></html>`
}

/**
 * The report as one page block. Its fallback, for a platform that shows no page, is the markdown
 * report the chat message carries.
 */
export const buildCancellationPageBlock = (report: CancellationReport): ChatBlock => ({
	kind: "page",
	title: Str.slice(0, 200)(title(report)),
	html: cancellationReportHtml(report),
	height: INITIAL_HEIGHT,
	fallback: Arr.join(
		Arr.flatMap(buildCancellationChatBlocks(report), (block) =>
			block.kind === "prose" ? [block.markdown] : [],
		),
		"\n\n",
	),
})
