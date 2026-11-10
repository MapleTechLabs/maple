/**
 * The cancellation report as chat blocks, for a workspace linked through a chat
 * connector (Maple's own Hazel). The same sections as the Slack message, in
 * standard markdown: one prose block each, so a report too long for one message
 * is cut between sections, and the connector writes its own dialect.
 */
import type { ChatBlock } from "@maple/chat-platform"
import { Array as Arr } from "effect"
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
	mark,
	NO_INTEGRATIONS,
	NO_OTHER_ORGS,
	OTHER_ORGS_SHOWN,
	OTHER_ORGS_UNREAD,
	type OtherOrg,
	orgLinkList,
	otherOrgFacts,
	otherOrgName,
	otherOrgsHidden,
	planContext,
	rankedStats,
	type Stat,
	reasonText,
	SEPARATOR,
	stats,
	stripeFeedbackText,
	title,
	TONE_EMOJI,
	unreadSources,
} from "./report"

/**
 * Nothing escaped: markdown has no mention markup of its own, and each
 * connector defuses its platform's.
 */
const markdown: Markup = {
	escape: (text) => text,
	bold: (text) => `**${text}**`,
	link: (label, url) => `[${label}](${url})`,
	emoji: (name) =>
		({
			red_circle: "🔴",
			large_green_circle: "🟢",
			large_yellow_circle: "🟡",
			office: "🏢",
			robot_face: "🤖",
		})[name],
	bullet: "- ",
}

const prose = (...lines: ReadonlyArray<string>): ChatBlock => ({
	kind: "prose",
	markdown: Arr.join(lines, "\n"),
})

/** Text the customer or the model wrote, set apart as a quote. */
const quoted = (text: string) => prose(`> ${text}`)

/** A row of the Slack table as a line: the figure, then the month before and its notes. */
const statLine = (stat: Stat, tone: CancellationSignal["tone"]): string => {
	const details = [...(stat.before === null ? [] : [`month before ${stat.before}`]), ...stat.notes]
	return `${markdown.bullet}${mark(markdown, TONE_EMOJI[tone])}${stat.label}: ${markdown.bold(stat.now)}${
		details.length === 0 ? "" : ` (${Arr.join(details, " · ")})`
	}`
}

const otherOrgLines = (otherOrgs: ReadonlyArray<OtherOrg> | null): ReadonlyArray<string> => {
	if (otherOrgs === null) return [OTHER_ORGS_UNREAD]
	if (otherOrgs.length === 0) return [NO_OTHER_ORGS]
	const hidden = otherOrgsHidden(otherOrgs)
	return [
		...Arr.flatMap(otherOrgs.slice(0, OTHER_ORGS_SHOWN), (org) => [
			otherOrgName(markdown, org),
			otherOrgFacts(markdown, org),
		]),
		...(hidden === null ? [] : [hidden]),
	]
}

export const buildCancellationChatBlocks = (report: CancellationReport): ReadonlyArray<ChatBlock> => {
	const { subject, snapshot, reason, signals, modelRead } = report
	const shown = stats(snapshot)
	const flagged = flags(signals, shown)
	const told = stripeFeedbackText(markdown, report.stripeFeedback)
	const findings = modelRead === null ? null : findingsText(markdown, modelRead.findings)
	const conclusion = modelRead === null ? null : conclusionText(markdown, modelRead.conclusion)
	const missing = unreadSources(report)

	return [
		prose(
			markdown.bold(title(report)),
			planContext(markdown, report),
			Arr.join(
				Arr.map(orgLinkList(subject.links, subject.sessionsUrl), ([label, url]) =>
					markdown.link(label, url),
				),
				SEPARATOR,
			),
		),
		...(modelRead?.company == null ? [] : [quoted(companyText(markdown, modelRead.company))]),
		prose(reasonText(markdown, reason, modelRead)),
		...(told === null ? [] : [quoted(told)]),
		...(findings === null ? [] : [prose(findings)]),
		...(conclusion === null ? [] : [quoted(conclusion)]),
		...(flagged.length === 0 ? [] : [prose(flagsText(markdown, flagged))]),
		...(shown.length === 0
			? []
			: [
					prose(
						markdown.bold("Last 30 days"),
						...Arr.map(rankedStats(shown, signals), ({ stat, tone }) => statLine(stat, tone)),
					),
				]),
		...(subject.integrations === null
			? []
			: [
					prose(
						markdown.bold("Integrations"),
						...(subject.integrations.length === 0
							? [NO_INTEGRATIONS]
							: Arr.map(
									integrationRows(markdown, subject.integrations),
									(row) => `${markdown.bullet}${integrationText(markdown, row)}`,
								)),
					),
				]),
		prose(markdown.bold("Members' other orgs"), ...otherOrgLines(subject.otherOrgs)),
		...(missing.length === 0 ? [] : [prose(`_Could not read: ${Arr.join(missing, ", ")}_`)]),
	]
}
