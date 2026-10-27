import type { SecurityAuditEvent, SecurityAuditUnit } from "@maple/domain/http"
import { ORG_NO_AI_CREDITS, ORG_SPEND_LIMIT_REACHED } from "@maple/domain/security-audit"
import { incompleteReasonLabel } from "./format"

// What a run found and why it stopped, in the words a person reads: stop reasons, leads, unit
// names and event sentences.

// STOP REASONS

/** `broken`: something failed under the run. `choice`: a limit or rule the run followed. */
export type StopKind = "broken" | "choice"

/** The one control a stop banner offers: run again, raise the limit, or change spend and models. */
export type StopAction = "start" | "limit" | "settings" | null

export type StopReason = Readonly<{
	kind: StopKind
	title: string
	/** What happened, then what to do. */
	body: string
	/** A lowercase fragment for one-line summaries: lists, badges, table cells. */
	short: string
	action: StopAction
}>

type ReasonCopy = Omit<StopReason, "kind"> & Readonly<{ kind: StopKind }>

/** Codes the engine and host write, by the part before any `: detail`. */
const REASON_COPY = new Map<string, (detail: string) => ReasonCopy>([
	[
		"critic_unavailable",
		(detail) => {
			const wave = /after wave (\d+)/u.exec(detail)?.[1]
			return wave === undefined
				? {
						kind: "broken",
						title: "The final coverage review failed",
						body: "The last check for missed units returned an answer that could not be used, so the run could not call its coverage complete. Start a new run to try the review again.",
						short: "final coverage review failed",
						action: "start",
					}
				: {
						kind: "broken",
						title: `Stopped adding units after wave ${wave}`,
						body: `The coverage review after wave ${wave} returned an answer that could not be used, so no more units were planned. What was covered still counts. Start a new run to continue.`,
						short: `coverage review failed after wave ${wave}`,
						action: "start",
					}
		},
	],
	[
		"record_verification_incomplete",
		() => ({
			kind: "broken",
			title: "A lead was not re-checked",
			body: "The final re-check of a lead failed for a technical reason, so it was left out of the report. Start a new run to check it again.",
			short: "a lead was not re-checked",
			action: "start",
		}),
	],
	[
		"candidate_validation_failed",
		() => ({
			kind: "broken",
			title: "A candidate could not be validated",
			body: "The second model's answer for a candidate could not be used, twice. It stays a candidate. Start a new run to validate it again.",
			short: "a candidate was not validated",
			action: "start",
		}),
	],
	[
		"reconnaissance_synthesis_failed",
		() => ({
			kind: "broken",
			title: "Could not plan the audit",
			body: "Mapping the repository into units failed, so nothing was audited. Start a new run to try again.",
			short: "planning the audit failed",
			action: "start",
		}),
	],
	[
		"findings_failed_validation",
		() => ({
			kind: "broken",
			title: "Some results failed a format check",
			body: "Records that did not match the expected format were left out of the report. Start a new run to find them again.",
			short: "some results failed a format check",
			action: "start",
		}),
	],
	[
		"ledger_failed_validation",
		() => ({
			kind: "broken",
			title: "The coverage ledger failed a format check",
			body: "Coverage may read lower than what was audited. Start a new run to rebuild it.",
			short: "coverage ledger failed a format check",
			action: "start",
		}),
	],
	[
		"org_budget_unavailable",
		() => ({
			kind: "broken",
			title: "Billing could not be reached",
			body: "Spend could not be checked, so no more agents were started. Agents that did not run were not charged. Start a new run to continue.",
			short: "billing could not be reached",
			action: "start",
		}),
	],
	[
		ORG_SPEND_LIMIT_REACHED,
		() => ({
			kind: "choice",
			title: "Stopped at the org's monthly spend limit",
			body: "No more agents were started once the limit was reached. The limit resets on the 1st of the month (UTC), or an admin can raise it.",
			short: "reached the monthly spend limit",
			action: "limit",
		}),
	],
	[
		ORG_NO_AI_CREDITS,
		() => ({
			kind: "choice",
			title: "Out of AI credits",
			body: "The organization ran out of AI credits, so no more agents were started. Add credits, then start a new run.",
			short: "ran out of AI credits",
			action: null,
		}),
	],
	[
		"validation_budget_exhausted",
		() => ({
			kind: "choice",
			title: "Budget ran out during validation",
			body: "Some candidates were not validated before the run's budget ran out. They stay candidates for the next run.",
			short: "budget ran out during validation",
			action: "settings",
		}),
	],
	[
		"budget_cannot_fund_a_hunter",
		() => ({
			kind: "choice",
			title: "Budget too small to audit",
			body: "The run's budget could not pay for a single audit agent, so no units were audited. Pick a cheaper model or raise the budget.",
			short: "budget too small to audit",
			action: "settings",
		}),
	],
	[
		"budget_cannot_fund_reconnaissance_and_reserves",
		() => ({
			kind: "choice",
			title: "Budget too small to start",
			body: "The run's budget could not pay for mapping the repository and the checks it reserves. Pick a cheaper model or raise the budget.",
			short: "budget too small to start",
			action: "settings",
		}),
	],
])

const reasonOf = (code: string): StopReason => {
	const split = code.indexOf(":")
	const key = split === -1 ? code : code.slice(0, split)
	const copy = REASON_COPY.get(key)?.(split === -1 ? "" : code.slice(split + 1).trim())
	if (copy !== undefined) return copy
	const label = incompleteReasonLabel(code)
	return {
		kind: "choice",
		title: "Stopped before it covered everything",
		body: `The run ended early: ${label}.`,
		short: label,
		action: "start",
	}
}

/** Each code in a run's `incompleteReason`, in the order the run hit them. */
export const stopReasonsOf = (incompleteReason: string | null): ReadonlyArray<StopReason> =>
	incompleteReason === null || incompleteReason.trim() === ""
		? [reasonOf("stopped_early")]
		: incompleteReason
				.split("; ")
				.filter((code) => code.trim() !== "")
				.map(reasonOf)

export type StopNote = Readonly<{
	tone: "warn" | "crit"
	title: string
	body: string
	action: StopAction
}>

/** The stop banner: the first reason leads, the rest follow, then the gaps the next run starts with. */
export const stopNoteOf = (incompleteReason: string | null, gaps: number): StopNote => {
	const reasons = stopReasonsOf(incompleteReason)
	const [first, ...rest] = reasons
	const lead = first ?? reasonOf("stopped_early")
	return {
		// An infrastructure failure is not a coverage decision, so it reads louder.
		tone: reasons.some((reason) => reason.kind === "broken") ? "crit" : "warn",
		title: lead.title,
		body: [
			lead.body,
			...(rest.length === 0 ? [] : [`Also: ${rest.map((reason) => reason.short).join("; ")}.`]),
			...(gaps > 0
				? [
						gaps === 1
							? "1 unit was not audited and is listed as a gap."
							: `${gaps} units were not audited and are listed as gaps.`,
					]
				: []),
		].join(" "),
		action: lead.action,
	}
}

/** One line for a list row: `coverage review failed after wave 2 · +2 more`. */
export const stopSummaryOf = (incompleteReason: string | null): string => {
	const reasons = stopReasonsOf(incompleteReason)
	const first = reasons[0]?.short ?? "stopped early"
	return reasons.length > 1 ? `${first} · +${reasons.length - 1} more` : first
}

// LEADS

/** `2 confirmed · 6 to validate`, `6 to validate`, or `none open`. */
export const leadsLine = (confirmed: number, toValidate: number): string =>
	confirmed === 0 && toValidate === 0
		? "none open"
		: confirmed === 0
			? `${toValidate} to validate`
			: toValidate === 0
				? `${confirmed} confirmed`
				: `${confirmed} confirmed · ${toValidate} to validate`

// UNITS

/** `ATTACK-CLASSES.md#Broken-Access-Control` reads as `Broken Access Control`; `src/a.ts#POST x` as `POST x`. */
export const plainName = (text: string): string => {
	const match = /^([^\s#]+)#(.+)$/u.exec(text.trim())
	if (match === null) return text.trim()
	const anchor = match[2] ?? ""
	return /\.md$/iu.test(match[1] ?? "") && !anchor.includes(" ")
		? anchor.replaceAll(/[-_]+/gu, " ")
		: anchor
}

/** The surface a unit audits, as its title; one that did not decode shows its coverage id. */
export const unitName = (unit: SecurityAuditUnit): string =>
	unit.surface !== null
		? plainName(unit.surface)
		: unit.subsystem !== null
			? unit.subsystem
			: unit.attackClass !== null
				? plainName(unit.attackClass)
				: unit.coverageId

/** `subsystem · attack class` under the title. */
export const unitContext = (unit: SecurityAuditUnit): string =>
	[
		unit.surface === null ? null : unit.subsystem,
		unit.attackClass === null ? null : plainName(unit.attackClass),
	]
		.filter((part) => part !== null && part !== "")
		.join(" · ")

// EVENTS

const ROLE_NAME = new Map([
	["recon", "Recon agent"],
	["synthesis", "Planner"],
	["hunter", "Hunter"],
	["critic", "Coverage review"],
	["candidate-verifier", "Validator"],
	["record-verifier", "Final re-check"],
])

const roleName = (role: string | null): string =>
	role === null ? "Agent" : (ROLE_NAME.get(role) ?? role.replaceAll("-", " "))

/** The engine's discard note, as a reason: `result broke its contract at: a, b`. */
const discardReason = (message: string | null): string => {
	if (message === null || message === "") return "its answer could not be used"
	if (message === "empty answer") return "its answer was empty"
	const at = /broke its contract at: (.+)$/u.exec(message)?.[1]
	return at === undefined ? message : `its answer did not match the format at ${at}`
}

const noteSentence = (message: string): string => {
	const incomplete = /^incomplete: (.+)$/u.exec(message)?.[1]
	if (incomplete !== undefined) return `Stopping early: ${stopSummaryOf(incomplete)}.`
	const notRun = /^(\S+) not run: (.+)$/u.exec(message)
	if (notRun !== null) return `Agent ${notRun[1] ?? ""} was not started: ${notRun[2] ?? ""}`
	const refused = /^(critic|seed) unit refused: (.+)$/u.exec(message)?.[2]
	if (refused !== undefined) return `A proposed unit was not added: ${refused}`
	return message
}

export type EventFilter = "all" | "problems" | "leads"

export type EventLine = Readonly<{
	sentence: string
	/** The agent or phase id, for the muted line under the sentence. */
	meta: string | null
	isProblem: boolean
	isLead: boolean
}>

const LEAD_ROLES: ReadonlyArray<string> = ["candidate-verifier", "record-verifier"]
const LEAD_PHASES: ReadonlyArray<string> = ["candidate-validation", "record-verification"]

/** One event as a sentence a person can scan, and which filters it belongs to. */
export const eventLineOf = (event: SecurityAuditEvent): EventLine => {
	if (event.kind === "Agent") {
		const who = roleName(event.role)
		const sentence =
			event.outcome === "failed"
				? `${who} failed: ${event.message ?? "no answer"}`
				: event.outcome === "discarded"
					? `${who} answer discarded: ${discardReason(event.message)}`
					: event.message === null || event.message === ""
						? `${who} finished`
						: `${who} finished: ${event.message}`
		return {
			sentence,
			meta: event.agentId,
			isProblem: event.outcome === "failed" || event.outcome === "discarded",
			isLead: event.role !== null && LEAD_ROLES.includes(event.role),
		}
	}
	if (event.kind === "Note") {
		const message = event.message ?? event.detail ?? ""
		return {
			sentence: noteSentence(message),
			meta: null,
			isProblem: /^incomplete: | not run: | unit refused: /u.test(message),
			isLead: /candidate|lead/iu.test(message),
		}
	}
	return {
		sentence: event.message ?? event.detail ?? (event.phase === null ? "" : `Phase ${event.phase}`),
		meta: event.message === null ? null : event.detail,
		isProblem: false,
		isLead: event.phase !== null && LEAD_PHASES.includes(event.phase),
	}
}

export const matchesEventFilter = (line: EventLine, filter: EventFilter): boolean =>
	filter === "all" || (filter === "problems" ? line.isProblem : line.isLead)
