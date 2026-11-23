import * as Policy from "@maple/domain/policy"
import { GroupingConfigDocument } from "@maple/domain/http"
import { OrgGroupingRule } from "@maple/domain/tinybird/grouping-rules"
import { Array as Arr, Result, Schema } from "effect"
import type { Html, HtmlBuilder } from "foldkit/html"
import { click, expect as expectView, given, role, scene, text } from "foldkit/scene"
import { describe, expect, test } from "vitest"
import * as Rules from "./grouping-rules"
import { groupingRulesSection } from "./grouping-rules-view"

// The grouping rules editor: what a save sends, where a refused save's problems land, and
// that only a manager edits.

const ADMIN = Policy.grantsOf(["org:admin"])
const decodeIso = Schema.decodeSync(GroupingConfigDocument.fields.updatedAt)
const OPENED_AT = decodeIso("2026-11-20T10:00:00.000Z")
const NEWER_AT = decodeIso("2026-11-21T10:00:00.000Z")
const MEMBER = Policy.grantsOf(["org:member"])

const stored = new GroupingConfigDocument({
	updatedAt: null,
	rules: [
		new OrgGroupingRule({ id: "rule-1", kind: "merge", message: "*timed out*", title: "Timeouts" }),
		new OrgGroupingRule({ id: "rule-3", kind: "library-frames", frame: "*node_modules/@acme/*" }),
	],
})

const loaded = (grants: ReadonlyArray<Policy.Permission>): Rules.Model =>
	Rules.update(
		Rules.init().model,
		Rules.Message.CompletedFetchRules({ result: Result.succeed(stored) }),
		grants,
	).model

const run = (model: Rules.Model, messages: ReadonlyArray<Rules.Message>, grants = ADMIN) =>
	Arr.reduce(messages, model, (next, message) => Rules.update(next, message, grants).model)

const viewAs =
	(canManage: boolean) =>
	(model: Rules.Model, h: HtmlBuilder<Rules.Message>): Html =>
		groupingRulesSection(h, model, { canManage, isKnownMember: true })

describe("grouping rules editor", () => {
	test("a new rule takes an id no earlier save can hold, and the save sends only filled fields the kind reads", () => {
		const edited = run(loaded(ADMIN), [
			Rules.Message.ClickedAddRule(),
			Rules.Message.ChangedRuleField({
				id: "rule-0-1",
				field: "exceptionType",
				value: "  ECONNRESET ",
			}),
			Rules.Message.ChangedRuleField({
				id: "rule-3",
				field: "message",
				value: "ignored by a frame rule",
			}),
		])
		const saved = Rules.update(edited, Rules.Message.ClickedSaveRules(), ADMIN)
		const config = Rules.configOf(edited.draft ?? [])
		expect(Arr.map(config.rules, (rule) => rule.id)).toEqual(["rule-1", "rule-3", "rule-0-1"])
		expect(config.rules[2]).toEqual(
			new OrgGroupingRule({ id: "rule-0-1", kind: "merge", exceptionType: "ECONNRESET" }),
		)
		expect(config.rules[1]?.message).toBeUndefined()
		expect(saved.model.isSaving).toBe(true)
	})

	test("a rule added after a save never takes an id an earlier rule held", () => {
		const opened = new GroupingConfigDocument({ ...stored, updatedAt: OPENED_AT })
		const before = Rules.nextRuleId([], null)
		const after = Rules.nextRuleId(Arr.map(opened.rules, Rules.draftOf), opened.updatedAt)
		expect(after).not.toBe(before)
		expect(Arr.map(opened.rules, (rule) => rule.id)).not.toContain(after)
	})

	test("a save is built on the stored rules the draft started from, not ones loaded behind an edit", () => {
		const opened = new GroupingConfigDocument({ ...stored, updatedAt: OPENED_AT })
		const newer = new GroupingConfigDocument({ ...stored, updatedAt: NEWER_AT })
		const editing = run(
			Rules.update(
				Rules.init().model,
				Rules.Message.CompletedFetchRules({ result: Result.succeed(opened) }),
				ADMIN,
			).model,
			[
				Rules.Message.ClickedAddRule(),
				Rules.Message.CompletedFetchRules({ result: Result.succeed(newer) }),
			],
		)
		expect(editing.baseUpdatedAt).toBe(OPENED_AT)
		const saved = run(editing, [
			Rules.Message.ClickedSaveRules(),
			Rules.Message.CompletedSaveRules({ result: Result.succeed(newer) }),
		])
		expect(saved.baseUpdatedAt).toBe(NEWER_AT)
	})

	test("a refused save puts each problem under the rule it names, the rest above the list", () => {
		const refused = run(loaded(ADMIN), [
			Rules.Message.ClickedSaveRules(),
			Rules.Message.CompletedSaveRules({
				result: Result.fail({
					message: "These grouping rules cannot be saved.",
					problems: Rules.problemsOf(
						["rule-3: a frame rule needs a frame pattern", "too many rules"],
						["rule-1", "rule-3"],
					),
				}),
			}),
		])
		scene(
			{ update: (model, message) => Rules.update(model, message, ADMIN), view: viewAs(true) },
			given(refused),
			expectView(text("A frame rule needs a frame pattern.")).toExist(),
			expectView(text("These grouping rules cannot be saved.")).toExist(),
			expectView(text("Too many rules.")).toExist(),
		)
	})

	test("a member reads the rules but cannot edit, add or save them", () => {
		const member = loaded(MEMBER)
		expect(run(member, [Rules.Message.ClickedAddRule()], MEMBER).draft).toEqual(member.draft)
		scene(
			{ update: (model, message) => Rules.update(model, message, MEMBER), view: viewAs(false) },
			given(member),
			expectView(role("button", { name: "Save rules" })).toBeDisabled(),
			expectView(role("textbox", { name: "Title" })).toBeDisabled(),
		)
	})

	test("with no rules the editor says so and adds one on demand", () => {
		const empty = Rules.update(
			Rules.init().model,
			Rules.Message.CompletedFetchRules({
				result: Result.succeed(new GroupingConfigDocument({ rules: [], updatedAt: null })),
			}),
			ADMIN,
		).model
		scene(
			{ update: (model, message) => Rules.update(model, message, ADMIN), view: viewAs(true) },
			given(empty),
			expectView(text("No grouping rules yet")).toExist(),
			click(role("button", { name: "Add rule" })),
			expectView(text("rule-0-1")).toExist(),
		)
	})
})
