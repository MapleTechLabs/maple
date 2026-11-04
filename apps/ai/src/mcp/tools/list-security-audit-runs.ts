import { Clock, DateTime, Effect, Option, Schema, Array as Arr, String as Str } from "effect"
import { ListSecurityAuditRunsOutput } from "@maple/domain/mcp-outputs"
import { securityAuditSpendWindow } from "@maple/domain/security-audit"
import { securityAuditLimits } from "@maple/backend/services/security-audit/limits"
import { CurrentMcpTenant } from "../lib/query-warehouse"
import * as P from "../lib/params"
import { doc, type NextCall } from "../lib/tool-doc"
import { auditAccess, runSummaryOf } from "../lib/security"
import { McpQueryError, McpUnavailableError, type McpToolRegistrar } from "./types"

const TOOL = "list_security_audit_runs"
const RUN_STATUSES = ["in_progress", "complete", "incomplete", "failed"] as const
/** Runs counted per target; a target with more shows `100+`. */
const RUN_COUNT_CAP = 100

type Output = typeof ListSecurityAuditRunsOutput.Type

const isoOf = (ms: number) => new Date(ms).toISOString()
const usd = (n: number) => `$${n.toFixed(2)}`

export function registerListSecurityAuditRunsTool(server: McpToolRegistrar) {
	server.define({
		name: TOOL,
		title: "List Security Audit Runs",
		description:
			"Code security audit runs, newest first: repository, commit, status, when it started and finished, why it stopped " +
			"short (e.g. org_spend_limit_reached), agent invocations, cost and what each reported. Also the org's audit spend " +
			"this month against its monthly limit, and the repositories set up for the audit. " +
			"inspect_security_audit_run shows one run's coverage, every claim it reported (rejected ones too) and its step log.",
		parameters: Schema.Struct({
			repository: P.optionalText("Only runs of this repository (owner/name)"),
			status: P.optionalOneOf(RUN_STATUSES, "Only runs in this state"),
			limit: P.limit({ default: 20, max: 100, noun: "runs" }),
		}),
		output: ListSecurityAuditRunsOutput,
		hints: { readOnly: true },
		phrases: ["Reading security audit runs"],
		handler: Effect.fn("McpTool.listSecurityAuditRuns")(function* (params) {
			const tenant = yield* CurrentMcpTenant
			const access = yield* auditAccess(tenant)
			if (access._tag !== "read")
				return yield* new McpUnavailableError({
					message: access.message,
					capability: "security_audit",
				})
			const { store, admin } = access
			const read = Effect.gen(function* () {
				const targets = yield* store.listTargets
				const wanted = Arr.filter(
					targets,
					(t) =>
						params.repository === undefined ||
						Str.toLowerCase(t.repository) === Str.toLowerCase(params.repository),
				)
				const statuses = params.status === undefined ? undefined : { statuses: Arr.of(params.status) }
				// A repository can have one target per branch: page each, so a busier target elsewhere cannot crowd them out.
				const pages =
					params.repository === undefined
						? [yield* store.listRuns({ ...statuses, limit: params.limit })]
						: yield* Effect.forEach(
								wanted,
								(t) => store.listRuns({ targetId: t.id, ...statuses, limit: params.limit }),
								{ concurrency: 4 },
							)
				const kept = Arr.take(
					Arr.flatten(pages).toSorted((a, b) => b.startedAt - a.startedAt),
					params.limit,
				)
				// Members may list runs but not read what they reported, as in the dashboard.
				const counts = admin
					? yield* store.countRunFindings(Arr.map(kept, (run) => run.id))
					: undefined
				// Counted per target, so one busy target cannot push another's runs off a shared page.
				const runCounts = yield* Effect.forEach(
					wanted,
					(t) =>
						store
							.listRuns({ targetId: t.id, limit: RUN_COUNT_CAP })
							.pipe(Effect.map((rows) => [t.id, rows.length] as const)),
					{ concurrency: 4 },
				)
				const perTarget = new Map(runCounts)
				const now = yield* Clock.currentTimeMillis
				const window = securityAuditSpendWindow(now)
				const spentUsd = yield* store.orgSpendUsd(window.since)
				const settings = yield* store.getSettings
				const limits = yield* securityAuditLimits
				return { targets, wanted, kept, counts, perTarget, now, window, spentUsd, settings, limits }
			}).pipe(
				Effect.mapError(
					(error) =>
						new McpQueryError({
							message: `Could not read security audit runs: ${error.message}`,
							pipeName: "security_audit_store",
						}),
				),
			)
			const { targets, wanted, kept, counts, perTarget, now, window, spentUsd, settings, limits } =
				yield* read
			const runs = Arr.map(kept, (run) =>
				runSummaryOf(
					run,
					targets.find((t) => t.id === run.targetId),
					counts?.[run.id],
				),
			)
			const limitUsd = Option.match(settings, {
				onNone: () => limits.defaultMonthlySpendLimitUsd,
				onSome: (row) => row.monthlySpendLimitUsd,
			})
			const notes = [
				...(params.repository !== undefined && wanted.length === 0
					? [
							`${params.repository} is not set up for the code audit (Security → Add target). Set up: ${Arr.join(
								Arr.map(targets, (t) => t.repository),
								", ",
							)}.`,
						]
					: []),
				...Arr.flatMap(wanted, (t) =>
					(perTarget.get(t.id) ?? 0) > 0
						? []
						: [`${t.repository}@${t.branch} has never been audited.`],
				),
				...(spentUsd >= limitUsd
					? [
							`The org has reached its monthly audit spend limit (${usd(spentUsd)} of ${usd(limitUsd)}): running audits stop and new ones are refused until ${isoOf(window.resetsAt).slice(0, 10)} or an admin raises the limit.`,
						]
					: []),
				...(admin ? [] : ["Only org admins see what each run reported."]),
			]
			yield* Effect.annotateCurrentSpan({ orgId: tenant.orgId, "result.rowCount": runs.length })
			return {
				generatedAt: DateTime.formatIso(DateTime.makeUnsafe(now)),
				filters: {
					...(params.repository === undefined ? undefined : { repository: params.repository }),
					...(params.status === undefined ? undefined : { status: params.status }),
				},
				spend: {
					spentUsd: Math.round(spentUsd * 100) / 100,
					monthlyLimitUsd: limitUsd,
					since: isoOf(window.since),
					resetsAt: isoOf(window.resetsAt),
				},
				targets: Arr.map(wanted, (t) => ({
					repository: t.repository,
					branch: t.branch,
					enabled: t.enabled,
					profile: t.profile,
					runs: perTarget.get(t.id) ?? 0,
				})),
				runs,
				notes,
			} satisfies Output
		}),
		render: (output) => {
			const latest = output.runs[0]
			const next: Array<NextCall> = []
			if (latest !== undefined)
				next.push(
					doc.next(
						"inspect_security_audit_run",
						{ run_id: latest.runId },
						"the latest run's coverage, claims and log",
					),
				)
			const unfinished = output.runs.find((run) => run.status !== "complete" && run !== latest)
			if (unfinished !== undefined)
				next.push(
					doc.next(
						"inspect_security_audit_run",
						{ run_id: unfinished.runId },
						`what the ${unfinished.status} run covered`,
					),
				)
			return {
				title: "Security audit runs",
				scope: [
					["Repository", output.filters.repository],
					["Status", output.filters.status],
					[
						"Spend this month",
						`${usd(output.spend.spentUsd)} of ${usd(output.spend.monthlyLimitUsd)} (resets ${output.spend.resetsAt.slice(0, 10)})`,
					],
				],
				blocks: [
					...(output.targets.length === 0
						? []
						: [
								doc.table(
									["Repository", "Branch", "Enabled", "Profile", "Runs"],
									Arr.map(output.targets, (t) => [
										t.repository,
										t.branch,
										t.enabled ? "yes" : "no",
										t.profile,
										t.runs >= RUN_COUNT_CAP ? `${RUN_COUNT_CAP}+` : String(t.runs),
									]),
								),
							]),
					output.runs.length === 0
						? doc.text("No audit run matches.")
						: doc.table(
								[
									"Run",
									"Repository",
									"Kind",
									"Status",
									"Commit",
									"Started",
									"Took",
									"Stopped because",
									"Agents",
									"Cost",
									"Reported (crit/high/med/low/info, leads, rejected)",
								],
								Arr.map(output.runs, (run) => [
									run.runId,
									`${run.repository}@${run.branch}`,
									run.kind,
									run.status,
									Str.slice(0, 12)(run.sourceRef),
									run.startedAt.slice(0, 16),
									run.durationMinutes === null ? "running" : `${run.durationMinutes} min`,
									run.stopReason ?? "",
									run.budget === null
										? String(run.agentInvocations)
										: `${run.agentInvocations} of ${run.budget}`,
									run.costUsd === null ? "pending" : usd(run.costUsd),
									run.findings === null
										? "admins only"
										: `${run.findings.critical}/${run.findings.high}/${run.findings.medium}/${run.findings.low}/${run.findings.informational}, ${run.findings.leads}, ${run.findings.rejected}`,
								]),
							),
					...(output.notes.length === 0 ? [] : [doc.heading("Notes"), doc.list(output.notes)]),
				],
				next,
			}
		},
	})
}
