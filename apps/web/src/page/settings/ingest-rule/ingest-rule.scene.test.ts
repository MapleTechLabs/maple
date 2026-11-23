import * as Policy from "@maple/domain/policy"
import { OrgId } from "@maple/domain"
import { V2IngestRule, V2IngestRulePreview, V2IngestRuleStats } from "@maple/domain/http/v2"
import { Result, Schema, Array as Arr } from "effect"
import {
	Command,
	change,
	expect as expectView,
	given,
	role,
	scene,
	text,
	withViewInputs,
} from "foldkit/scene"
import { describe, expect, test } from "vitest"
import { ORG } from "../../kit/alert-test-rows"
import { PageOutMessage, type PageContext } from "../../contract"
import { DebounceEstimate } from "./command"
import { Message } from "./message"
import type { Model } from "./model"
import type { LogSample } from "./preview"
import { init, update } from "./update"
import { view as pageView } from "./view"

const ENGINEER = Policy.grantsOf(["org:engineer"])

const orgId = Schema.decodeSync(OrgId)(ORG)
const context: PageContext = { orgId, pinnedNamespace: null, timeZone: "UTC" }
const pageUpdate = (model: Model, message: Message) => update(model, message, context)
const view = withViewInputs(pageView, { context })()

const asAdmin = (model: Model): Model =>
	pageUpdate(model, Message.CompletedFetchSession({ orgId: ORG, grants: ENGINEER })).model
const fresh = (template?: string): Model =>
	asAdmin(
		init({ _tag: "IngestRuleNew", search: template === undefined ? {} : { template } }, context).model,
	)

const log = (severityText: string, body: string): LogSample => ({
	serviceName: "checkout",
	body,
	severityNumber: 0,
	severityText,
	traceId: "",
	logAttributes: {},
	resourceAttributes: {},
})
const SAMPLES = [
	log("DEBUG", "cache warm"),
	log("DEBUG", "retrying"),
	log("INFO", "order placed by ana@example.com"),
	log("ERROR", "payment failed"),
]

const withSamples = (model: Model): Model =>
	pageUpdate(
		model,
		Message.CompletedFetchSamples({
			key: model.samplesKey,
			result: Result.succeed({ _tag: "logs", rows: SAMPLES }),
		}),
	).model

describe("ingest rule editor", () => {
	test("a new rule reads recent logs for the preview", () => {
		const entered = init({ _tag: "IngestRuleNew", search: {} }, context)
		expect(Arr.map(entered.commands ?? [], ({ name }) => name)).toContain("FetchIngestRuleSamples")
	})

	test("an empty drop rule lists what is missing and cannot be created", () => {
		scene(
			{ update: pageUpdate, view },
			given(fresh()),
			expectView(text("give the rule a name")).toExist(),
			expectView(text("a drop rule needs at least one condition")).toExist(),
			expectView(role("button", { name: "Create rule" })).toBeDisabled(),
		)
	})

	test("a template fills the form and is ready to save", () => {
		scene(
			{ update: pageUpdate, view },
			given(fresh("drop-debug-logs")),
			expectView(role("textbox", { name: "Name" })).toHaveValue("Drop debug logs"),
			expectView(text("Ready to save")).toExist(),
			expectView(role("button", { name: "Create rule" })).not.toBeDisabled(),
		)
	})

	test("changing a condition's field shows the first operator that field allows", () => {
		scene(
			{ update: pageUpdate, view },
			given(fresh("drop-debug-logs")),
			expectView(role("combobox", { name: "Condition 1 operator" })).toHaveValue("lt"),
			change(role("combobox", { name: "Condition 1 field" }), "body"),
			// The edit asks for a fresh 24 hour count; an elapsed debounce for another draft does nothing.
			Command.resolve(DebounceEstimate, Message.ElapsedEstimateDebounce({ seq: 0 })),
			expectView(role("combobox", { name: "Condition 1 field" })).toHaveValue("body"),
			expectView(role("combobox", { name: "Condition 1 operator" })).toHaveValue("eq"),
		)
	})

	test("the preview counts the sample records the rule would drop", () => {
		scene(
			{ update: pageUpdate, view },
			given(withSamples(fresh("drop-debug-logs"))),
			expectView(text("Would drop 2 of 4 (50%)")).toExist(),
		)
	})

	test("a redact preview shows the replaced text", () => {
		scene(
			{ update: pageUpdate, view },
			given(withSamples(fresh("redact-pii"))),
			expectView(text("Would redact 1 of 4 (25%)")).toExist(),
			expectView(text("[REDACTED:email]")).toExist(),
		)
	})

	test("hashing warns that it is pseudonymization", () => {
		scene(
			{ update: pageUpdate, view },
			given(fresh("hash-user-ids")),
			expectView(text(/^Hashing is pseudonymization/u)).toExist(),
		)
	})

	test("saving posts the rule and returns to the ingestion tab", () => {
		const saving = pageUpdate(fresh("drop-debug-logs"), Message.ClickedSave())
		expect(saving.commands?.[0]).toMatchObject({
			name: "SaveIngestRule",
			args: {
				editingId: null,
				payload: {
					name: "Drop debug logs",
					enabled: true,
					signals: ["logs"],
					conditions: [{ field: "severity", op: "lt", value: "info" }],
					action: { type: "drop", keep_percent: 0 },
				},
			},
		})
		const saved = Schema.decodeSync(V2IngestRule)({
			id: "irule_YofPTrK9782DWwcnXhpcCw",
			object: "ingest_rule",
			name: "Drop debug logs",
			enabled: true,
			position: 0,
			signals: ["logs"],
			conditions: [{ field: "severity", op: "lt", value: "info" }],
			action: { type: "drop", keep_percent: 0 },
			created_at: "2026-10-28T12:00:00.000Z",
			updated_at: "2026-10-28T12:00:00.000Z",
		})
		expect(
			pageUpdate(saving.model, Message.CompletedSave({ result: Result.succeed(saved) })).outMessage,
		).toEqual(
			PageOutMessage.RequestedNavigation({
				url: "/settings/ingestion",
				isReplace: false,
				toast: {
					type: "success",
					title: "Ingest rule created",
					description: "Applies to new data within 30 seconds.",
				},
			}),
		)
	})
})

const savedRule = Schema.decodeSync(V2IngestRule)({
	id: "irule_YofPTrK9782DWwcnXhpcCw",
	object: "ingest_rule",
	name: "Drop debug logs",
	enabled: true,
	position: 0,
	signals: ["logs", "traces"],
	conditions: [{ field: "service_name", op: "eq", value: "checkout" }],
	action: { type: "drop", keep_percent: 0 },
	created_at: "2026-10-28T12:00:00.000Z",
	updated_at: "2026-10-28T12:00:00.000Z",
})
const editing = (): Model => {
	const opened = init({ _tag: "IngestRule", ruleId: savedRule.id }, context)
	return pageUpdate(
		asAdmin(opened.model),
		Message.CompletedFetchExisting({ result: Result.succeed(savedRule) }),
	).model
}
const impactOf = (logs: number, traces: number) => {
	const cell = (dropped: number) => ({
		matched: dropped,
		dropped,
		dropped_bytes: dropped * 1000,
		redacted_values: 0,
	})
	const total = cell(logs + traces)
	return Schema.decodeSync(V2IngestRuleStats)({
		object: "ingest_rule_stats",
		start_time: "2026-10-27T12:00:00.000Z",
		end_time: "2026-10-28T12:00:00.000Z",
		rules:
			logs + traces === 0
				? []
				: [
						{
							id: savedRule.id,
							...total,
							signals: [
								{ signal: "logs", ...cell(logs) },
								{ signal: "traces", ...cell(traces) },
							],
						},
					],
		signals: [],
		hourly: [],
	})
}

describe("ingest rule impact", () => {
	test("a saved rule loads its last 24 hours of counts", () => {
		const opened = init({ _tag: "IngestRule", ruleId: savedRule.id }, context)
		expect(Arr.map(opened.commands ?? [], ({ name }) => name)).toContain("FetchIngestRuleImpact")
	})

	test("the impact panel shows what the rule dropped, the bytes dropped and a row per signal", () => {
		scene(
			{ update: pageUpdate, view },
			given(
				pageUpdate(
					editing(),
					Message.CompletedFetchImpact({
						window: "24h",
						result: Result.succeed(impactOf(1_200_000, 3000)),
					}),
				).model,
			),
			expectView(text("Records dropped")).toExist(),
			expectView(text("1.2M")).toExist(),
			expectView(text("1.2 GB")).toExist(),
			expectView(text("3K dropped · 3.0 MB dropped")).toExist(),
		)
	})

	test("a rule that changed from drop to redact still shows the drops in the window", () => {
		const redacting = {
			...savedRule,
			action: {
				type: "redact" as const,
				keys: ["user.email"],
				detectors: [],
				patterns: [],
				scopes: ["attributes" as const],
				method: "mask" as const,
			},
		}
		const opened = init({ _tag: "IngestRule", ruleId: savedRule.id }, context)
		const model = pageUpdate(
			asAdmin(opened.model),
			Message.CompletedFetchExisting({ result: Result.succeed(redacting) }),
		).model
		scene(
			{ update: pageUpdate, view },
			given(
				pageUpdate(
					model,
					Message.CompletedFetchImpact({
						window: "24h",
						result: Result.succeed(impactOf(2000, 0)),
					}),
				).model,
			),
			expectView(text("Records dropped")).toExist(),
			expectView(text("Values redacted")).toExist(),
			expectView(text("2K")).toExist(),
		)
	})

	test("a rule with no hits says so", () => {
		scene(
			{ update: pageUpdate, view },
			given(
				pageUpdate(
					editing(),
					Message.CompletedFetchImpact({ window: "24h", result: Result.succeed(impactOf(0, 0)) }),
				).model,
			),
			expectView(text("No records matched in the last 24 hours.")).toExist(),
		)
	})

	test("switching to 7 days refetches and ignores a late 24 hour answer", () => {
		const switched = pageUpdate(editing(), Message.PickedImpactWindow({ window: "7d" }))
		expect(Arr.map(switched.commands ?? [], ({ name }) => name)).toEqual(["FetchIngestRuleImpact"])
		const late = pageUpdate(
			switched.model,
			Message.CompletedFetchImpact({ window: "24h", result: Result.succeed(impactOf(5, 0)) }),
		)
		expect(late.model.impact._tag).toBe("Loading")
	})
})

describe("ingest rule 24 hour estimate", () => {
	const names = (commands: ReadonlyArray<{ readonly name: string }> | undefined) =>
		Arr.map(commands ?? [], ({ name }) => name)
	const estimate = (dropped: number) =>
		Schema.decodeSync(V2IngestRulePreview)({
			object: "ingest_rule_preview",
			start_time: "2026-11-22T12:00:00.000Z",
			end_time: "2026-11-23T12:00:00.000Z",
			signals: [
				{
					signal: "logs",
					scanned_hours: 24,
					stored: 8_000_000,
					matched: 1_200_000,
					estimated_dropped: dropped,
					estimated_dropped_bytes: 340_000_000,
					services: [
						{ service_name: "checkout", stored: 5_000_000, matched: 900_000 },
						{ service_name: "api", stored: 3_000_000, matched: 300_000 },
					],
				},
			],
		})

	test("a template counts the last 24 hours once the debounce elapses", () => {
		const opened = init({ _tag: "IngestRuleNew", search: { template: "drop-debug-logs" } }, context)
		expect(names(opened.commands)).toContain("DebounceIngestRuleEstimate")
		expect(opened.model.estimateKey).not.toBe("")
		const fired = pageUpdate(
			opened.model,
			Message.ElapsedEstimateDebounce({ seq: opened.model.estimateSeq }),
		)
		expect(names(fired.commands)).toEqual(["FetchIngestRuleEstimate"])
	})

	test("typing a value and back again asks once, after the last edit", () => {
		const model = fresh("drop-debug-logs")
		const typed = pageUpdate(model, Message.ChangedText({ part: "keepPercent", value: "5" })).model
		const back = pageUpdate(typed, Message.ChangedText({ part: "keepPercent", value: "0" })).model
		expect(back.estimateKey).toBe(model.estimateKey)
		expect(
			names(pageUpdate(back, Message.ElapsedEstimateDebounce({ seq: model.estimateSeq })).commands),
		).toEqual([])
		expect(
			names(pageUpdate(back, Message.ElapsedEstimateDebounce({ seq: back.estimateSeq })).commands),
		).toEqual(["FetchIngestRuleEstimate"])
	})

	test("a draft without a name is still counted", () => {
		const model = fresh("drop-debug-logs")
		const unnamed = pageUpdate(model, Message.ChangedText({ part: "name", value: "" })).model
		expect(unnamed.estimateKey).toBe(model.estimateKey)
	})

	test("the estimate says how much the rule would drop, the bytes and the busiest services", () => {
		const model = fresh("drop-debug-logs")
		scene(
			{ update: pageUpdate, view },
			given(
				pageUpdate(
					model,
					Message.CompletedFetchEstimate({
						key: model.estimateKey,
						result: Result.succeed(estimate(1_200_000)),
					}),
				).model,
			),
			expectView(text("Would drop 1.2M of 8M logs (15%)")).toExist(),
			expectView(text("About 340 MB kept off the bill")).toExist(),
			expectView(text("checkout 900K · api 300K")).toExist(),
		)
	})

	test("an edit asks again and drops the answer for the old draft", () => {
		const model = fresh("drop-debug-logs")
		const oldKey = model.estimateKey
		const edited = pageUpdate(model, Message.PickedAction({ actionType: "redact" }))
		expect(edited.model.estimateKey).not.toBe(oldKey)
		const late = pageUpdate(
			edited.model,
			Message.CompletedFetchEstimate({ key: oldKey, result: Result.succeed(estimate(1)) }),
		)
		expect(late.model.estimate._tag).not.toBe("Success")
	})

	test("a draft that cannot be saved asks for nothing", () => {
		const opened = init({ _tag: "IngestRuleNew", search: {} }, context)
		expect(opened.model.estimateKey).toBe("")
		expect(names(opened.commands)).not.toContain("DebounceIngestRuleEstimate")
	})
})
