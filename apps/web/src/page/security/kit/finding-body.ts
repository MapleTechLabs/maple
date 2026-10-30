import type { SecurityAuditFinding } from "@maple/domain/http"
import { cn } from "@maple/ui/lib/utils"
import type { Html, HtmlBuilder } from "foldkit/html"
import { badge } from "../../../ui/display"
import { eyebrow } from "../../../ui/eyebrow"
import { panel, panelHeader } from "../../../ui/panel"
import type { FindingRecord } from "./format"

// The finding's own record: what is wrong, the trace, how it is exploited, how to fix it.

type Confirmed = Extract<FindingRecord, { verdict: "confirmed" }>
type NeedsValidation = Extract<FindingRecord, { verdict: "needs_validation" }>
type Rejected = Extract<FindingRecord, { verdict: "rejected" }>

const section = <M>(
	h: HtmlBuilder<M>,
	title: string,
	hint: string | null,
	children: ReadonlyArray<Html>,
): Html =>
	panel(h, { className: "overflow-hidden" }, [
		panelHeader(
			h,
			hint === null
				? { title }
				: { title, action: h.span([h.Class("text-xs text-muted-foreground")], [hint]) },
		),
		h.div([h.Class("flex flex-col gap-4 px-4 py-4")], children),
	])

const prose = <M>(h: HtmlBuilder<M>, text: string, className?: string): Html =>
	h.p([h.Class(cn("whitespace-pre-line text-sm leading-relaxed", className))], [text])

const labelled = <M>(h: HtmlBuilder<M>, label: string, text: string): Html =>
	h.div(
		[h.Class("flex flex-col gap-1.5 rounded-md border p-3")],
		[eyebrow(h, { as: "div" }, [label]), h.p([h.Class("text-sm")], [text])],
	)

const codeBlock = <M>(h: HtmlBuilder<M>, text: string, label?: string): Html =>
	h.div(
		[h.Class("overflow-hidden rounded-md border bg-surface-sunken")],
		[
			...(label === undefined
				? []
				: [
						h.div(
							[h.Class("border-b px-3 py-1.5 font-mono text-xs text-muted-foreground")],
							[label],
						),
					]),
			h.pre([h.Class("overflow-x-auto px-3 py-2.5 font-mono text-xs leading-relaxed")], [text]),
		],
	)

const CONDITION_LABEL = {
	authentication_level: "authentication level",
	authorization_role: "authorization role",
	user_interaction: "user interaction",
	system_configuration: "system configuration",
	network_routing: "network routing",
	environmental_dependency: "environment",
	data_state: "data state",
	timing_dependency: "timing",
	third_party_dependency: "third party",
} satisfies Record<Confirmed["conditions"][number]["kind"], string>

const whatIsWrong = <M>(h: HtmlBuilder<M>, record: FindingRecord): Html =>
	section(h, "What is wrong", null, [
		prose(h, record.description),
		h.div(
			[h.Class("grid gap-3 md:grid-cols-2")],
			record.verdict === "confirmed"
				? [
						labelled(h, "Root cause", record.root_cause),
						labelled(h, "Intended behavior", record.intended_behavior),
					]
				: [labelled(h, "Claimed root cause", record.claimed_root_cause)],
		),
	])

const traceAndEvidence = <M>(h: HtmlBuilder<M>, record: FindingRecord): Html => {
	const files = new Set([
		...record.trace.map((step) => step.file),
		...record.evidence.map((item) => item.file),
	])
	return section(
		h,
		"Trace and evidence",
		`${files.size} ${files.size === 1 ? "file" : "files"} · every cited line re-read by the validator`,
		[
			...record.trace.map((step, index) =>
				h.div(
					[h.Key(`trace-${index}`), h.Class("flex flex-col gap-1")],
					[
						h.div(
							[h.Class("flex flex-wrap items-center gap-2")],
							[
								badge(h, { variant: "tag" }, [step.kind]),
								h.span([h.Class("font-mono text-sm")], [`${step.file}:${step.line}`]),
								h.span([h.Class("font-mono text-xs text-muted-foreground")], [step.scope]),
							],
						),
						h.p([h.Class("text-sm text-muted-foreground")], [step.description]),
					],
				),
			),
			...(record.evidence.length === 0
				? []
				: [
						h.div(
							[h.Class("flex flex-col gap-2 border-t pt-3")],
							[
								eyebrow(h, { as: "div" }, ["Evidence"]),
								...record.evidence.map((item, index) =>
									h.div(
										[h.Key(`evidence-${index}`), h.Class("flex flex-col gap-0.5")],
										[
											h.span(
												[h.Class("font-mono text-sm")],
												[`${item.file}:${item.line}`],
											),
											h.span(
												[h.Class("text-sm text-muted-foreground")],
												[item.description],
											),
										],
									),
								),
							],
						),
					]),
		],
	)
}

const exploitation = <M>(h: HtmlBuilder<M>, record: Confirmed): Html =>
	section(h, "How it is exploited", null, [
		prose(h, record.execution.attacker_perspective),
		...(record.conditions.length === 0
			? []
			: [
					h.div(
						[h.Class("flex flex-wrap items-center gap-2 text-xs")],
						[
							h.span([h.Class("text-muted-foreground")], ["Conditions"]),
							...record.conditions.map((condition, index) =>
								badge(
									h,
									{
										variant: "meta",
										className: "h-auto whitespace-normal py-0.5",
										attributes: [h.Key(`c-${index}`)],
									},
									[`${CONDITION_LABEL[condition.kind]}: ${condition.description}`],
								),
							),
						],
					),
				]),
		...record.execution.payloads.map((payload) => codeBlock(h, payload)),
		...(record.execution.instructions.length === 0
			? []
			: [
					h.ol(
						[h.Class("flex list-decimal flex-col gap-1.5 pl-5 text-sm")],
						record.execution.instructions.map((step, index) =>
							h.li([h.Key(`i-${index}`)], [step]),
						),
					),
				]),
		h.div(
			[h.Class("flex flex-col gap-1 border-l-2 pl-3")],
			[
				eyebrow(h, { as: "div" }, ["Observed result"]),
				h.p([h.Class("text-sm text-muted-foreground")], [record.execution.observed_result]),
			],
		),
	])

const assessment = <M>(h: HtmlBuilder<M>, record: Confirmed): Html =>
	section(h, "Assessment", "The agent that checks a finding never found it", [
		h.div(
			[h.Class("grid gap-3 md:grid-cols-3")],
			[
				labelled(
					h,
					`Likelihood · ${record.severity.likelihood.score}`,
					record.severity.likelihood.reason,
				),
				labelled(h, `Impact · ${record.severity.impact.score}`, record.severity.impact.reason),
				labelled(h, `Confidence · ${record.confidence.score}`, record.confidence.reason),
			],
		),
	])

const remediation = <M>(h: HtmlBuilder<M>, record: Confirmed): Html =>
	section(h, "How to fix it", null, [
		prose(h, record.remediation.strategy),
		...(record.remediation.code_changes ?? []).map((change) =>
			codeBlock(h, change.fixed_code, change.file_name),
		),
	])

/** What to run to prove or disprove it: the first thing a reader of an unproven lead needs. */
const checkIt = <M>(h: HtmlBuilder<M>, record: NeedsValidation): Html =>
	section(h, "Check it", "Found by reading the code. Not run, so not proven.", [
		...(record.validation_plan.local === undefined
			? []
			: [labelled(h, "Locally", record.validation_plan.local)]),
		...(record.validation_plan.deployment === undefined
			? []
			: [labelled(h, "On a deployment", record.validation_plan.deployment)]),
		...(record.validation_plan.local === undefined && record.validation_plan.deployment === undefined
			? [prose(h, "The audit left no check for this lead. Use the trace below to reproduce it.")]
			: []),
	])

const whyNotProven = <M>(h: HtmlBuilder<M>, record: NeedsValidation): Html | null =>
	record.blockers.length === 0
		? null
		: section(h, "Why it is not proven", null, [
				h.ul(
					[h.Class("flex list-disc flex-col gap-1.5 pl-5 text-sm")],
					record.blockers.map((blocker, index) => h.li([h.Key(`b-${index}`)], [blocker])),
				),
			])

const rejection = <M>(h: HtmlBuilder<M>, record: Rejected): Html =>
	section(h, "Why it was rejected", "A second model disproved the claim", [prose(h, record.reason)])

export const findingBody = <M>(h: HtmlBuilder<M>, finding: SecurityAuditFinding): ReadonlyArray<Html> => {
	const { record } = finding
	switch (record.verdict) {
		case "confirmed":
			return [
				whatIsWrong(h, record),
				traceAndEvidence(h, record),
				exploitation(h, record),
				assessment(h, record),
				remediation(h, record),
			]
		case "needs_validation": {
			const blockers = whyNotProven(h, record)
			return [
				checkIt(h, record),
				whatIsWrong(h, record),
				...(blockers === null ? [] : [blockers]),
				traceAndEvidence(h, record),
			]
		}
		case "rejected":
			return [whatIsWrong(h, record), rejection(h, record), traceAndEvidence(h, record)]
	}
}
