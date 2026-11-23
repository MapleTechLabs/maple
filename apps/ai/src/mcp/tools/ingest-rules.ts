/**
 * Ingest rules: drop, parse or redact telemetry before Maple stores or bills it. Anyone may list and
 * preview them; creating, changing and deleting needs an engineer or admin, like the REST routes, since a
 * rule rewrites or discards the whole organization's incoming data.
 */
import { Effect, Option, Schema, Array as Arr, Record as Rec, String as Str } from "effect"
import { type IngestRuleRow } from "@maple/domain/mcp-outputs"
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
import type { ListLogsRow as ListLogsOutput } from "@maple/query-engine/ch"
import type { OrgId } from "@maple/primitives"
import * as Policy from "@maple/domain/policy"
import { IngestRuleService } from "@maple/backend/services/org/IngestRuleService"
import { provideWarehouseExecutorFromTenant } from "@maple/backend/services/warehouse/WarehouseQueryService"
import { WarehouseExecutor } from "@maple/query-engine/observability"
import {
	applyRules,
	compileRules,
	hasAttr,
	logSampleToRecord,
	spanSampleToRecord,
	type AttrMap,
	type AttrValue,
	type RuleRecord,
} from "@maple/ingest-rules"
import { McpInvalidInputError, McpUnavailableError, type McpToolRegistrar } from "./types"
import { CurrentMcpTenant } from "../tenant"
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
		yield* Policy.check(
			tenant.roles,
			"ingest_rules:manage",
			() =>
				new McpUnavailableError({
					message: `${tool} changes the organization's ingest rules, which only org admins and engineers may do. Ask an admin or engineer, or change it in Settings → Ingestion.`,
					capability: "org_admin",
				}),
		)
		return tenant
	})

/** The tool parameter a validator problem is about, so the model knows which argument to fix. */
export const parameterOfProblem = (problem: string): string => {
	if (Str.startsWith("condition ")(problem) || Str.includes("needs at least one condition")(problem))
		return "conditions"
	if (Str.includes("signal")(problem)) return "signals"
	if (Str.startsWith("the name")(problem)) return "name"
	if (Str.startsWith("position")(problem)) return "position"
	return "rule_action"
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
	const id = decodePublicId(PublicIdPrefixes.ingestRule, Str.trim(ref)) ?? Str.trim(ref)
	const matches = Arr.filter(rules, (rule) => rule.id === id || rule.name === Str.trim(ref))
	const [rule] = matches
	if (rule === undefined) {
		return yield* new McpInvalidInputError({
			message: `No ingest rule named "${ref}". list_ingest_rules lists them.`,
			parameter: "rule",
		})
	}
	if (matches.length > 1) {
		return yield* new McpInvalidInputError({
			message: `${matches.length} ingest rules match "${ref}"; pass one's id instead: ${Arr.join(
				Arr.map(Arr.map(matches, toRow), (row) => row.id),
				", ",
			)}.`,
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
					message: `signals are ${Arr.join(SIGNALS, ", ")}.`,
					parameter: "signals",
				}),
		),
	)

const conditionsParam = P.optionalJson(
	Schema.Array(IngestRuleCondition),
	'Conditions that must all match, e.g. [{"field":"severity","op":"lt","value":"info"}] or [{"field":"attribute","key":"http.route","op":"in","values":["/health"]}]. Fields: service_name, name, attribute, resource_attribute, body, severity, span_kind, span_status. Ops: eq, neq, in, not_in, prefix, contains, regex, exists, not_exists, lt, gte (severity). Empty matches every record (redact rules only).',
)
const actionDescription =
	'What to do: {"type":"drop","keep_percent":0} or {"type":"redact","keys":["*password*"],"detectors":["email","credit_card","jwt","api_token","ipv4","ipv6","phone","iban"],"patterns":["ORD-[0-9]+"],"scopes":["attributes","resource","events","body"],"method":"mask"|"hash"|"remove"} or, for logs only, {"type":"parse","steps":[{"type":"json","source":"body"},{"type":"grok","source":"body","pattern":"%{IP:client.address} %{WORD:method}"},{"type":"regex","source":"attribute","key":"msg","pattern":"user=(?<user_id>[0-9]+)"},{"type":"severity","source":"attribute","key":"level"},{"type":"timestamp","source":"attribute","key":"ts","format":"rfc3339"|"unix_s"|"unix_ms"|"unix_us"|"unix_ns"|"common_log"}]}.'

const SPEC_FIELDS = {
	signals: P.list(`Signals the rule applies to: ${Arr.join(SIGNALS, ", ")}`),
	conditions: conditionsParam,
	rule_action: P.json(V2IngestRuleAction, actionDescription),
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

const parseAttributes = (raw: string): Effect.Effect<Readonly<Record<string, string>>> =>
	Schema.decodeEffect(Schema.fromJsonString(Schema.Record(Schema.String, Schema.String)))(raw).pipe(
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
	return Arr.map(result.data, (row) =>
		spanSampleToRecord({
			...row,
			spanAttributes: row.spanAttributes ?? {},
			resourceAttributes: row.resourceAttributes ?? {},
		}),
	)
})

// Parsed ints are bigints, which plain JSON cannot write.
const encodeAttrJsonOption = Schema.encodeOption(
	Schema.fromJsonString(Schema.Unknown, {
		replacer: (_key: string, inner: unknown) => (typeof inner === "bigint" ? String(inner) : inner),
	}),
)
const encodeAttrJson = (value: AttrValue): string | undefined =>
	Option.getOrUndefined(encodeAttrJsonOption(value))

/** A changed value as transcript text: strings raw, maps and lists as JSON rather than `[object Object]`. */
const valueText = (value: AttrValue): string =>
	typeof value === "string" || typeof value === "bigint"
		? String(value)
		: (encodeAttrJson(value) ?? "[unserializable value]")
/** Ints (bigints) and doubles of one number differ; the JSON form alone would equate them. */
const sameValue = (left: AttrValue, right: AttrValue) =>
	typeof left === typeof right && valueText(left) === valueText(right)

/** `key -> after` for every top-level value a rule changed or added; the value before stays out of the transcript. */
const changedValues = (before: RuleRecord, after: RuleRecord): ReadonlyArray<string> => {
	const diff = (scope: string, a: AttrMap, b: AttrMap) => [
		...Arr.flatMap(Rec.toEntries(a), ([key, value]) => {
			const next = hasAttr(b, key) ? b[key] : undefined
			if (next === undefined) return [`${scope}${key}: removed`]
			return sameValue(next, value) ? [] : [`${scope}${key} -> ${truncate(valueText(next), 60)}`]
		}),
		...Arr.flatMap(Rec.toEntries(b), ([key, value]) =>
			hasAttr(a, key) ? [] : [`${scope}${key} = ${truncate(valueText(value), 60)}`],
		),
	]
	const severity =
		after.severityText !== before.severityText || after.severityNumber !== before.severityNumber
			? [`severity -> ${after.severityText ?? ""} (${after.severityNumber ?? 0})`]
			: []
	const time =
		after.timeUnixNano !== undefined && after.timeUnixNano !== before.timeUnixNano
			? [`time -> ${new Date(Number(after.timeUnixNano / 1_000_000n)).toISOString()}`]
			: []
	const body =
		before.body !== undefined && (after.body === undefined || !sameValue(before.body, after.body))
			? [`body: ${truncate(after.body === undefined ? "removed" : valueText(after.body), 120)}`]
			: []
	return [
		...diff("", before.attributes, after.attributes),
		...diff("resource.", before.resource, after.resource),
		...body,
		...severity,
		...time,
	]
}

const recordLabel = (record: RuleRecord) =>
	truncate(record.name ?? (typeof record.body === "string" ? record.body : ""), 80)
const recordService = (record: RuleRecord) => {
	const service = record.resource["service.name"]
	return typeof service === "string" ? service : ""
}

/** Why a signal cannot be previewed for this rule, naming only the signals `signal` accepts. */
const notTargeted = (signal: string, signals: ReadonlyArray<string>): string => {
	const previewable = Arr.filter(signals, (candidate) => candidate === "traces" || candidate === "logs")
	return previewable.length === 0
		? `the rule does not apply to ${signal}, and metrics rules cannot be previewed`
		: `the rule does not apply to ${signal}; pick one of ${Arr.join(previewable, ", ")}`
}

/** What a preview over stored samples cannot show for this rule; span events are not sampled. */
export const previewNotes = (spec: IngestRuleSpec, signal: "traces" | "logs"): ReadonlyArray<string> =>
	signal === "traces" && spec.action._tag === "redact" && spec.action.scopes.includes("events")
		? [
				"Stored span samples carry no span events, so redactions there are not counted here; they still apply at ingest.",
			]
		: []

/** What one rule does to sampled records: counts plus a few examples of each outcome. */
export const previewOver = (spec: IngestRuleSpec, records: ReadonlyArray<RuleRecord>) => {
	const compiled = compileRules([spec], PREVIEW_SALT)
	const outcomes = Arr.map(records, (record, index) => ({
		record,
		// Records without a trace id sample at random in the gateway; a fixed draw keeps answers stable.
		outcome: applyRules(compiled, record, () => (((index * 0.618_033_988_75) % 1) + 1) % 1),
	}))
	const dropped = Arr.filter(outcomes, ({ outcome }) => outcome._tag === "dropped")
	const redacted = Arr.flatMap(outcomes, ({ record, outcome }) =>
		outcome._tag === "kept" && outcome.redactions.size > 0 ? [{ record, outcome }] : [],
	)
	const parsed = Arr.flatMap(outcomes, ({ record, outcome }) =>
		outcome._tag === "kept" && spec.action._tag === "parse" && outcome.matched.length > 0
			? [{ record, outcome }]
			: [],
	)
	const failed = Arr.filter(parsed, ({ outcome }) => outcome.parseFailures.size > 0)
	return {
		sampled: records.length,
		dropped: dropped.length,
		redactedRecords: redacted.length,
		redactedValues: Arr.reduce(
			redacted,
			0,
			(total, { outcome }) => total + Arr.reduce([...outcome.redactions.values()], 0, (a, b) => a + b),
		),
		...(spec.action._tag === "parse" ? { parsed: parsed.length, parseFailed: failed.length } : undefined),
		examples: [
			...Arr.map(dropped.slice(0, 3), ({ record }) => ({
				service: recordService(record),
				label: recordLabel(record),
				outcome: "dropped" as const,
				changes: [],
			})),
			...Arr.map(redacted.slice(0, 5), ({ record, outcome }) => ({
				service: recordService(outcome.record),
				// The label comes from the redacted record: a masked body must not reappear here.
				label: recordLabel(outcome.record),
				outcome: "redacted" as const,
				changes: changedValues(record, outcome.record),
			})),
			// Failures first: they are what a draft pattern needs fixed.
			...Arr.map(
				[...failed, ...Arr.filter(parsed, ({ outcome }) => outcome.parseFailures.size === 0)].slice(
					0,
					5,
				),
				({ record, outcome }) => ({
					service: recordService(record),
					label: recordLabel(record),
					outcome: outcome.parseFailures.size > 0 ? ("parse_failed" as const) : ("parsed" as const),
					changes: changedValues(record, outcome.record),
				}),
			),
		],
	}
}

export function registerIngestRuleTools(server: McpToolRegistrar) {
	server.define({
		name: "list_ingest_rules",
		title: "List Ingest Rules",
		description:
			"The organization's ingest rules: what telemetry is dropped, redacted or parsed before Maple stores or bills it. Drop rules run first, then redact rules, then parse rules, each kind by position; redact rules on attributes or the body run again on the keys parsing wrote.",
		parameters: Schema.Struct({}),
		hints: { readOnly: true, destructive: false, idempotent: true },
		scopeFamily: "ingest_rules",
		phrases: ["Listing ingest rules"],
		handler: Effect.fn("McpTool.listIngestRules")(function* () {
			const tenant = yield* CurrentMcpTenant
			const service = yield* IngestRuleService
			const rules = yield* service
				.list(tenant.orgId)
				.pipe(Effect.mapError(toMcpHttpError("list_ingest_rules")))
			yield* Effect.annotateCurrentSpan({ orgId: tenant.orgId, "result.rowCount": rules.length })
			return { rules: Arr.map(rules, toRow) }
		}),
		render: (output) => ({
			title: "Ingest Rules",
			...(output.rules.length === 0
				? {
						empty: {
							message:
								"This organization has no ingest rules; all telemetry is stored as sent.",
							hints: [
								"manage_ingest_rule action=create adds one (org admins and engineers only); preview_ingest_rule tries one first.",
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
								Arr.map(output.rules, (row) => [
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
			"Run an ingest rule (an existing one by `rule`, or a draft from signals/conditions/rule_action) over recent stored traces or logs and report how many records it would drop, parse or redact, with examples. Changes nothing. Recent data may already be redacted by existing rules; metrics are not previewed.",
		parameters: Schema.Struct({
			rule: P.optionalText("An existing rule's name or id (list_ingest_rules lists them)"),
			signals: P.optionalList(`Draft: signals, ${Arr.join(SIGNALS, ", ")}`),
			conditions: conditionsParam,
			rule_action: P.optionalJson(V2IngestRuleAction, `Draft: ${actionDescription}`),
			signal: P.optionalOneOf(
				["traces", "logs"],
				"Which signal to sample; defaults to the rule's first of traces/logs",
			),
			service: P.service("Only sample this service"),
			...PREVIEW_WINDOW.fields,
			limit: P.limit({ default: 200, max: 500, noun: "sample records" }),
		}),
		aliases: { ...P.SERVICE_ALIASES, action: "rule_action" },
		hints: { readOnly: true, destructive: false, idempotent: true },
		scopeFamily: "ingest_rules",
		phrases: ["Previewing an ingest rule"],
		handler: Effect.fn("McpTool.previewIngestRule")(function* (params) {
			const tenant = yield* CurrentMcpTenant
			const spec: IngestRuleSpec =
				params.rule !== undefined
					? (yield* resolveRule("preview_ingest_rule", tenant.orgId, params.rule)).spec
					: params.signals !== undefined && params.rule_action !== undefined
						? {
								signals: yield* decodeSignals(params.signals),
								conditions: params.conditions ?? [],
								action: fromV2IngestRuleAction(params.rule_action),
							}
						: yield* new McpInvalidInputError({
								message: "Pass `rule`, or a draft with `signals` and `rule_action`.",
								parameter: "rule",
							})
			const signal = params.signal ?? spec.signals.find((s) => s === "traces" || s === "logs")
			// Stored spans in the search results carry no span kind, so such a condition would miscount.
			const problems = [
				...ingestRuleProblems(spec),
				...(signal !== undefined && !spec.signals.includes(signal)
					? [notTargeted(signal, spec.signals)]
					: []),
				...(signal === "traces" &&
				Arr.some(spec.conditions, (condition) => condition.field === "span_kind")
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
			const notes = previewNotes(spec, signal)
			return {
				signal,
				...previewOver(spec, records),
				problems: [],
				...(notes.length > 0 ? { notes } : undefined),
			}
		}),
		render: (output) => ({
			title: "Ingest Rule Preview",
			// A refused preview ran nothing, so it shows why and no counts.
			blocks:
				output.problems.length > 0
					? [doc.text(`Not previewed: ${Arr.join(output.problems, "; ")}.`)]
					: [
							...Arr.map(output.notes ?? [], (note) => doc.text(note)),
							doc.text(
								output.parsed !== undefined
									? `Of ${output.sampled} recent ${output.signal} records, the rule would parse ${output.parsed}; ${output.parseFailed ?? 0} of them would fail a step and get maple.parse.error.`
									: `Of ${output.sampled} recent ${output.signal} records, ${output.dropped} would be dropped and ${output.redactedRecords} redacted (${output.redactedValues} values). Hashes use a preview key and differ from stored ones.`,
							),
							...(output.examples.length === 0
								? []
								: [
										doc.table(
											["Outcome", "Service", "Record", "Changes"],
											Arr.map(output.examples, (example) => [
												example.outcome,
												example.service,
												example.label,
												Arr.join(example.changes, "; ") || "-",
											]),
										),
									]),
						],
		}),
	})

	server
		.family({
			name: "manage_ingest_rule",
			title: "Manage Ingest Rule",
			description:
				"Create, change or delete an ingest rule: what Maple drops, samples or redacts from incoming telemetry before storing it. Org admins and engineers only.",
			phrases: ["Managing an ingest rule"],
			scopeFamily: "ingest_rules",
		})
		.action("create", {
			description:
				"Add a rule that drops or redacts telemetry before Maple stores or bills it. Dropped data is never billed. Drop rules need at least one condition. Preview with preview_ingest_rule first. Applies to new data within 30 seconds.",
			parameters: Schema.Struct({
				name: P.text("A label for the rule"),
				...SPEC_FIELDS,
				enabled: P.optionalFlag("Start disabled with false; default true"),
				position: P.optionalNumber(
					"Run order among rules of the same kind; default after the last rule",
				),
			}),
			hints: { readOnly: false, destructive: false, idempotent: false },
			handler: Effect.fn("McpTool.createIngestRule")(function* (params) {
				const tenant = yield* adminOnly("manage_ingest_rule")
				const service = yield* IngestRuleService
				const created = yield* service
					.create(tenant.orgId, {
						name: params.name,
						enabled: params.enabled,
						position: params.position,
						spec: {
							signals: yield* decodeSignals(params.signals),
							conditions: params.conditions ?? [],
							action: fromV2IngestRuleAction(params.rule_action),
						},
					})
					.pipe(Effect.mapError(toMcpRuleError("manage_ingest_rule")))
				return { action: "created" as const, rule: toRow(created) }
			}),
			render: (output) => renderRule("Ingest rule created", output.rule),
		})
		.action("update", {
			description:
				"Change an ingest rule: turn it off (enabled=false) or on, rename it, move it (position), or replace its signals, conditions or rule_action. Fields left out keep their value.",
			parameters: Schema.Struct({
				rule: P.text("The rule's name or id (list_ingest_rules lists them)"),
				name: P.optionalText("A new name"),
				enabled: P.optionalFlag("false turns the rule off, true turns it on"),
				position: P.optionalNumber("New run order among rules of the same kind"),
				signals: P.optionalList(`Replaces the signals: ${Arr.join(SIGNALS, ", ")}`),
				conditions: conditionsParam,
				rule_action: P.optionalJson(V2IngestRuleAction, `Replaces the action: ${actionDescription}`),
			}),
			hints: { readOnly: false, destructive: false, idempotent: true },
			handler: Effect.fn("McpTool.updateIngestRule")(function* (params) {
				const tenant = yield* adminOnly("manage_ingest_rule")
				const current = yield* resolveRule("manage_ingest_rule", tenant.orgId, params.rule)
				const service = yield* IngestRuleService
				const specChanged =
					params.signals !== undefined ||
					params.conditions !== undefined ||
					params.rule_action !== undefined
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
										params.rule_action === undefined
											? current.spec.action
											: fromV2IngestRuleAction(params.rule_action),
								}
							: undefined,
					})
					.pipe(Effect.mapError(toMcpRuleError("manage_ingest_rule")))
				return { action: "updated" as const, rule: toRow(updated) }
			}),
			render: (output) => renderRule("Ingest rule updated", output.rule),
		})
		.action("delete", {
			description:
				"Delete an ingest rule. Telemetry it would have dropped or redacted is stored as sent from then on. Requires confirm=true.",
			parameters: Schema.Struct({
				rule: P.text("The rule's name or id (list_ingest_rules lists them)"),
				confirm: P.flag("Must be true"),
			}),
			hints: { readOnly: false, destructive: true, idempotent: false },
			handler: Effect.fn("McpTool.deleteIngestRule")(function* (params) {
				if (params.confirm !== true) {
					return yield* new McpInvalidInputError({
						message: `Deletion not confirmed. Re-call manage_ingest_rule action=delete with confirm=true to delete ${params.rule}.`,
						parameter: "confirm",
					})
				}
				const tenant = yield* adminOnly("manage_ingest_rule")
				const rule = yield* resolveRule("manage_ingest_rule", tenant.orgId, params.rule)
				const service = yield* IngestRuleService
				yield* service
					.delete(tenant.orgId, rule.id)
					.pipe(Effect.mapError(toMcpHttpError("manage_ingest_rule")))
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
