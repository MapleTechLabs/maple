/**
 * Ingest rules: drop or redact telemetry before Maple stores or bills it. Anyone may list and
 * preview them; creating, changing and deleting is admin-only, like the REST routes, since a
 * rule rewrites or discards the whole organization's incoming data.
 */
import { Effect, Schema } from "effect"
import {
	DeleteIngestRuleOutput,
	IngestRuleMutationOutput,
	ListIngestRulesOutput,
	PreviewIngestRuleOutput,
	type IngestRuleRow,
} from "@maple/domain/mcp-outputs"
import {
	decodePublicId,
	encodePublicId,
	fromV2IngestRuleAction,
	PublicIdPrefixes,
	toV2IngestRuleAction,
	V2IngestRuleAction,
} from "@maple/domain/http/v2"
import {
	IngestRuleCondition,
	IngestRuleSignal,
	ingestRuleProblems,
	summarizeIngestRule,
	type IngestRule,
	type IngestRuleSpec,
} from "@maple/domain/ingest-rules"
import { IngestRuleValidationError, type SelfDescribingHttpError } from "@maple/domain/http"
import type { ListLogsOutput } from "@maple/domain/tinybird"
import type { OrgId } from "@maple/domain/primitives"
import { requireAdmin } from "@maple/backend/services/auth/auth"
import { IngestRuleService } from "@maple/backend/services/org/IngestRuleService"
import { provideWarehouseExecutorFromTenant } from "@maple/backend/services/warehouse/WarehouseQueryService"
import { WarehouseExecutor } from "@maple/query-engine/observability"
import {
	applyRules,
	compileRules,
	logSampleToRecord,
	spanSampleToRecord,
	type AttrMap,
	type RuleRecord,
} from "@maple/ingest-rules"
import { McpInvalidInputError, McpUnavailableError, type McpToolRegistrar } from "./types"
import { CurrentMcpTenant } from "../lib/query-warehouse"
import { toMcpHttpError } from "../lib/map-http-error"
import { toMcpQueryError } from "../lib/map-warehouse-error"
import { truncate } from "../lib/format"
import * as P from "../lib/params"
import { doc } from "../lib/tool-doc"

const SIGNALS = IngestRuleSignal.literals
const PREVIEW_WINDOW = P.timeWindow({ defaultHours: 1, maxHours: 24 })
const PREVIEW_SALT = "preview"

const adminOnly = (tool: string) =>
	Effect.gen(function* () {
		const tenant = yield* CurrentMcpTenant
		yield* requireAdmin(
			tenant.roles,
			() =>
				new McpUnavailableError({
					message: `${tool} changes the organization's ingest rules, which only org admins may do. Ask an admin, or change it in Settings → Ingestion.`,
					capability: "org_admin",
				}),
		)
		return tenant
	})

/** Validation failures name the parameter, so the model can fix the call. */
/** The tool parameter a validator problem is about, so the model knows which argument to fix. */
export const parameterOfProblem = (problem: string): string => {
	if (problem.startsWith("condition ") || problem.includes("needs at least one condition"))
		return "conditions"
	if (problem.includes("signal")) return "signals"
	if (problem.startsWith("the name")) return "name"
	if (problem.startsWith("position")) return "position"
	return "action"
}

const isValidationError = Schema.is(IngestRuleValidationError)

const toMcpRuleError = (tool: string) => (error: SelfDescribingHttpError) =>
	isValidationError(error)
		? new McpInvalidInputError({
				message: error.message,
				parameter: parameterOfProblem(error.problems[0] ?? ""),
			})
		: toMcpHttpError(tool)(error)

const toRow = (rule: IngestRule): IngestRuleRow => ({
	id: encodePublicId(PublicIdPrefixes.ingestRule, rule.id),
	name: rule.name,
	enabled: rule.enabled,
	position: rule.position,
	signals: rule.spec.signals,
	conditions: rule.spec.conditions,
	action: toV2IngestRuleAction(rule.spec.action),
	summary: summarizeIngestRule(rule.spec),
})

/** A rule by its id, REST id (`irule_…`) or exact name. */
const resolveRule = Effect.fnUntraced(function* (tool: string, orgId: OrgId, ref: string) {
	const service = yield* IngestRuleService
	const rules = yield* service.list(orgId).pipe(Effect.mapError(toMcpHttpError(tool)))
	const id = decodePublicId(PublicIdPrefixes.ingestRule, ref.trim()) ?? ref.trim()
	const matches = rules.filter((rule) => rule.id === id || rule.name === ref.trim())
	const [rule] = matches
	if (rule === undefined) {
		return yield* new McpInvalidInputError({
			message: `No ingest rule named "${ref}". list_ingest_rules lists them.`,
			parameter: "rule",
		})
	}
	if (matches.length > 1) {
		return yield* new McpInvalidInputError({
			message: `${matches.length} ingest rules match "${ref}"; pass one's id instead: ${matches
				.map(toRow)
				.map((row) => row.id)
				.join(", ")}.`,
			parameter: "rule",
		})
	}
	return rule
})

const decodeSignals = (raw: ReadonlyArray<string>) =>
	Schema.decodeUnknownEffect(Schema.Array(IngestRuleSignal))(raw).pipe(
		Effect.mapError(
			() =>
				new McpInvalidInputError({
					message: `signals are ${SIGNALS.join(", ")}.`,
					parameter: "signals",
				}),
		),
	)

const conditionsParam = P.optionalJson(
	Schema.Array(IngestRuleCondition),
	'Conditions that must all match, e.g. [{"field":"severity","op":"lt","value":"info"}] or [{"field":"attribute","key":"http.route","op":"in","values":["/health"]}]. Fields: service_name, name, attribute, resource_attribute, body, severity, span_kind, span_status. Ops: eq, neq, in, not_in, prefix, contains, regex, exists, not_exists, lt, gte (severity). Empty matches every record (redact rules only).',
)
const actionDescription =
	'What to do: {"type":"drop","keep_percent":0} or {"type":"redact","keys":["*password*"],"detectors":["email","credit_card","jwt","api_token","ipv4","ipv6","phone","iban"],"patterns":["ORD-[0-9]+"],"scopes":["attributes","resource","events","body"],"method":"mask"|"hash"|"remove"}.'

const SPEC_FIELDS = {
	signals: P.list(`Signals the rule applies to: ${SIGNALS.join(", ")}`),
	conditions: conditionsParam,
	action: P.json(V2IngestRuleAction, actionDescription),
}

const renderRule = (title: string, row: IngestRuleRow) => ({
	title,
	blocks: [
		doc.fields([
			["ID", row.id],
			["Name", row.name],
			["Enabled", row.enabled ? "yes" : "no"],
			["Rule", row.summary],
		]),
		doc.text("Applies to new data within 30 seconds. Data already stored is unchanged."),
	],
	next: [doc.next("preview_ingest_rule", { rule: row.id }, "what the rule does to recent data")],
})

// PREVIEW

const parseAttributes = (raw: string): Effect.Effect<Readonly<Record<string, string>>> =>
	Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Record(Schema.String, Schema.String)))(raw).pipe(
		Effect.orElseSucceed(() => ({})),
	)

const sampleRecords = Effect.fnUntraced(function* (
	signal: "traces" | "logs",
	window: { readonly st: string; readonly et: string },
	service: string | undefined,
	limit: number,
) {
	const executor = yield* WarehouseExecutor
	const params = {
		start_time: window.st,
		end_time: window.et,
		limit,
		offset: 0,
		...(service === undefined ? undefined : { service }),
	}
	if (signal === "logs") {
		const result = yield* executor.query<ListLogsOutput>("list_logs", params, { profile: "list" })
		return yield* Effect.forEach(result.data, (row) =>
			Effect.all({
				logAttributes: parseAttributes(row.logAttributes),
				resourceAttributes: parseAttributes(row.resourceAttributes),
			}).pipe(Effect.map((attributes) => logSampleToRecord({ ...row, ...attributes }))),
		)
	}
	const result = yield* executor.query<{
		readonly serviceName: string
		readonly spanName: string
		readonly statusCode: string
		readonly traceId: string
		readonly spanAttributes?: Record<string, string>
		readonly resourceAttributes?: Record<string, string>
	}>("span_search", params, { profile: "list" })
	return result.data.map((row) =>
		spanSampleToRecord({
			...row,
			spanAttributes: row.spanAttributes ?? {},
			resourceAttributes: row.resourceAttributes ?? {},
		}),
	)
})

/** `key: before -> after` for every top-level value a rule changed. */
const changedValues = (before: RuleRecord, after: RuleRecord): ReadonlyArray<string> => {
	const diff = (scope: string, a: AttrMap, b: AttrMap) =>
		Object.entries(a).flatMap(([key, value]) => {
			const next = b[key]
			if (next === undefined) return [`${scope}${key}: removed`]
			return JSON.stringify(next) === JSON.stringify(value)
				? []
				: [`${scope}${key}: ${truncate(String(value), 60)} -> ${truncate(String(next), 60)}`]
		})
	const body =
		before.body !== undefined && JSON.stringify(before.body) !== JSON.stringify(after.body)
			? [`body: ${truncate(String(after.body), 120)}`]
			: []
	return [
		...diff("", before.attributes, after.attributes),
		...diff("resource.", before.resource, after.resource),
		...body,
	]
}

const recordLabel = (record: RuleRecord) =>
	truncate(record.name ?? (typeof record.body === "string" ? record.body : ""), 80)
const recordService = (record: RuleRecord) => {
	const service = record.resource["service.name"]
	return typeof service === "string" ? service : ""
}

/** What one rule does to sampled records: counts plus a few examples of each outcome. */
export const previewOver = (spec: IngestRuleSpec, records: ReadonlyArray<RuleRecord>) => {
	const compiled = compileRules([spec], PREVIEW_SALT)
	const outcomes = records.map((record, index) => ({
		record,
		// Records without a trace id sample at random in the gateway; a fixed draw keeps answers stable.
		outcome: applyRules(compiled, record, () => (((index * 0.618_033_988_75) % 1) + 1) % 1),
	}))
	const dropped = outcomes.filter(({ outcome }) => outcome._tag === "dropped")
	const redacted = outcomes.flatMap(({ record, outcome }) =>
		outcome._tag === "kept" && outcome.redactions.size > 0 ? [{ record, outcome }] : [],
	)
	return {
		sampled: records.length,
		dropped: dropped.length,
		redactedRecords: redacted.length,
		redactedValues: redacted.reduce(
			(total, { outcome }) => total + [...outcome.redactions.values()].reduce((a, b) => a + b, 0),
			0,
		),
		examples: [
			...dropped.slice(0, 3).map(({ record }) => ({
				service: recordService(record),
				label: recordLabel(record),
				outcome: "dropped" as const,
				changes: [],
			})),
			...redacted.slice(0, 5).map(({ record, outcome }) => ({
				service: recordService(record),
				label: recordLabel(record),
				outcome: "redacted" as const,
				changes: changedValues(record, outcome.record),
			})),
		],
	}
}

export function registerIngestRuleTools(server: McpToolRegistrar) {
	server.define({
		name: "list_ingest_rules",
		title: "List Ingest Rules",
		description:
			"The organization's ingest rules: what telemetry is dropped or redacted before Maple stores or bills it, in the order they run (drop rules first, then redact rules by position).",
		parameters: Schema.Struct({}),
		output: ListIngestRulesOutput,
		hints: { readOnly: true, destructive: false, idempotent: true },
		phrases: ["Listing ingest rules"],
		handler: Effect.fn("McpTool.listIngestRules")(function* () {
			const tenant = yield* CurrentMcpTenant
			const service = yield* IngestRuleService
			const rules = yield* service
				.list(tenant.orgId)
				.pipe(Effect.mapError(toMcpHttpError("list_ingest_rules")))
			yield* Effect.annotateCurrentSpan({ orgId: tenant.orgId, "result.rowCount": rules.length })
			return { rules: rules.map(toRow) }
		}),
		render: (output) => ({
			title: "Ingest Rules",
			...(output.rules.length === 0
				? {
						empty: {
							message:
								"This organization has no ingest rules; all telemetry is stored as sent.",
							hints: [
								"create_ingest_rule adds one (org admins only); preview_ingest_rule tries one first.",
							],
						},
					}
				: undefined),
			blocks:
				output.rules.length === 0
					? []
					: [
							doc.table(
								["ID", "Name", "On", "Rule"],
								output.rules.map((row) => [
									row.id,
									row.name,
									row.enabled ? "yes" : "no",
									row.summary,
								]),
							),
						],
		}),
	})

	server.define({
		name: "preview_ingest_rule",
		title: "Preview Ingest Rule",
		description:
			"Run an ingest rule (an existing one by `rule`, or a draft from signals/conditions/action) over recent stored traces or logs and report how many records it would drop or redact, with examples. Changes nothing. Recent data may already be redacted by existing rules; metrics are not previewed.",
		parameters: Schema.Struct({
			rule: P.optionalText("An existing rule's name or id (list_ingest_rules lists them)"),
			signals: P.optionalList(`Draft: signals, ${SIGNALS.join(", ")}`),
			conditions: conditionsParam,
			action: P.optionalJson(V2IngestRuleAction, `Draft: ${actionDescription}`),
			signal: P.optionalOneOf(
				["traces", "logs"],
				"Which signal to sample; defaults to the rule's first of traces/logs",
			),
			service: P.service("Only sample this service"),
			...PREVIEW_WINDOW.fields,
			limit: P.limit({ default: 200, max: 500, noun: "sample records" }),
		}),
		aliases: P.SERVICE_ALIASES,
		output: PreviewIngestRuleOutput,
		hints: { readOnly: true, destructive: false, idempotent: true },
		phrases: ["Previewing an ingest rule"],
		handler: Effect.fn("McpTool.previewIngestRule")(function* (params) {
			const tenant = yield* CurrentMcpTenant
			const spec: IngestRuleSpec =
				params.rule !== undefined
					? (yield* resolveRule("preview_ingest_rule", tenant.orgId, params.rule)).spec
					: params.signals !== undefined && params.action !== undefined
						? {
								signals: yield* decodeSignals(params.signals),
								conditions: params.conditions ?? [],
								action: fromV2IngestRuleAction(params.action),
							}
						: yield* new McpInvalidInputError({
								message: "Pass `rule`, or a draft with `signals` and `action`.",
								parameter: "rule",
							})
			const signal = params.signal ?? spec.signals.find((s) => s === "traces" || s === "logs")
			// Stored spans in the search results carry no span kind, so such a condition would miscount.
			const problems = [
				...ingestRuleProblems(spec),
				...(signal === "traces" &&
				spec.conditions.some((condition) => condition.field === "span_kind")
					? [
							"span_kind conditions cannot be previewed here; use the preview in Settings > Ingestion",
						]
					: []),
			]
			if (signal === undefined || problems.length > 0) {
				return {
					signal: signal ?? spec.signals[0] ?? "logs",
					sampled: 0,
					dropped: 0,
					redactedRecords: 0,
					redactedValues: 0,
					examples: [],
					problems:
						signal === undefined ? [...problems, "metrics rules cannot be previewed"] : problems,
				}
			}
			const window = yield* PREVIEW_WINDOW.resolve(params, "preview_ingest_rule")
			const records = yield* sampleRecords(signal, window, params.service, params.limit).pipe(
				provideWarehouseExecutorFromTenant(tenant),
				Effect.mapError(toMcpQueryError("preview_ingest_rule")),
			)
			yield* Effect.annotateCurrentSpan({ orgId: tenant.orgId, "result.rowCount": records.length })
			return { signal, ...previewOver(spec, records), problems: [] }
		}),
		render: (output) => ({
			title: "Ingest Rule Preview",
			blocks: [
				...(output.problems.length > 0
					? [doc.text(`Not previewed: ${output.problems.join("; ")}.`)]
					: []),
				doc.text(
					`Of ${output.sampled} recent ${output.signal} records, ${output.dropped} would be dropped and ${output.redactedRecords} redacted (${output.redactedValues} values). Hashes use a preview key and differ from stored ones.`,
				),
				...(output.examples.length === 0
					? []
					: [
							doc.table(
								["Outcome", "Service", "Record", "Changes"],
								output.examples.map((example) => [
									example.outcome,
									example.service,
									example.label,
									example.changes.join("; ") || "-",
								]),
							),
						]),
			],
		}),
	})

	server.define({
		name: "create_ingest_rule",
		title: "Create Ingest Rule",
		description:
			"Add a rule that drops or redacts telemetry before Maple stores or bills it. Dropped data is never billed. Drop rules need at least one condition. Preview with preview_ingest_rule first. Admin only. Applies to new data within 30 seconds.",
		parameters: Schema.Struct({
			name: P.text("A label for the rule"),
			...SPEC_FIELDS,
			enabled: P.optionalFlag("Start disabled with false; default true"),
			position: P.optionalNumber("Run order among redact rules; default after the last rule"),
		}),
		output: IngestRuleMutationOutput,
		hints: { readOnly: false, destructive: false, idempotent: false },
		phrases: ["Adding an ingest rule"],
		handler: Effect.fn("McpTool.createIngestRule")(function* (params) {
			const tenant = yield* adminOnly("create_ingest_rule")
			const service = yield* IngestRuleService
			const created = yield* service
				.create(tenant.orgId, {
					name: params.name,
					enabled: params.enabled,
					position: params.position,
					spec: {
						signals: yield* decodeSignals(params.signals),
						conditions: params.conditions ?? [],
						action: fromV2IngestRuleAction(params.action),
					},
				})
				.pipe(Effect.mapError(toMcpRuleError("create_ingest_rule")))
			return { action: "created" as const, rule: toRow(created) }
		}),
		render: (output) => renderRule("Ingest rule created", output.rule),
	})

	server.define({
		name: "update_ingest_rule",
		title: "Update Ingest Rule",
		description:
			"Change an ingest rule: turn it off (enabled=false) or on, rename it, move it (position), or replace its signals, conditions or action. Fields left out keep their value. Admin only.",
		parameters: Schema.Struct({
			rule: P.text("The rule's name or id (list_ingest_rules lists them)"),
			name: P.optionalText("A new name"),
			enabled: P.optionalFlag("false turns the rule off, true turns it on"),
			position: P.optionalNumber("New run order among redact rules"),
			signals: P.optionalList(`Replaces the signals: ${SIGNALS.join(", ")}`),
			conditions: conditionsParam,
			action: P.optionalJson(V2IngestRuleAction, `Replaces the action: ${actionDescription}`),
		}),
		output: IngestRuleMutationOutput,
		hints: { readOnly: false, destructive: false, idempotent: true },
		phrases: ["Updating an ingest rule"],
		handler: Effect.fn("McpTool.updateIngestRule")(function* (params) {
			const tenant = yield* adminOnly("update_ingest_rule")
			const current = yield* resolveRule("update_ingest_rule", tenant.orgId, params.rule)
			const service = yield* IngestRuleService
			const specChanged =
				params.signals !== undefined || params.conditions !== undefined || params.action !== undefined
			const updated = yield* service
				.update(tenant.orgId, current.id, {
					name: params.name,
					enabled: params.enabled,
					position: params.position,
					spec: specChanged
						? {
								signals:
									params.signals === undefined
										? current.spec.signals
										: yield* decodeSignals(params.signals),
								conditions: params.conditions ?? current.spec.conditions,
								action:
									params.action === undefined
										? current.spec.action
										: fromV2IngestRuleAction(params.action),
							}
						: undefined,
				})
				.pipe(Effect.mapError(toMcpRuleError("update_ingest_rule")))
			return { action: "updated" as const, rule: toRow(updated) }
		}),
		render: (output) => renderRule("Ingest rule updated", output.rule),
	})

	server.define({
		name: "delete_ingest_rule",
		title: "Delete Ingest Rule",
		description:
			"Delete an ingest rule. Telemetry it would have dropped or redacted is stored as sent from then on. Requires confirm=true. Admin only.",
		parameters: Schema.Struct({
			rule: P.text("The rule's name or id (list_ingest_rules lists them)"),
			confirm: P.flag("Must be true"),
		}),
		output: DeleteIngestRuleOutput,
		hints: { readOnly: false, destructive: true, idempotent: false },
		phrases: ["Deleting an ingest rule"],
		handler: Effect.fn("McpTool.deleteIngestRule")(function* (params) {
			if (params.confirm !== true) {
				return yield* new McpInvalidInputError({
					message: `Deletion not confirmed. Re-call delete_ingest_rule with confirm=true to delete ${params.rule}.`,
					parameter: "confirm",
				})
			}
			const tenant = yield* adminOnly("delete_ingest_rule")
			const rule = yield* resolveRule("delete_ingest_rule", tenant.orgId, params.rule)
			const service = yield* IngestRuleService
			yield* service
				.delete(tenant.orgId, rule.id)
				.pipe(Effect.mapError(toMcpHttpError("delete_ingest_rule")))
			return { id: toRow(rule).id, name: rule.name }
		}),
		render: (output) => ({
			title: "Ingest Rule Deleted",
			blocks: [
				doc.fields([
					["ID", output.id],
					["Name", output.name],
				]),
			],
			next: [doc.next("list_ingest_rules", {}, "the remaining rules")],
		}),
	})
}
