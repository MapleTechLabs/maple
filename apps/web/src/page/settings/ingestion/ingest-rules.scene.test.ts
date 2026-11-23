import * as Policy from "@maple/domain/policy"
import { V2IngestRule, V2IngestRuleStats, V2IngestRuleSuggestions } from "@maple/domain/http/v2"
import { Result, Schema, Array as Arr } from "effect"
import { Submodel } from "foldkit"
import { expect as expectView, given, Mount, role, scene, text, withViewInputs } from "foldkit/scene"
import { describe, expect, test } from "vitest"
import * as Dialog from "@maple/views/ui/dialog"
import * as Menu from "@maple/views/ui/menu"
import { toLoadFailure } from "@maple/views/data/load-failure"
import { PageOutMessage } from "../../contract"
import { menuIdOf, Message as RulesMessage } from "./ingest-rules"
import { Message } from "./message"
import type { Model } from "./model"
import { init, type InitOptions, update } from "./update"
import { deleteRuleDialog, ingestRulesSection } from "./view-ingest-rules"

const ADMIN = Policy.grantsOf(["org:admin"])

const options: InitOptions = {
	grants: ADMIN,
	orgKey: "default",
	timeZone: "UTC",
	pinnedNamespace: null,
}
const step = (model: Model, message: Message) => update(model, message, options)
const rules = (message: RulesMessage) => Message.GotIngestRulesMessage({ message })
/** The section and its dialog alone; the rest of the tab has its own tests. */
const sectionView = Submodel.defineView<Model, Message, Readonly<{ readonly none?: never }>>(
	(model, _inputs, h) =>
		h.div([], [ingestRulesSection(h, model.ingestRules, true), deleteRuleDialog(h, model.ingestRules)]),
)
const view = withViewInputs(sectionView, {})()
const names = (commands: ReadonlyArray<{ readonly name: string }> | undefined) =>
	Arr.map(commands ?? [], ({ name }) => name)

const decodeRule = Schema.decodeUnknownSync(V2IngestRule)
const dropDebug = decodeRule({
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
const redactTokens = decodeRule({
	id: "irule_ZofPTrK9782DWwcnXhpcCw",
	object: "ingest_rule",
	name: "Redact auth headers",
	enabled: false,
	position: 1,
	signals: ["traces"],
	conditions: [],
	action: {
		type: "redact",
		keys: ["http.request.header.authorization"],
		detectors: [],
		patterns: [],
		scopes: ["attributes"],
		method: "mask",
	},
	created_at: "2026-10-28T12:00:00.000Z",
	updated_at: "2026-10-28T12:00:00.000Z",
})

const withRules = (list: ReadonlyArray<V2IngestRule>): Model =>
	step(init(options).model, rules(RulesMessage.CompletedFetch({ result: Result.succeed(list) }))).model

const pick = (model: Model, rule: V2IngestRule, value: string) =>
	step(
		model,
		rules(
			RulesMessage.GotRowMenuMessage({
				menuId: menuIdOf(rule.id),
				message: Menu.Message.ClickedItem({ index: 0, item: { kind: "Item", value } }),
			}),
		),
	)

describe("ingest rules section", () => {
	test("entry reads the org's rules", () => {
		expect(names(init(options).commands)).toContain("FetchIngestRules")
	})

	test("each rule shows its name, action and a one-line summary", () => {
		scene(
			{ update: step, view },
			given(withRules([dropDebug, redactTokens])),
			expectView(text("Drop debug logs")).toExist(),
			expectView(text("Redact auth headers")).toExist(),
			expectView(text(/^Where severity is below info: drop$/u)).toExist(),
			expectView(text("http.request.header.authorization")).toExist(),
			expectView(role("switch", { name: "Turn on Redact auth headers" })).not.toBeChecked(),
		)
	})

	test("the last 24 hours show what each rule dropped and the bytes it kept off the bill, and No hits for the rest", () => {
		const counts = { matched: 1520, dropped: 1520, dropped_bytes: 340_000_000, redacted_values: 0 }
		const stats = Schema.decodeSync(V2IngestRuleStats)({
			object: "ingest_rule_stats",
			start_time: "2026-10-27T12:00:00.000Z",
			end_time: "2026-10-28T12:00:00.000Z",
			rules: [{ id: dropDebug.id, ...counts, signals: [{ signal: "logs", ...counts }] }],
			signals: [],
			hourly: [{ id: dropDebug.id, bucket: "2026-10-28T11:00:00.000Z", ...counts }],
		})
		scene(
			{ update: step, view },
			given(
				step(
					withRules([dropDebug, redactTokens]),
					rules(RulesMessage.CompletedFetchStats({ result: Result.succeed(stats) })),
				).model,
			),
			expectView(text("1.5K dropped")).toExist(),
			expectView(text("340 MB saved")).toExist(),
			expectView(text("No hits")).toExist(),
			expectView(role("img", { name: "Drop debug logs: records dropped per hour" })).toExist(),
		)
	})

	test("a sampling rule says how many matching records it kept", () => {
		const sampled = { ...dropDebug, action: { type: "drop" as const, keep_percent: 10 } }
		const counts = { matched: 1000, dropped: 900, dropped_bytes: 2_000_000, redacted_values: 0 }
		const stats = Schema.decodeSync(V2IngestRuleStats)({
			object: "ingest_rule_stats",
			start_time: "2026-10-27T12:00:00.000Z",
			end_time: "2026-10-28T12:00:00.000Z",
			rules: [{ id: dropDebug.id, ...counts, signals: [{ signal: "logs", ...counts }] }],
			signals: [],
			hourly: [],
		})
		scene(
			{ update: step, view },
			given(
				step(
					withRules([sampled]),
					rules(RulesMessage.CompletedFetchStats({ result: Result.succeed(stats) })),
				).model,
			),
			expectView(text("900 dropped")).toExist(),
			expectView(text("2.0 MB saved · 100 kept")).toExist(),
		)
	})

	test("stats that fail to load leave the list up with a dash", () => {
		const failed = step(
			withRules([dropDebug]),
			rules(
				RulesMessage.CompletedFetchStats({ result: Result.fail(toLoadFailure(new Error("boom"))) }),
			),
		).model
		scene(
			{ update: step, view },
			given(failed),
			expectView(text("Drop debug logs")).toExist(),
			expectView(text("-")).toExist(),
		)
	})

	test("with no rules, the templates link to a prefilled editor", () => {
		scene(
			{ update: step, view },
			given(withRules([])),
			expectView(text("No ingest rules yet")).toExist(),
			expectView(role("link", { name: "Drop debug logs" })).toHaveAttr(
				"href",
				"/settings/ingestion/rules/new?template=drop-debug-logs",
			),
			expectView(role("link", { name: "Redact emails and card numbers" })).toHaveAttr(
				"href",
				"/settings/ingestion/rules/new?template=redact-pii",
			),
		)
	})

	test("a toggle flips the rule once until its answer lands, then refetches", () => {
		const toggling = step(withRules([dropDebug]), rules(RulesMessage.Toggled({ id: dropDebug.id })))
		expect(toggling.commands?.[0]).toMatchObject({ name: "ToggleIngestRule", args: { isEnabled: false } })
		expect(
			step(toggling.model, rules(RulesMessage.Toggled({ id: dropDebug.id }))).commands ?? [],
		).toEqual([])
		const done = step(
			toggling.model,
			rules(RulesMessage.CompletedToggle({ id: dropDebug.id, result: Result.succeed(undefined) })),
		)
		expect(names(done.commands)).toContain("FetchIngestRules")
	})

	test("moving a rule down sends the whole new order in one request", () => {
		const moving = pick(withRules([dropDebug, redactTokens]), dropDebug, "down")
		expect(moving.commands).toContainEqual(
			expect.objectContaining({
				name: "MoveIngestRules",
				args: { ids: [redactTokens.id, dropDebug.id] },
			}),
		)
	})

	test("delete asks first, then removes the rule and says so", () => {
		const asked = pick(withRules([dropDebug]), dropDebug, "delete").model
		expect([asked.ingestRules.deleteDialog.isOpen, asked.ingestRules.deleting?.id]).toEqual([
			true,
			dropDebug.id,
		])
		scene(
			{ update: step, view },
			given(asked),
			Mount.resolve(Dialog.MountDialog, Dialog.Message.CompletedMountDialog()),
			expectView(role("alertdialog", { name: "Delete ingest rule?" })).toExist(),
		)
		const deleting = step(asked, rules(RulesMessage.ClickedConfirmDelete()))
		expect(deleting.commands?.[0]).toMatchObject({ name: "DeleteIngestRule", args: { id: dropDebug.id } })
		const deleted = step(
			deleting.model,
			rules(RulesMessage.CompletedDelete({ result: Result.succeed(undefined) })),
		)
		expect(names(deleted.commands)).toContain("FetchIngestRules")
		expect(deleted.outMessage).toEqual(
			PageOutMessage.RequestedToast({ type: "success", title: "Ingest rule deleted", description: "" }),
		)
	})

	test("edit opens the rule's page", () => {
		expect(pick(withRules([dropDebug]), dropDebug, "edit").outMessage).toEqual(
			PageOutMessage.RequestedNavigation({
				url: "/settings/ingestion/rules/irule_YofPTrK9782DWwcnXhpcCw",
				isReplace: false,
			}),
		)
	})
})

describe("suggested ingest rules", () => {
	const suggestions = Schema.decodeSync(V2IngestRuleSuggestions)({
		object: "ingest_rule_suggestions",
		start_time: "2026-11-22T12:00:00.000Z",
		end_time: "2026-11-23T12:00:00.000Z",
		data: [
			{
				signal: "logs",
				service_name: "checkout",
				level: "debug",
				span_name: null,
				reason: "debug_logs",
				keep_percent: 0,
				records: 1_200_000,
				bytes: 340_000_000,
				saved_bytes: 340_000_000,
				share: 0.21,
			},
			{
				signal: "traces",
				service_name: "api",
				level: null,
				span_name: "GET /orders",
				reason: "busy_operation",
				keep_percent: 10,
				records: 400_000,
				bytes: 200_000_000,
				saved_bytes: 180_000_000,
				share: 0.4,
			},
		],
	})
	const withSuggestions = (list: ReadonlyArray<V2IngestRule>) =>
		step(
			withRules(list),
			rules(RulesMessage.CompletedFetchSuggestions({ result: Result.succeed(suggestions) })),
		).model

	test("the tab asks for suggestions with the rules", () => {
		expect(names(init(options).commands)).toContain("FetchIngestRuleSuggestions")
	})

	test("each suggestion says what it saves and links to a prefilled editor, even before the first rule", () => {
		scene(
			{ update: step, view },
			given(withSuggestions([])),
			expectView(text("Debug logs from checkout")).toExist(),
			expectView(text("340 MB a day")).toExist(),
			expectView(role("link", { name: "Drop" })).toHaveAttr(
				"href",
				"/settings/ingestion/rules/new?service=checkout&level=debug&keep=0",
			),
			expectView(text("GET /orders in api")).toExist(),
			expectView(role("link", { name: "Sample 10%" })).toExist(),
		)
	})

	test("a suggestion an enabled rule already covers is not shown again", () => {
		const covering = {
			...dropDebug,
			conditions: [
				{ field: "service_name" as const, op: "eq" as const, value: "checkout" },
				{ field: "severity" as const, op: "lt" as const, value: "info" },
			],
		}
		scene(
			{ update: step, view },
			given(withSuggestions([covering])),
			expectView(text("Debug logs from checkout")).not.toExist(),
			expectView(text("GET /orders in api")).toExist(),
		)
	})

	test("no suggestions, or a failed read, shows nothing extra", () => {
		const failed = step(
			withRules([dropDebug]),
			rules(RulesMessage.CompletedFetchSuggestions({ result: Result.fail(toLoadFailure("boom")) })),
		).model
		scene(
			{ update: step, view },
			given(failed),
			expectView(role("group", { name: "Suggested rules" })).not.toExist(),
		)
	})
})
