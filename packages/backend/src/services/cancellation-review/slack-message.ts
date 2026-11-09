/**
 * The cancellation report as a Slack message. Block Kit, built as plain data so
 * what a reader sees is asserted in a test rather than eyeballed in a channel.
 */
import type { CancellationModelRead } from "@maple/domain/http"
import type { IntegrationEntry } from "@maple/domain/integration-inventory"
import type { CancellationSignal } from "./signals"
import {
	type CancellationReport,
	companyText,
	conclusionText,
	findingsText,
	flags,
	flagsText,
	integrationRows,
	integrationText,
	type Markup,
	NO_INTEGRATIONS,
	NO_OTHER_ORGS,
	OTHER_ORGS_SHOWN,
	OTHER_ORGS_UNREAD,
	type OrgLinks,
	type OtherOrg,
	otherOrgFacts,
	otherOrgName,
	otherOrgsHidden,
	orgLinkList,
	planContext,
	providerOf,
	rankedStats,
	reasonText,
	shownReason,
	type Stat,
	stats,
	stripeFeedbackText,
	title,
	TONE_EMOJI,
	unreadSources,
} from "./report"
import { Array as Arr, String as Str } from "effect"

/** Slack reads `&`, `<` and `>` as markup; an org name is free text. */
const escape = (text: string): string =>
	Str.replaceAll(">", "&gt;")(Str.replaceAll("<", "&lt;")(Str.replaceAll("&", "&amp;")(text)))

const mrkdwn: Markup = {
	escape,
	bold: (text) => `*${text}*`,
	link: (label, url) => `<${url}|${label}>`,
	emoji: (name) => `:${name}:`,
	bullet: "• ",
}

const linkButtons = (links: OrgLinks, sessionsUrl: string | null) => ({
	type: "actions",
	elements: Arr.map(orgLinkList(links, sessionsUrl), ([label, url]) => ({
		type: "button",
		text: { type: "plain_text", text: label },
		url,
		action_id: `open_${Str.toLowerCase(label)}`,
	})),
})

/** Table cells are rich text, not mrkdwn: nothing in them needs escaping. */
const cell = (elements: ReadonlyArray<Record<string, unknown>>): Record<string, unknown> => ({
	type: "rich_text",
	elements: [{ type: "rich_text_section", elements }],
})

const bold = (text: string) => cell([{ type: "text", text, style: { bold: true } }])

const statsTable = (shown: ReadonlyArray<Stat>, signals: ReadonlyArray<CancellationSignal>) => {
	const rows = Arr.map(rankedStats(shown, signals), ({ stat, tone }) => {
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
		column_settings: [{}, {}, { is_wrapped: true }],
		rows: [[bold("Last 30 days"), bold("Now"), bold("Month before")], ...rows],
	}
}

const context = (text: string) => ({ type: "context", elements: [{ type: "mrkdwn", text }] })
/** Text the customer or the model wrote: shown as written, a URL in it never turned into a link. */
const quoted = (text: string) => ({ type: "context", elements: [{ type: "mrkdwn", text, verbatim: true }] })
const heading = (text: string) => ({ type: "section", text: { type: "mrkdwn", text: `*${text}*` } })

/** Favicons, because Slack renders neither SVG nor its own app icons in a message. */
const iconOf = (domain: string) => `https://www.google.com/s2/favicons?domain=${domain}&sz=64`

const integrationBlocks = (
	integrations: ReadonlyArray<IntegrationEntry> | null,
): ReadonlyArray<Record<string, unknown>> => {
	if (integrations === null) return []
	if (integrations.length === 0) return [heading("Integrations"), context(NO_INTEGRATIONS)]
	return [
		heading("Integrations"),
		...Arr.map(integrationRows(mrkdwn, integrations), (row) => {
			const provider = providerOf(row.key)
			return {
				type: "context",
				elements: [
					...(provider.domain === null
						? []
						: [{ type: "image", image_url: iconOf(provider.domain), alt_text: provider.label }]),
					{ type: "mrkdwn", text: integrationText(mrkdwn, row) },
				],
			}
		}),
	]
}

/** Always shown: "none" is the answer that says the customer is not just moving orgs. */
const otherOrgsBlocks = (
	otherOrgs: ReadonlyArray<OtherOrg> | null,
): ReadonlyArray<Record<string, unknown>> => {
	if (otherOrgs === null) return [heading("Members' other orgs"), context(OTHER_ORGS_UNREAD)]
	if (otherOrgs.length === 0) return [heading("Members' other orgs"), context(NO_OTHER_ORGS)]
	const hidden = otherOrgsHidden(otherOrgs)
	return [
		heading("Members' other orgs"),
		...Arr.flatMap(otherOrgs.slice(0, OTHER_ORGS_SHOWN), (org) => [
			{ type: "section", text: { type: "mrkdwn", text: otherOrgName(mrkdwn, org) } },
			context(otherOrgFacts(mrkdwn, org)),
		]),
		...(hidden === null ? [] : [context(hidden)]),
	]
}

/** The model's findings, stated as fact, then its opinion. */
const modelBlocks = (modelRead: CancellationModelRead | null): ReadonlyArray<Record<string, unknown>> => {
	if (modelRead === null) return []
	const findings = findingsText(mrkdwn, modelRead.findings)
	const conclusion = conclusionText(mrkdwn, modelRead.conclusion)
	return [
		...(findings === null
			? []
			: [{ type: "section", text: { type: "mrkdwn", text: findings, verbatim: true } }]),
		...(conclusion === null ? [] : [quoted(conclusion)]),
	]
}

/** `text` is the notification and screen-reader fallback; `blocks` is what the channel shows. */
export const buildCancellationMessage = (
	report: CancellationReport,
): { readonly text: string; readonly blocks: ReadonlyArray<Record<string, unknown>> } => {
	const { subject, snapshot, reason, signals, modelRead } = report
	const shown = stats(snapshot)
	const flagged = flags(signals, shown)

	const blocks: Array<Record<string, unknown>> = [
		{ type: "header", text: { type: "plain_text", text: Str.slice(0, 150)(title(report)), emoji: true } },
		context(planContext(mrkdwn, report)),
		linkButtons(subject.links, subject.sessionsUrl),
		...(modelRead?.company == null ? [] : [quoted(companyText(mrkdwn, modelRead.company))]),
		// Verbatim: an override's reason is the model's words.
		{
			type: "section",
			text: { type: "mrkdwn", text: reasonText(mrkdwn, reason, modelRead), verbatim: true },
		},
	]
	const told = stripeFeedbackText(mrkdwn, report.stripeFeedback)
	if (told !== null) blocks.push(quoted(told))
	blocks.push(...modelBlocks(modelRead))
	if (flagged.length > 0) blocks.push(context(flagsText(mrkdwn, flagged)))
	if (shown.length > 0) blocks.push(statsTable(shown, signals))
	const integrations = integrationBlocks(subject.integrations)
	if (integrations.length > 0) blocks.push({ type: "divider" }, ...integrations)
	blocks.push({ type: "divider" }, ...otherOrgsBlocks(subject.otherOrgs))

	const missing = unreadSources(report)
	if (missing.length > 0) blocks.push(context(`Could not read: ${Arr.join(missing, ", ")}`))

	// Unlike the header's plain text, the fallback is mrkdwn: an org name is escaped here.
	return { text: `${escape(title(report))} (${escape(shownReason(reason, modelRead))})`, blocks }
}
