import type { McpToolRegistrar } from "./types"
import { McpInvalidInputError, McpQueryError } from "./types"
import { Effect, Option, Schema, Array as Arr } from "effect"
import type { InvestigationDocument, InvestigationSubject } from "@maple/domain/http"
import { encodePublicId, PublicIdPrefixes } from "@maple/domain/http/v2"
import { GetInvestigationOutput } from "@maple/domain/mcp-outputs"
import { InvestigationService } from "@maple/backend/services/errors/InvestigationService"
import { CurrentMcpTenant } from "../lib/query-warehouse"
import * as P from "../lib/params"
import { doc, type DocBlock, type NextCall } from "../lib/tool-doc"

type Output = typeof GetInvestigationOutput.Type

/** Decoded in the handler, so a malformed or foreign id is invalid input naming both accepted forms. */
const decodeInvestigationId = P.decodeResourceId("investigation", "investigation_id")

const INCIDENT_PREFIXES = {
	error: PublicIdPrefixes.errorIncident,
	anomaly: PublicIdPrefixes.anomalyIncident,
	alert: PublicIdPrefixes.alertIncident,
} as const

const issuePublicId = (issueId: string | undefined) =>
	issueId === undefined ? null : encodePublicId(PublicIdPrefixes.errorIssue, issueId)

const subjectOf = (subject: InvestigationSubject): Output["subject"] => {
	const none = { incidentKind: null, incidentId: null, issueId: null, prompt: null, pullRequestUrl: null }
	switch (subject.type) {
		case "incident":
			return {
				...none,
				type: "incident",
				incidentKind: subject.incidentKind,
				incidentId: encodePublicId(INCIDENT_PREFIXES[subject.incidentKind], subject.incidentId),
				issueId: issuePublicId(subject.issueId),
			}
		case "freeform":
			return { ...none, type: "freeform", prompt: subject.prompt }
		case "fix_verification":
			return {
				...none,
				type: "fix_verification",
				issueId: issuePublicId(subject.issueId),
				pullRequestUrl: subject.pullRequestUrl,
			}
	}
}

export const toInvestigationOutput = (inv: InvestigationDocument): Output => {
	const s = inv.snapshot
	return {
		id: encodePublicId(PublicIdPrefixes.investigation, inv.id),
		status: inv.status,
		subject: subjectOf(inv.subject),
		snapshot: {
			title: s.title,
			scope: s.scope,
			status: s.status,
			severity: s.severity,
			serviceName: s.serviceName ?? null,
			deploymentEnv: s.deploymentEnv ?? null,
			fingerprintHash: s.fingerprintHash ?? null,
			exceptionType: s.exceptionType ?? null,
			exceptionMessage: s.exceptionMessage ?? null,
			topFrame: s.topFrame ?? null,
			occurrenceCount: s.occurrenceCount ?? null,
			incidentStartedAt: s.incidentStartedAt,
			incidentEndedAt: s.incidentEndedAt,
			facts: Arr.map(s.facts, (f) => ({ label: f.label, value: f.value })),
			references: Arr.map(s.references, (r) => ({ label: r.label, url: r.url })),
		},
		report:
			inv.report === null
				? null
				: {
						headline: inv.report.headline ?? null,
						summary: inv.report.summary,
						suspectedCause: inv.report.suspectedCause,
						confidence: inv.report.confidence,
						severityAssessment: inv.report.severityAssessment ?? null,
						affectedScope: inv.report.affectedScope,
						evidence: Arr.map(inv.report.evidence, (e) => ({
							traceIds: e.traceIds,
							logPatterns: e.logPatterns,
							relatedServices: e.relatedServices,
							note: e.note,
						})),
						suggestedActions: inv.report.suggestedActions,
						ruledOut: inv.report.ruledOut ?? [],
						unchecked: inv.report.unchecked ?? [],
						suspectCommit:
							inv.report.suspectCommit === undefined
								? null
								: {
										sha: inv.report.suspectCommit.sha,
										repo: inv.report.suspectCommit.repo ?? null,
									},
					},
		model: inv.model,
		severity: inv.severity,
		confidence: inv.confidence,
		error: inv.error,
		createdAt: inv.createdAt,
		diagnosedAt: inv.diagnosedAt,
		updatedAt: inv.updatedAt,
	}
}

const orUndefined = (value: string | null) => value ?? undefined

const reportBlocks = (report: NonNullable<Output["report"]>): ReadonlyArray<DocBlock> => [
	doc.heading("Diagnosis"),
	doc.fields([
		["Headline", orUndefined(report.headline)],
		["Confidence", report.confidence],
		["Severity", orUndefined(report.severityAssessment)],
		["Affected scope", report.affectedScope],
		[
			"Suspect commit",
			report.suspectCommit === null
				? undefined
				: `${report.suspectCommit.sha}${report.suspectCommit.repo === null ? "" : ` in ${report.suspectCommit.repo}`}`,
		],
	]),
	doc.text(report.summary),
	doc.heading("Suspected cause"),
	doc.text(report.suspectedCause),
	...(report.evidence.length === 0
		? []
		: [
				doc.heading("Evidence"),
				doc.table(
					["Note", "Trace IDs", "Log patterns", "Related services"],
					Arr.map(report.evidence, (e) => [
						e.note,
						Arr.join(e.traceIds, ", "),
						Arr.join(e.logPatterns, "; "),
						Arr.join(e.relatedServices, ", "),
					]),
				),
			]),
	...(report.suggestedActions.length === 0
		? []
		: [doc.heading("Suggested actions"), doc.list(report.suggestedActions)]),
	...(report.ruledOut.length === 0 ? [] : [doc.heading("Ruled out"), doc.list(report.ruledOut)]),
	...(report.unchecked.length === 0 ? [] : [doc.heading("Not checked"), doc.list(report.unchecked)]),
]

const pendingText = (output: Output): string =>
	output.status === "failed"
		? `The investigation failed without a report${output.error === null ? "." : `: ${output.error}`}`
		: output.status === "investigating"
			? "Still investigating: no report yet. Call get_investigation again in a minute."
			: "No report was attached to this investigation."

const nextCalls = (output: Output): ReadonlyArray<NextCall> => {
	const traceId = Arr.head(Arr.flatMap(output.report?.evidence ?? [], (e) => e.traceIds))
	const fingerprint = output.snapshot.fingerprintHash
	const issueId = output.subject.issueId
	return [
		...(Option.isSome(traceId)
			? [doc.next("inspect_trace", { trace_id: traceId.value }, "the first evidence trace")]
			: []),
		...(fingerprint === null
			? []
			: [doc.next("error_detail", { fingerprint }, "sample traces and stack for the error")]),
		...(issueId === null
			? []
			: [
					doc.next("claim_error_issue", { issue_id: issueId }, "take the issue while you fix it"),
					doc.next("list_error_issue_events", { issue_id: issueId }, "the issue's history"),
				]),
	]
}

export function registerGetInvestigationTool(server: McpToolRegistrar) {
	server.define({
		name: "get_investigation",
		title: "Get Investigation",
		description:
			"Read one Maple investigation by id: its status, what it investigated (incident, linked iss_… issue, service, fingerprint, exception, incident window) and the AI diagnosis (suspected cause, evidence traces and log patterns, suggested actions, what was ruled out). Use it on the inv_… id a dashboard prompt hands you before fixing the code.",
		parameters: Schema.Struct({
			investigation_id: P.text(
				"The investigation to read, as handed over by the dashboard: its UUID or its REST id (inv_…)",
			),
		}),
		aliases: { id: "investigation_id" },
		output: GetInvestigationOutput,
		hints: { readOnly: true },
		phrases: ["Reading the investigation"],
		handler: Effect.fn("McpTool.getInvestigation")(function* (params) {
			const tenant = yield* CurrentMcpTenant
			const service = yield* InvestigationService
			const id = yield* decodeInvestigationId(params.investigation_id)
			const inv = yield* service.getInvestigation(tenant.orgId, id).pipe(
				Effect.catchTags({
					"@maple/http/investigations/InvestigationNotFoundError": (error) =>
						Effect.fail(
							new McpInvalidInputError({
								message: `${error.message}. Pass the inv_… id from the dashboard.`,
								parameter: "investigation_id",
							}),
						),
					"@maple/http/investigations/InvestigationPersistenceError": (error) =>
						Effect.fail(
							new McpQueryError({
								message: error.message,
								pipeName: "get_investigation",
								cause: error,
							}),
						),
					"@maple/http/investigations/InvestigationDataCorruptionError": (error) =>
						Effect.fail(
							new McpQueryError({
								message: error.message,
								pipeName: "get_investigation",
								cause: error,
							}),
						),
				}),
			)
			return toInvestigationOutput(inv)
		}),
		render: (output) => {
			const s = output.snapshot
			const exception =
				s.exceptionType === null
					? undefined
					: s.exceptionMessage === null
						? s.exceptionType
						: `${s.exceptionType}: ${s.exceptionMessage}`
			const window =
				s.incidentStartedAt === null
					? undefined
					: `${s.incidentStartedAt} to ${s.incidentEndedAt ?? "ongoing"}`
			return {
				title: `Investigation: ${s.title}`,
				scope: [
					["Investigation", output.id],
					["Status", output.status],
				],
				blocks: [
					doc.fields([
						[
							"Subject",
							output.subject.incidentKind === null
								? output.subject.type
								: `${output.subject.incidentKind} incident`,
						],
						["Incident", orUndefined(output.subject.incidentId)],
						["Issue", orUndefined(output.subject.issueId)],
						["Question", orUndefined(output.subject.prompt)],
						["Pull request", orUndefined(output.subject.pullRequestUrl)],
						["Service", orUndefined(s.serviceName)],
						["Environment", orUndefined(s.deploymentEnv)],
						["Fingerprint", orUndefined(s.fingerprintHash)],
						["Exception", exception],
						["Top frame", orUndefined(s.topFrame)],
						["Incident window", window],
						["Model", orUndefined(output.model)],
						["Created", output.createdAt],
						["Diagnosed", orUndefined(output.diagnosedAt)],
					]),
					...(output.report === null
						? [doc.text(pendingText(output))]
						: reportBlocks(output.report)),
				],
				next: nextCalls(output),
			}
		},
	})
}
