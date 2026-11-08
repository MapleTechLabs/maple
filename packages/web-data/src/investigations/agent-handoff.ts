/**
 * The "Fix in Claude Code" handoff: one investigation as a prompt for the user's own coding agent,
 * and the deep link that opens that agent with it pre-filled. No target sends the prompt by itself;
 * the user reads it and presses Enter.
 */
import { normalizeRepoFullName } from "@maple/domain/http"
import type { V2Investigation } from "@maple/domain/http/v2"
import { Array as Arr, Option, Order, String as Str } from "effect"

export const AGENT_TARGETS = ["claude-code", "cursor", "vscode"] as const
export type AgentTarget = (typeof AGENT_TARGETS)[number]

export const AGENT_TARGET_LABEL = {
	"claude-code": "Claude Code",
	cursor: "Cursor",
	vscode: "VS Code",
} as const satisfies Record<AgentTarget, string>

export const isAgentTarget = (value: unknown): value is AgentTarget =>
	typeof value === "string" && Arr.some(AGENT_TARGETS, (target) => target === value)

export type HandoffInput = Readonly<{
	investigation: V2Investigation
	/** Absolute link back to the investigation page. */
	investigationUrl: string
	/** `owner/name` of the repository the fix belongs in, when Maple knows it. */
	repo: string | null
	/** A proposed action to focus the fix on, from the action sheet. */
	focus?: string | null
}>

// Claude Code's documented `q` ceiling is 5,000 characters; Cursor's is 10,000 for the whole link.
// VS Code documents none, so it gets Cursor's ceiling less a margin.
const PROMPT_MAX = {
	"claude-code": 4_800,
	cursor: Number.POSITIVE_INFINITY,
	vscode: Number.POSITIVE_INFINITY,
}
const URL_MAX = { "claude-code": 16_000, cursor: 10_000, vscode: 8_000 }

const TRACE_IDS_MAX = 5
const EVIDENCE_MAX = 4
const ACTIONS_MAX = 5
const RULED_OUT_MAX = 5

/** `owner/name`, or null for anything a deep link should not carry. */
export const safeRepo = (repo: string | null): string | null =>
	repo === null ? null : normalizeRepoFullName(repo)

const clip = (text: string, max: number): string => {
	const trimmed = Str.trim(text)
	return trimmed.length <= max ? trimmed : `${Str.trimEnd(Str.slice(0, max - 1)(trimmed))}…`
}

const fence = (text: string): ReadonlyArray<string> => ["```", Str.replaceAll("```", "'''")(text), "```"]

type Section = Readonly<{ lines: ReadonlyArray<string>; dropOrder: number }>

/** `dropOrder` 0 is never dropped; when the prompt is too long, the highest order goes first. */
const sections = (input: HandoffInput, detail: "full" | "short"): ReadonlyArray<Section> => {
	const { investigation } = input
	const report = investigation.report
	const snapshot = investigation.snapshot
	const issueId = investigation.subject.type === "freeform" ? null : investigation.subject.issue_id
	const causeMax = detail === "full" ? 900 : 400
	const evidence = Arr.take(
		Arr.filter(report?.evidence ?? [], (item) => item.note !== "" || item.traceIds.length > 0),
		EVIDENCE_MAX,
	)
	const traceIds = Arr.take(Arr.dedupe(Arr.flatMap(evidence, (item) => item.traceIds)), TRACE_IDS_MAX)
	const commit = report?.suspectCommit
	const where = Arr.filter(
		[
			snapshot.serviceName ? `service ${snapshot.serviceName}` : null,
			snapshot.deploymentEnv ? `environment ${snapshot.deploymentEnv}` : null,
			report?.affectedScope ? `scope: ${clip(report.affectedScope, 160)}` : null,
		],
		(part): part is string => part !== null,
	)

	const steps: Array<string> = []
	if (issueId !== null)
		steps.push(
			`Claim the issue with \`claim_error_issue\` (issue_id "${issueId}") so nobody duplicates the work.`,
		)
	if (traceIds.length > 0)
		steps.push(`Confirm the failure path with \`inspect_trace\` on trace ${traceIds[0]}.`)
	if (snapshot.fingerprintHash)
		steps.push(
			`Pull the stack trace and trend with \`error_detail\` (fingerprint "${snapshot.fingerprintHash}").`,
		)
	if (commit)
		steps.push(`Read the suspect commit with \`git show ${commit.sha}\` and find what it changed.`)
	steps.push(
		"Find the responsible code in this repository and check the diagnosis against it. If the code disagrees, say so before changing anything.",
		input.focus
			? "Make the smallest change that carries out the focus above, with a test."
			: "Make the smallest fix, with a test.",
	)
	if (issueId !== null)
		steps.push(
			`Record the patch with \`propose_fix\` (issue_id "${issueId}"), passing \`pr_url\` once a PR exists. Maple verifies it after merge.`,
		)

	return [
		{
			dropOrder: 0,
			lines: [
				"Maple investigated a production incident and diagnosed it. Fix it in this repository.",
				"If the Maple MCP server is connected, use its tools to check the evidence below; otherwise work from what is here.",
				"",
				`**Incident:** ${clip(snapshot.title, 200)}`,
				...(report?.headline ? [`**Diagnosis:** ${clip(report.headline, 200)}`] : []),
				...(report
					? [
							`**Suspected cause** (${report.confidence} confidence): ${clip(report.suspectedCause, causeMax)}`,
						]
					: []),
				...(where.length > 0 ? [`**Where:** ${Arr.join(where, ", ")}`] : []),
				...(commit
					? [`**Suspect commit:** ${commit.sha}${commit.repo ? ` in ${commit.repo}` : ""}`]
					: []),
				`**Maple investigation:** ${investigation.id} (${input.investigationUrl})`,
				...(issueId !== null ? [`**Maple issue:** ${issueId}`] : []),
			],
		},
		...(input.focus
			? [{ dropOrder: 0, lines: ["", `**Focus on this proposed action:** ${clip(input.focus, 300)}`] }]
			: []),
		...(traceIds.length > 0
			? [{ dropOrder: 2, lines: ["", `**Evidence traces:** ${Arr.join(traceIds, ", ")}`] }]
			: []),
		...(snapshot.exceptionType || snapshot.topFrame
			? [
					{
						dropOrder: 3,
						lines: [
							"",
							...(snapshot.exceptionType
								? [
										`**Error:** ${clip(snapshot.exceptionType, 160)}${snapshot.exceptionMessage ? `: ${clip(snapshot.exceptionMessage, 300)}` : ""}`,
									]
								: []),
							...(snapshot.topFrame
								? ["**Top frame:**", ...fence(clip(snapshot.topFrame, 300))]
								: []),
						],
					},
				]
			: []),
		...(report && report.suggestedActions.length > 0
			? [
					{
						dropOrder: 4,
						lines: [
							"",
							"**Maple's suggested actions:**",
							...Arr.map(
								Arr.take(report.suggestedActions, ACTIONS_MAX),
								(action) => `- ${clip(action, 240)}`,
							),
						],
					},
				]
			: []),
		...(Arr.some(evidence, (item) => item.note !== "")
			? [
					{
						dropOrder: 5,
						lines: [
							"",
							"**Evidence:**",
							...Arr.map(
								Arr.filter(evidence, (item) => item.note !== ""),
								(item) => `- ${clip(item.note, 280)}`,
							),
						],
					},
				]
			: []),
		...(report?.ruledOut && report.ruledOut.length > 0
			? [
					{
						dropOrder: 6,
						lines: [
							"",
							"**Already ruled out:**",
							...Arr.map(
								Arr.take(report.ruledOut, RULED_OUT_MAX),
								(item) => `- ${clip(item, 200)}`,
							),
						],
					},
				]
			: []),
		{
			dropOrder: 0,
			lines: ["", "Please:", ...Arr.map(steps, (step, index) => `${index + 1}. ${step}`)],
		},
	]
}

const render = (parts: ReadonlyArray<Section>): string =>
	Arr.join(
		Arr.flatMap(parts, (part) => part.lines),
		"\n",
	)

const rawLink = (target: AgentTarget, prompt: string, repo: string | null): string => {
	const text = encodeURIComponent(prompt)
	switch (target) {
		case "claude-code":
			// The slash in `owner/name` stays literal, as the documented example writes it.
			return `claude-cli://open?${repo === null ? "" : `repo=${repo}&`}q=${text}`
		case "cursor":
			return `cursor://anysphere.cursor-deeplink/prompt?text=${text}`
		case "vscode":
			return `vscode://anthropic.claude-code/open?prompt=${text}`
	}
}

const fits = (target: AgentTarget, prompt: string, repo: string | null): boolean =>
	prompt.length <= PROMPT_MAX[target] && rawLink(target, prompt, repo).length <= URL_MAX[target]

/** The prompt for a target: everything when it fits, else the lowest-value sections dropped first. */
export const handoffPrompt = (
	input: HandoffInput,
	target: AgentTarget | "clipboard" = "clipboard",
): string => {
	if (target === "clipboard") return render(sections(input, "full"))
	const repo = safeRepo(input.repo)
	// Longest first: every section, then the highest drop order removed one at a time, then shorter text.
	const candidates = Arr.flatMap(["full", "short"] as const, (detail) => {
		const all = sections(input, detail)
		const orders = Arr.sort(Arr.dedupe(Arr.map(all, (part) => part.dropOrder)), Order.flip(Order.Number))
		return Arr.map([Number.POSITIVE_INFINITY, ...orders], (ceiling) =>
			render(Arr.filter(all, (part) => part.dropOrder < ceiling || part.dropOrder === 0)),
		)
	})
	return Option.getOrElse(
		Arr.findFirst(candidates, (prompt) => fits(target, prompt, repo)),
		() => clip(render(Arr.filter(sections(input, "short"), (part) => part.dropOrder === 0)), 1_500),
	)
}

/** The deep link that opens `target` with the investigation's prompt filled in, never sent. */
export const agentDeepLink = (target: AgentTarget, input: HandoffInput): string =>
	rawLink(target, handoffPrompt(input, target), target === "claude-code" ? safeRepo(input.repo) : null)
