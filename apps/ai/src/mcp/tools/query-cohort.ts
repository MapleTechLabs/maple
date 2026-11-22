import { Effect, Schema, Array as Arr, String as Str } from "effect"
import {
	funnelStepLabel,
	PathsAnchor,
	RetentionKeyBy,
	type RetentionKeyBy as RetentionKeyByType,
} from "@maple/query-model"
import { productEventsCohort } from "@maple/query-engine/observability"
import { McpInvalidInputError, type McpToolRegistrar } from "./types"
import { warehouseToMcpHandlers } from "../lib/map-warehouse-error"
import { withTenantExecutor } from "../lib/query-warehouse"
import { CurrentMcpTenant } from "../tenant"
import { MCP_PRODUCT_EVENTS_MAX_HOURS } from "../lib/time"
import { formatNumber, formatPercent, truncate } from "../lib/format"
import { stringifyJson } from "../lib/json"
import * as P from "../lib/params"
import { doc } from "../lib/tool-doc"

const TOOL = "query_cohort"
const WINDOW = P.timeWindow({ defaultHours: 7 * 24, maxHours: MCP_PRODUCT_EVENTS_MAX_HOURS })
const MAX_MEMBERS = 200

const KEY_BY_NOUN = {
	person: "persons",
	visitor: "visitors",
	user: "users",
	group: "groups",
} satisfies Record<RetentionKeyByType, string>

const STEP_EXAMPLE = '{"kind":"event","eventName":"workspace_created"}'

/** `2026-11-15 17:35:00.000000000` as the seconds a reader wants. */
const toSeconds = (timestamp: string): string => Str.slice(0, 19)(timestamp)

export function registerQueryCohortTool(server: McpToolRegistrar) {
	server.define({
		name: TOOL,
		title: "Query Cohort",
		description:
			'The people (or accounts, with `key_by="group"`) who did one event or page view in the window and, optionally, did not do another: how many, out of how many who did the first, and who. ' +
			'Answers "which users created a workspace and never a project" and "which accounts started checkout and did not pay". ' +
			'`did_not_scope` says whether "did not" means never (the default) or not in this window. Open a member with `inspect_user`; for the order of several steps use `query_funnel`.',
		parameters: Schema.Struct({
			did_json: P.json(
				PathsAnchor,
				`What a member did inside the window, as JSON: {kind:"event", eventName, attributeEquals?} or {kind:"page", pagePath, host?} (pagePath exact, or with * as a wildcard). Example: ${STEP_EXAMPLE}`,
			),
			did_not_json: P.optionalJson(
				PathsAnchor,
				"What a member did NOT do, in the same form. Without it the cohort is everyone who did `did_json`.",
			),
			did_not_scope: P.optionalOneOf(
				["ever", "window"],
				"`ever` (default): never did it, in all stored history up to end_time. `window`: did not do it between start_time and end_time.",
			),
			key_by: P.optionalOneOf(
				RetentionKeyBy.literals,
				"Who is counted: `person` (default: user id when known, else the visitor's linked user, else the visitor), `user`, `visitor`, or `group` (the account or team).",
			),
			limit: P.limit({
				default: 25,
				max: MAX_MEMBERS,
				noun: "members to list (the totals count everyone)",
			}),
			...WINDOW.fields,
		}),
		untrustedOutput: true,
		hints: { readOnly: true },
		phrases: ["Building a cohort", "Finding who did it"],
		handler: Effect.fn("McpTool.queryCohort")(function* (params) {
			const { st, et } = yield* WINDOW.resolve(params, TOOL)
			const did = params.did_json
			const didNot = params.did_not_json
			const keyBy = params.key_by ?? "person"
			const didNotScope = params.did_not_scope ?? "ever"
			if (Str.trim(did.kind === "event" ? did.eventName : did.pagePath) === "") {
				return yield* new McpInvalidInputError({
					message: "did_json needs an event name or a page path.",
					parameter: "did_json",
					example: STEP_EXAMPLE,
				})
			}

			const tenant = yield* CurrentMcpTenant
			yield* Effect.annotateCurrentSpan({
				orgId: tenant.orgId,
				"maple.ai.key_by": keyBy,
				"maple.ai.did_not_scope": didNot === undefined ? "none" : didNotScope,
			})

			const rows = yield* withTenantExecutor(
				productEventsCohort({
					did,
					...(didNot === undefined ? undefined : { didNot }),
					didNotScope,
					keyBy,
					limit: params.limit,
					startTime: st,
					endTime: et,
				}),
			).pipe(
				Effect.catchTags(warehouseToMcpHandlers(TOOL)),
				// The limit is clamped by its parameter, so the builder has nothing left to reject.
				Effect.catchTag("@maple/query-engine/ProductEventsCohortError", (error) =>
					Effect.fail(new McpInvalidInputError({ message: error.message, parameter: "limit" })),
				),
			)
			yield* Effect.annotateCurrentSpan("result.rowCount", rows.length)

			// The totals ride on every row, so an empty cohort has none: read who did it at all
			// from the same query without the exclusion, which is then the whole answer.
			const didTotal =
				rows.length > 0 || didNot === undefined
					? (rows[0]?.didTotal ?? 0)
					: yield* withTenantExecutor(
							productEventsCohort({
								did,
								didNotScope,
								keyBy,
								limit: 1,
								startTime: st,
								endTime: et,
							}),
						).pipe(
							Effect.map((all) => all[0]?.didTotal ?? 0),
							Effect.catchTags(warehouseToMcpHandlers(TOOL)),
							Effect.catchTag("@maple/query-engine/ProductEventsCohortError", () =>
								Effect.succeed(0),
							),
						)

			return {
				timeRange: { start: st, end: et },
				keyBy,
				did,
				...(didNot === undefined ? undefined : { didNot, didNotScope }),
				didTotal,
				total: rows[0]?.total ?? 0,
				limit: params.limit,
				members: Arr.map(rows, (row) => ({
					id: row.key,
					firstAt: toSeconds(row.firstAt),
					lastAt: toSeconds(row.lastAt),
					count: row.count,
				})),
			}
		}),
		render: (output) => {
			const noun = KEY_BY_NOUN[output.keyBy]
			const didLabel = funnelStepLabel(output.did)
			const notLabel = output.didNot === undefined ? undefined : funnelStepLabel(output.didNot)
			const window = { start_time: output.timeRange.start, end_time: output.timeRange.end }
			const never = output.didNotScope === "window" ? "did not do, in the window," : "never did"
			const summary =
				notLabel === undefined
					? `**${formatNumber(output.total)} ${noun}** did ${didLabel}.`
					: `**${formatNumber(output.total)} of the ${formatNumber(output.didTotal)} ${noun}** who did ${didLabel} ${never} ${notLabel}${
							output.didTotal === 0
								? "."
								: ` (${formatPercent(output.total / output.didTotal)}).`
						}`
			const first = output.members[0]
			const opensUsers = output.keyBy === "user" || output.keyBy === "person"
			return {
				title:
					notLabel === undefined
						? `Cohort: did ${truncate(didLabel, 50)} (by ${output.keyBy})`
						: `Cohort: did ${truncate(didLabel, 40)}, not ${truncate(notLabel, 40)} (by ${output.keyBy})`,
				scope: [
					["Time range", `${output.timeRange.start} to ${output.timeRange.end}`],
					[
						"Did not",
						notLabel === undefined
							? undefined
							: output.didNotScope === "window"
								? "inside the window"
								: "ever, up to the end of the window",
					],
				],
				...(output.didTotal === 0
					? {
							empty: {
								message: `No ${noun} did ${didLabel} in this window.`,
								hints: [
									"Widen start_time/end_time, or check the name against `list_product_events`.",
									...(output.keyBy === "person"
										? []
										: [
												`key_by="${output.keyBy}" leaves out events that carry no such id; try key_by="person".`,
											]),
								],
							},
						}
					: undefined),
				blocks:
					output.didTotal === 0
						? []
						: [
								doc.text(summary),
								...(output.members.length === 0
									? []
									: [
											doc.table(
												[output.keyBy, "Times", "First", "Last"],
												Arr.map(output.members, (member) => [
													truncate(member.id, 60),
													formatNumber(member.count),
													member.firstAt,
													member.lastAt,
												]),
											),
										]),
								...(output.total > output.members.length
									? [
											doc.text(
												`Listing the ${formatNumber(output.members.length)} who did it last; raise \`limit\` (max ${MAX_MEMBERS}) for more.`,
											),
										]
									: []),
							],
				next: [
					...(first !== undefined && opensUsers
						? [
								doc.next(
									"inspect_user",
									{ user_id: first.id, ...window },
									"see what one of them did",
								),
							]
						: []),
					...(output.didNot === undefined
						? []
						: [
								doc.next(
									"query_funnel",
									{
										steps_json: stringifyJson([output.did, output.didNot]),
										key_by: output.keyBy,
										...window,
									},
									"the conversion between the two, in order",
								),
							]),
				],
			}
		},
	})
}
