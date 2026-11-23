import { OrgId } from "@maple/domain"
import * as Policy from "@maple/domain/policy"
import {
	V2IngestRule,
	V2IngestRulePreview,
	V2IngestRuleStats,
	V2IngestRuleSuggestions,
} from "@maple/domain/http/v2"
import { Array as Arr, Effect, Option, Record as Rec, Result, Schema } from "effect"
import { Command, Submodel, type Update } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { defineMessageUnion } from "foldkit/message"
import type { PageContext } from "../page/contract"
import { keepPercentOf } from "../page/settings/ingest-rule/form"
import * as EditorMessage from "../page/settings/ingest-rule/message"
import * as EditorModel from "../page/settings/ingest-rule/model"
import * as EditorUpdate from "../page/settings/ingest-rule/update"
import * as EditorView from "../page/settings/ingest-rule/view"
import * as Rules from "../page/settings/ingestion/ingest-rules"
import * as IngestionMessage from "../page/settings/ingestion/message"
import { deleteRuleDialog, ingestRulesSection } from "../page/settings/ingestion/view-ingest-rules"
import type { Resources } from "../platform/resources"
import { keepLocal } from "./local-commands"

// `/lab/ingest-rules`: the ingestion tab's rule list and a saved rule's editor over fixtures, with
// the counts the gateway reports for each rule. `?state=` picks a start.

export const LabState = Schema.Literals([
	"list",
	"list-loading",
	"rule",
	"rule-sampled",
	"rule-redact",
	"rule-empty",
	"new-drop",
	"new-sampled",
	"list-empty",
])
export type LabState = typeof LabState.Type

export const Flags = Schema.Struct({ state: LabState })
export type Flags = typeof Flags.Type

export const flags: Effect.Effect<Flags> = Effect.sync(() => ({
	state: Option.getOrElse(
		Schema.decodeUnknownOption(LabState)(new URLSearchParams(window.location.search).get("state")),
		(): LabState => "list",
	),
}))

export const Model = Schema.Struct({
	state: LabState,
	rules: Rules.Model,
	editor: EditorModel.Model,
})
export type Model = typeof Model.Type

export const Message = defineMessageUnion({
	GotIngestionMessage: { message: IngestionMessage.Message },
	GotEditorMessage: { message: EditorMessage.Message },
})
export type Message = typeof Message.Type

type Return = Update.Return<Model, Message, Resources>

const ORG = Schema.decodeSync(OrgId)("org_lab")
const context: PageContext = { orgId: ORG, pinnedNamespace: null, timeZone: "UTC" }

const END_MS = Date.UTC(2026, 10, 23, 12)
const HOUR = 3_600_000
const decodeRule = Schema.decodeSync(V2IngestRule)

const rule = (
	id: string,
	name: string,
	position: number,
	signals: ReadonlyArray<"logs" | "traces" | "metrics">,
	action: V2IngestRule["action"],
	conditions: V2IngestRule["conditions"],
	enabled = true,
): V2IngestRule =>
	decodeRule({
		id,
		object: "ingest_rule",
		name,
		enabled,
		position,
		signals: [...signals],
		conditions: [...conditions],
		action,
		created_at: "2026-11-01T12:00:00.000Z",
		updated_at: "2026-11-01T12:00:00.000Z",
	})

const DROP_DEBUG = rule(
	"irule_YofPTrK9782DWwcnXhpcCw",
	"Drop debug logs",
	0,
	["logs"],
	{ type: "drop", keep_percent: 0 },
	[{ field: "severity", op: "lt", value: "info" }],
)
const SAMPLE_HEALTH = rule(
	"irule_ZofPTrK9782DWwcnXhpcCw",
	"Sample health checks",
	1,
	["traces", "logs"],
	{ type: "drop", keep_percent: 10 },
	[{ field: "attribute", key: "http.route", op: "in", values: ["/healthz", "/readyz"] }],
)
const REDACT_EMAILS = rule(
	"irule_aofPTrK9782DWwcnXhpcCw",
	"Redact emails",
	2,
	["logs", "traces"],
	{
		type: "redact",
		keys: [],
		detectors: ["email"],
		patterns: [],
		scopes: ["attributes", "body"],
		method: "mask",
	},
	[],
)
const DROP_LEGACY = rule(
	"irule_bofPTrK9782DWwcnXhpcCw",
	"Drop legacy cron spans",
	3,
	["traces"],
	{ type: "drop", keep_percent: 0 },
	[{ field: "service_name", op: "eq", value: "legacy-cron" }],
)
const RULES = [DROP_DEBUG, SAMPLE_HEALTH, REDACT_EMAILS, DROP_LEGACY]

/** A day shape: quiet nights, a busy afternoon, deterministic per rule. */
const dayLoad = (hour: number, seed: number) =>
	0.35 + 0.65 * Math.max(0, Math.sin((((hour % 24) - 6) / 24) * Math.PI * 2)) + ((hour * seed) % 7) / 40

type Cell = { matched: number; dropped: number; dropped_bytes: number; redacted_values: number }
const scale = (cell: Cell, by: number): Cell => ({
	matched: Math.round(cell.matched * by),
	dropped: Math.round(cell.dropped * by),
	dropped_bytes: Math.round(cell.dropped_bytes * by),
	redacted_values: Math.round(cell.redacted_values * by),
})

/** Per hour at the peak, per signal. */
const PEAKS: ReadonlyArray<{ id: string; seed: number; signals: Record<string, Cell> }> = [
	{
		id: DROP_DEBUG.id,
		seed: 3,
		signals: {
			logs: { matched: 52_000, dropped: 52_000, dropped_bytes: 15_600_000, redacted_values: 0 },
		},
	},
	{
		id: SAMPLE_HEALTH.id,
		seed: 5,
		signals: {
			traces: { matched: 9_000, dropped: 8_100, dropped_bytes: 3_900_000, redacted_values: 0 },
			logs: { matched: 2_400, dropped: 2_160, dropped_bytes: 520_000, redacted_values: 0 },
		},
	},
	{
		id: REDACT_EMAILS.id,
		seed: 2,
		signals: {
			logs: { matched: 1_800, dropped: 0, dropped_bytes: 0, redacted_values: 2_100 },
			traces: { matched: 300, dropped: 0, dropped_bytes: 0, redacted_values: 310 },
		},
	},
]

const statsFor = (hours: number): V2IngestRuleStats => {
	const endHour = Math.floor(END_MS / HOUR)
	const hourly = Arr.flatMap(PEAKS, (peak) =>
		Arr.makeBy(hours, (index) => {
			const hour = endHour - hours + 1 + index
			const by = dayLoad(hour, peak.seed)
			const cells = Arr.map(Rec.values(peak.signals), (cell) => scale(cell, by))
			return { id: peak.id, hour, cell: sum(cells) }
		}),
	)
	const rules = Arr.map(PEAKS, (peak) => {
		const signals = Arr.map(Rec.toEntries(peak.signals), ([signal, cell]) => ({
			signal,
			...scale(
				cell,
				Arr.reduce(
					Arr.makeBy(hours, (index) => dayLoad(endHour - index, peak.seed)),
					0,
					(a, b) => a + b,
				),
			),
		}))
		return { id: peak.id, ...sum(signals), signals }
	})
	return Schema.decodeUnknownSync(V2IngestRuleStats)({
		object: "ingest_rule_stats",
		start_time: new Date(END_MS - hours * HOUR).toISOString(),
		end_time: new Date(END_MS).toISOString(),
		rules,
		signals: [],
		hourly: Arr.map(hourly, ({ id, hour, cell }) => ({
			id,
			bucket: new Date(hour * HOUR).toISOString(),
			...cell,
		})),
	})
}

const sum = (cells: ReadonlyArray<Cell>): Cell =>
	Arr.reduce(cells, { matched: 0, dropped: 0, dropped_bytes: 0, redacted_values: 0 }, (a, b) => ({
		matched: a.matched + b.matched,
		dropped: a.dropped + b.dropped,
		dropped_bytes: a.dropped_bytes + b.dropped_bytes,
		redacted_values: a.redacted_values + b.redacted_values,
	}))

const ruleFor = (state: LabState): V2IngestRule =>
	state === "rule-sampled"
		? SAMPLE_HEALTH
		: state === "rule-redact"
			? REDACT_EMAILS
			: state === "rule-empty"
				? DROP_LEGACY
				: DROP_DEBUG

const log = (serviceName: string, severityText: string, severityNumber: number, body: string) => ({
	serviceName,
	body,
	severityNumber,
	severityText,
	traceId: "",
	logAttributes: {},
	resourceAttributes: {},
})
const LOG_SAMPLES = [
	log("checkout", "DEBUG", 5, "cache warm for cart 81f2"),
	log("checkout", "DEBUG", 5, "retrying inventory lookup (attempt 2)"),
	log("checkout", "INFO", 9, "order placed by ana@example.com"),
	log("payments", "DEBUG", 5, "stripe webhook signature verified"),
	log("payments", "ERROR", 17, "payment failed: card declined"),
	log("api", "INFO", 9, "GET /v1/orders 200 in 42ms"),
	log("api", "DEBUG", 5, "pool size 12, idle 9"),
]

/** What the last 24 hours suggest. */
const SUGGESTIONS = Schema.decodeSync(V2IngestRuleSuggestions)({
	object: "ingest_rule_suggestions",
	start_time: new Date(END_MS - 24 * HOUR).toISOString(),
	end_time: new Date(END_MS).toISOString(),
	data: [
		{
			signal: "logs",
			service_name: "payments",
			level: "debug",
			span_name: null,
			reason: "debug_logs",
			keep_percent: 0,
			records: 2_840_000,
			bytes: 812_000_000,
			saved_bytes: 812_000_000,
			share: 0.24,
		},
		{
			signal: "traces",
			service_name: "api",
			level: null,
			span_name: "GET /v1/orders",
			reason: "busy_operation",
			keep_percent: 10,
			records: 1_920_000,
			bytes: 576_000_000,
			saved_bytes: 518_400_000,
			share: 0.31,
		},
		{
			signal: "traces",
			service_name: "gateway",
			level: null,
			span_name: "GET /healthz",
			reason: "health_checks",
			keep_percent: 0,
			records: 864_000,
			bytes: 172_800_000,
			saved_bytes: 172_800_000,
			share: 0.09,
		},
	],
})

/** What the API would count for a draft over the last 24 hours. */
const ESTIMATE = (keepPercent: number) => {
	const stored = 8_412_000
	const matched = 1_236_000
	const dropped = Math.round(matched * (1 - keepPercent / 100))
	return Schema.decodeSync(V2IngestRulePreview)({
		object: "ingest_rule_preview",
		start_time: new Date(END_MS - 24 * HOUR).toISOString(),
		end_time: new Date(END_MS).toISOString(),
		signals: [
			{
				signal: "logs",
				scanned_hours: 24,
				stored,
				matched,
				estimated_dropped: dropped,
				estimated_dropped_bytes: dropped * 290,
				services: [
					{ service_name: "checkout", stored: 4_100_000, matched: 802_000 },
					{ service_name: "payments", stored: 2_300_000, matched: 301_000 },
					{ service_name: "api", stored: 2_012_000, matched: 133_000 },
				],
			},
		],
	})
}

/** Answers the editor's reads from the fixtures, and the reads those answers start. */
const answerEditor = (
	model: EditorModel.Model,
	commands: ReadonlyArray<{ readonly name: string }>,
): EditorModel.Model =>
	Arr.reduce(commands, model, (current, command) => {
		const reply = (message: EditorMessage.Message) => {
			const step = EditorUpdate.update(current, message, context)
			return answerEditor(step.model, step.commands ?? [])
		}
		switch (command.name) {
			case "FetchIngestRuleImpact":
				return reply(
					EditorMessage.Message.CompletedFetchImpact({
						window: current.impactWindow,
						result: Result.succeed(statsFor(current.impactWindow === "7d" ? 168 : 24)),
					}),
				)
			case "FetchIngestRuleSamples":
				return reply(
					EditorMessage.Message.CompletedFetchSamples({
						key: current.samplesKey,
						result: Result.succeed({ _tag: "logs", rows: LOG_SAMPLES }),
					}),
				)
			case "DebounceIngestRuleEstimate":
				return reply(EditorMessage.Message.ElapsedEstimateDebounce({ seq: current.estimateSeq }))
			case "FetchIngestRuleEstimate":
				return reply(
					EditorMessage.Message.CompletedFetchEstimate({
						key: current.estimateKey,
						result: Result.succeed(
							ESTIMATE(
								current.draft.actionType === "drop"
									? keepPercentOf(current.draft.keepPercent)
									: 0,
							),
						),
					}),
				)
			default:
				return current
		}
	})

const liftEditor = (commands: ReadonlyArray<Command.Command<EditorMessage.Message, never, Resources>>) =>
	Command.mapMessages(keepLocal(commands), (message) => Message.GotEditorMessage({ message }))

export const init = (flags: Flags): Return => {
	const listed = Rules.update(
		Rules.init(),
		Rules.Message.CompletedFetch({ result: Result.succeed(flags.state === "list-empty" ? [] : RULES) }),
	).model
	const rules =
		flags.state === "list-loading"
			? listed
			: Arr.reduce(
					[
						Rules.Message.CompletedFetchStats({ result: Result.succeed(statsFor(24)) }),
						Rules.Message.CompletedFetchSuggestions({ result: Result.succeed(SUGGESTIONS) }),
					],
					listed,
					(model, message) => Rules.update(model, message).model,
				)
	const target = ruleFor(flags.state)
	const isNew = flags.state === "new-drop" || flags.state === "new-sampled"
	const opened = isNew
		? EditorUpdate.init({ _tag: "IngestRuleNew", search: { template: "drop-debug-logs" } }, context)
		: EditorUpdate.init({ _tag: "IngestRule", ruleId: target.id }, context)
	const steps: ReadonlyArray<EditorMessage.Message> = [
		EditorMessage.Message.CompletedFetchSession({ orgId: ORG, grants: Policy.grantsOf(["org:admin"]) }),
		...(isNew ? [] : [EditorMessage.Message.CompletedFetchExisting({ result: Result.succeed(target) })]),
		...(flags.state === "new-sampled"
			? [EditorMessage.Message.ChangedText({ part: "keepPercent", value: "10" })]
			: []),
	]
	const filled = Arr.reduce(steps, opened.model, (model, message) => {
		const step = EditorUpdate.update(model, message, context)
		return answerEditor(step.model, step.commands ?? [])
	})
	const editor = answerEditor(filled, opened.commands ?? [])
	return { model: { state: flags.state, rules, editor } }
}

export const update = (model: Model, message: Message): Return =>
	Message.match<Return>(message, {
		GotIngestionMessage: ({ message: child }) => {
			if (child._tag !== "GotIngestRulesMessage") return { model }
			const step = Rules.update(model.rules, child.message)
			return {
				model: { ...model, rules: step.model },
				commands: Command.mapMessages(keepLocal(step.commands), (inner) =>
					Message.GotIngestionMessage({
						message: IngestionMessage.Message.GotIngestRulesMessage({ message: inner }),
					}),
				),
			}
		},
		GotEditorMessage: ({ message: child }) => {
			const step = EditorUpdate.update(model.editor, child, context)
			return {
				model: { ...model, editor: answerEditor(step.model, step.commands ?? []) },
				commands: liftEditor(step.commands ?? []),
			}
		},
	})

export const breadcrumbs = [{ label: "Lab", href: "/lab" }, { label: "Ingest rules" }] as const

const listView = Submodel.defineView<
	Rules.Model,
	IngestionMessage.Message,
	Readonly<{ readonly none?: never }>
>((rules, _inputs, h) => h.div([], [ingestRulesSection(h, rules, true), deleteRuleDialog(h, rules)]))

export const view = (model: Model, h: HtmlBuilder<Message>): Html =>
	model.state === "list" || model.state === "list-loading" || model.state === "list-empty"
		? h.div(
				[h.Class("mx-auto w-full max-w-5xl p-6")],
				[
					h.submodel({
						slotId: "lab-ingest-rules-list",
						model: model.rules,
						view: listView,
						viewInputs: {},
						toParentMessage: (message: IngestionMessage.Message) =>
							Message.GotIngestionMessage({ message }),
					}),
				],
			)
		: h.submodel({
				slotId: "lab-ingest-rule-editor",
				model: model.editor,
				view: EditorView.view,
				viewInputs: { context },
				toParentMessage: (message: EditorMessage.Message) => Message.GotEditorMessage({ message }),
			})
