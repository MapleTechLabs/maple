import { V2IngestRule, V2IngestRuleStats } from "@maple/domain/http/v2"
import { Result, Schema } from "effect"
import { Submodel } from "foldkit"
import { expect as expectView, given, Mount, role, scene, text, withViewInputs } from "foldkit/scene"
import { describe, expect, test } from "vitest"
import * as Dialog from "../../../ui/dialog"
import * as Menu from "../../../ui/menu"
import { toLoadFailure } from "../../../data/load-failure"
import { PageOutMessage } from "../../contract"
import { menuIdOf, Message as RulesMessage } from "./ingest-rules"
import { Message } from "./message"
import type { Model } from "./model"
import { init, type InitOptions, update } from "./update"
import { deleteRuleDialog, ingestRulesSection } from "./view-ingest-rules"

const options: InitOptions = {
	isAdmin: true,
	hasIngestRules: true,
	orgKey: "default",
	timeZone: "UTC",
	pinnedNamespace: null,
}
const step = (model: Model, message: Message) => update(model, message, options)
const rules = (message: RulesMessage) => Message.GotIngestRulesMessage({ message })
/** The section and its dialog alone; the rest of the tab has its own tests. */
const sectionView = Submodel.defineView<Model, Message, Readonly<{ readonly none?: never }>>(
	(model, _inputs, h) =>
		h.div(
			[],
			[ingestRulesSection(h, model.ingestRules, model.isAdmin), deleteRuleDialog(h, model.ingestRules)],
		),
)
const view = withViewInputs(sectionView, {})()
const names = (commands: ReadonlyArray<{ readonly name: string }> | undefined) =>
	(commands ?? []).map(({ name }) => name)

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
	test("an org without the ingest rules rollout neither fetches nor shows rules", () => {
		const started = init({ ...options, hasIngestRules: false })
		const fetched = (started.commands ?? []).map(({ name }) => name)
		expect(fetched).not.toContain("FetchIngestRules")
		expect(fetched).not.toContain("FetchIngestRuleStats")
		expect(started.model.hasIngestRules).toBe(false)
	})

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

	test("the last 24 hours show what each rule dropped or redacted, and No hits for the rest", () => {
		const stats = Schema.decodeUnknownSync(V2IngestRuleStats)({
			object: "ingest_rule_stats",
			start_time: "2026-10-27T12:00:00.000Z",
			end_time: "2026-10-28T12:00:00.000Z",
			rules: [
				{ id: dropDebug.id, matched: 1520, dropped: 1520, dropped_bytes: 90000, redacted_values: 0 },
			],
			signals: [],
			hourly: [{ id: dropDebug.id, bucket: "2026-10-28T11:00:00.000Z", matched: 1520 }],
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
			expectView(text("No hits")).toExist(),
			expectView(role("img", { name: "Drop debug logs matches per hour" })).toExist(),
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
