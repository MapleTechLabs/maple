import * as Policy from "@maple/domain/policy"
import { Effect, Option, Schema, Array as Arr, Record as Rec, String as Str } from "effect"
import { aiCreditsUsd } from "@maple/domain/billing"
import { InspectSecurityAuditRunOutput } from "@maple/domain/mcp-outputs"
import { CurrentMcpTenant } from "../lib/query-warehouse"
import * as P from "../lib/params"
import { truncate } from "../lib/format"
import { doc, type NextCall } from "../lib/tool-doc"
import { auditAccess, codeSeverityOf, runSummaryOf, SEVERITY_RANK } from "../lib/security"
import { McpInvalidInputError, McpQueryError, McpUnavailableError, type McpToolRegistrar } from "./types"

const TOOL = "inspect_security_audit_run"
const MAX_UNITS = 40
const MAX_EVENTS = 40

type Output = typeof InspectSecurityAuditRunOutput.Type

const isoOf = (ms: number) => new Date(ms).toISOString()

/** Units the run did not settle first: they are what "what did it skip" asks about. */
const UNIT_ORDER = [
	"blocked",
	"deferred",
	"in_progress",
	"planned",
	"candidate",
	"covered",
	"out_of_scope",
	"not_applicable",
]
const unitRank = (status: string) => {
	const i = UNIT_ORDER.indexOf(status)
	return i === -1 ? UNIT_ORDER.length : i
}

export function registerInspectSecurityAuditRunTool(server: McpToolRegistrar) {
	server.define({
		name: TOOL,
		title: "Inspect Security Audit Run",
		description:
			"One code security audit run in full: its status and why it stopped, the coverage ledger (which parts of the " +
			"codebase it covered, which it deferred, blocked or never reached, with what it could not settle), every claim " +
			"it reported including the ones its verifier rejected and why, and its step log (agents, phases, notes). " +
			"Takes a `run_id` from list_security_audit_runs, or a `repository` for its latest run. Org admins and engineers only.",
		parameters: Schema.Struct({
			run_id: P.optionalText("A run id from list_security_audit_runs"),
			repository: P.optionalText("Instead of run_id: this repository's (owner/name) latest run"),
		}),
		output: InspectSecurityAuditRunOutput,
		hints: { readOnly: true },
		phrases: ["Inspecting a security audit run"],
		handler: Effect.fn("McpTool.inspectSecurityAuditRun")(function* (params) {
			const tenant = yield* CurrentMcpTenant
			if (params.run_id === undefined && params.repository === undefined)
				return yield* new McpInvalidInputError({
					message:
						"Pass a run_id from list_security_audit_runs, or a repository for its latest run.",
					parameter: "run_id",
				})
			const access = yield* auditAccess(tenant)
			if (access._tag !== "read")
				return yield* new McpUnavailableError({
					message: access.message,
					capability: "security_audit",
				})
			if (!access.admin)
				return yield* new McpUnavailableError({
					message: `${Policy.denialFor("security:manage").message} list_security_audit_runs shows a run's status.`,
					capability: "security_audit_admin",
				})
			const { store } = access
			const storeError = (error: { readonly message: string }) =>
				new McpQueryError({
					message: `Could not read the security audit run: ${error.message}`,
					pipeName: "security_audit_store",
				})

			const targets = yield* store.listTargets.pipe(Effect.mapError(storeError))
			const runId = params.run_id
			const found =
				runId !== undefined
					? yield* store.getRun(runId).pipe(Effect.mapError(storeError))
					: yield* Effect.gen(function* () {
							// One target per branch: the repository's latest run is the newest across them.
							const matching = Arr.filter(
								targets,
								(t) =>
									Str.toLowerCase(t.repository) ===
									Str.toLowerCase(params.repository ?? ""),
							)
							if (matching.length === 0)
								return yield* new McpInvalidInputError({
									message: `${params.repository} is not set up for the code audit. Set up: ${Arr.join(
										Arr.map(targets, (t) => t.repository),
										", ",
									)}.`,
									parameter: "repository",
								})
							const pages = yield* Effect.forEach(
								matching,
								(t) => store.listRuns({ targetId: t.id, limit: 1 }),
								{ concurrency: 4 },
							).pipe(Effect.mapError(storeError))
							return Option.fromUndefinedOr(
								Arr.flatten(pages).toSorted((a, b) => b.startedAt - a.startedAt)[0],
							)
						})
			if (Option.isNone(found))
				return yield* new McpInvalidInputError({
					message:
						runId === undefined
							? `${params.repository} has never been audited.`
							: `No audit run ${runId} in this organization; list_security_audit_runs lists them.`,
					parameter: runId === undefined ? "repository" : "run_id",
				})
			const run = found.value
			const { counts, units, findings, events } = yield* Effect.all(
				{
					counts: store.countRunFindings([run.id]),
					units: store.listUnitSummaries(run.id),
					findings: store.listRunFindingViews(run.id),
					events: store.listEvents(run.id, { limit: MAX_EVENTS }),
				},
				{ concurrency: 4 },
			).pipe(Effect.mapError(storeError))

			const byStatus = Arr.reduce(units, Rec.empty<string, number>(), (acc, unit) =>
				Rec.set(acc, unit.status, (acc[unit.status] ?? 0) + 1),
			)
			const ranked = units.toSorted((a, b) =>
				unitRank(a.status) !== unitRank(b.status)
					? unitRank(a.status) - unitRank(b.status)
					: a.wave - b.wave,
			)
			const unsettled = Arr.filter(units, (u) => unitRank(u.status) < unitRank("candidate")).length
			const notes = [
				...((run.status === "incomplete" || run.status === "failed") && unsettled > 0
					? [
							`The run ${run.status === "failed" ? "failed" : "stopped"} (${truncate(run.incompleteReason ?? run.error ?? run.status, 160)}) with ${unsettled} of ${units.length} coverage units not settled: their code was not fully audited, so no finding there is not the same as clear.`,
						]
					: run.status === "in_progress" && unsettled > 0
						? [
								`The run is still in progress: ${unsettled} of ${units.length} coverage units are not settled yet.`,
							]
						: []),
				...(units.length > MAX_UNITS
					? [`Showing ${MAX_UNITS} of ${units.length} coverage units, unsettled ones first.`]
					: []),
				...(units.length === 0 ? ["The run saved no coverage ledger."] : []),
			]
			yield* Effect.annotateCurrentSpan({ orgId: tenant.orgId, "maple.security_audit.run_id": run.id })
			return {
				run: runSummaryOf(
					run,
					targets.find((t) => t.id === run.targetId),
					counts[run.id],
				),
				coverage: {
					total: units.length,
					byStatus,
					units: Arr.map(Arr.take(ranked, MAX_UNITS), (u) => ({
						coverageId: u.coverageId,
						status: u.status,
						subsystem: u.fields?.subsystem ?? null,
						surface: u.fields?.surface ?? null,
						attackClass: u.fields?.attack_class ?? null,
						unresolved:
							u.fields?.unresolved?.[0] === undefined
								? null
								: truncate(u.fields.unresolved[0], 240),
						findings: u.fields?.result_fingerprints ?? [],
					})),
				},
				findings: Arr.map(
					findings.toSorted(
						(a, b) => SEVERITY_RANK[codeSeverityOf(a)] - SEVERITY_RANK[codeSeverityOf(b)],
					),
					(f) => ({
						fingerprint: f.fingerprint,
						title: f.record.title,
						verdict: f.verdict,
						severity: codeSeverityOf(f),
						status: f.status,
						rejectedBecause: f.record.verdict === "rejected" ? f.record.reason : null,
					}),
				),
				events: Arr.map(events, (e) => ({
					at: isoOf(e.at),
					kind: e.kind,
					role: e.role,
					agentId: e.agentId,
					outcome: e.outcome,
					text: truncate(
						Arr.join(
							Arr.filter(
								[
									e.detail?.phase ?? null,
									e.detail?.message ?? null,
									e.detail?.detail ?? null,
								],
								(part): part is string => part !== null && part !== "",
							),
							": ",
						),
						300,
					),
					costUsd:
						e.detail === null || e.detail.costUsd === null
							? null
							: Math.round(aiCreditsUsd(e.detail.costUsd) * 100) / 100,
				})),
				eventsShown: events.length,
				notes,
			} satisfies Output
		}),
		render: (output) => {
			const { run } = output
			const next: Array<NextCall> = []
			const worst = output.findings.find((f) => f.verdict !== "rejected")
			if (worst !== undefined)
				next.push(
					doc.next(
						"inspect_security_finding",
						{ id: worst.fingerprint, repository: run.repository },
						"the worst finding in full",
					),
				)
			next.push(
				doc.next(
					"list_security_audit_runs",
					{ repository: run.repository },
					"every run of this repository",
				),
			)
			return {
				title: `Security audit run ${run.runId}`,
				scope: [
					["Repository", `${run.repository}@${run.branch}`],
					["Commit", run.sourceRef],
					["Kind", run.kind],
					["Status", run.stopReason === null ? run.status : `${run.status} (${run.stopReason})`],
					["Started", run.startedAt],
					[
						"Finished",
						run.finishedAt === null
							? "still running"
							: `${run.finishedAt} (${run.durationMinutes} min)`,
					],
					[
						"Agents",
						run.budget === null
							? String(run.agentInvocations)
							: `${run.agentInvocations} of ${run.budget}`,
					],
					["Cost", run.costUsd === null ? "pending" : `$${run.costUsd.toFixed(2)}`],
				],
				blocks: [
					doc.heading(`Coverage: ${output.coverage.total} units`),
					doc.text(
						Arr.join(
							Arr.map(
								Rec.toEntries(output.coverage.byStatus).toSorted(
									([a], [b]) => unitRank(a) - unitRank(b),
								),
								([status, n]) => `${status} ${n}`,
							),
							", ",
						) || "No coverage ledger.",
					),
					...(output.coverage.units.length === 0
						? []
						: [
								doc.table(
									[
										"Status",
										"Subsystem",
										"Surface",
										"Attack class",
										"Unresolved",
										"Findings",
									],
									Arr.map(output.coverage.units, (u) => [
										u.status,
										u.subsystem ?? "",
										truncate(u.surface ?? "", 100),
										u.attackClass ?? "",
										u.unresolved ?? "",
										Arr.join(u.findings, ", "),
									]),
								),
							]),
					doc.heading("Claims reported"),
					output.findings.length === 0
						? doc.text("The run reported no claims.")
						: doc.table(
								[
									"Severity",
									"Verdict",
									"Status",
									"Finding",
									"Fingerprint",
									"Rejected because",
								],
								Arr.map(output.findings, (f) => [
									f.severity,
									f.verdict,
									// A disproved claim has no triage of its own.
									f.verdict === "rejected" ? "n/a" : f.status,
									truncate(f.title, 120),
									f.fingerprint,
									f.rejectedBecause ?? "",
								]),
							),
					doc.heading(`Log (newest ${output.eventsShown})`),
					output.events.length === 0
						? doc.text("No log events.")
						: doc.table(
								["At", "Kind", "Agent", "Outcome", "What", "Cost"],
								Arr.map(output.events, (e) => [
									e.at.slice(0, 19),
									e.kind,
									Arr.join(
										Arr.filter(
											[e.role, e.agentId],
											(part): part is string => part !== null,
										),
										" ",
									),
									e.outcome ?? "",
									e.text,
									e.costUsd === null ? "" : `$${e.costUsd.toFixed(2)}`,
								]),
							),
					...(output.notes.length === 0 ? [] : [doc.heading("Notes"), doc.list(output.notes)]),
				],
				next,
			}
		},
	})
}
