import * as Policy from "@maple/domain/policy"
import { OrgId } from "@maple/domain"
import { Option, Result, Schema, Array as Arr } from "effect"
import {
	click,
	expect as expectView,
	find,
	given,
	role,
	scene,
	tap,
	text,
	type,
	withViewInputs,
} from "foldkit/scene"
import { expect, test } from "vitest"
import type { PageContext } from "../../contract"
import { memberId, ONCALL_NOW, oncallMembers } from "../shared/oncall-test-fixtures"
import { ORG } from "../shared/test-rows"
import { Message } from "./message"
import type { Model } from "./model"
import { init, update } from "./update"
import { view as pageView } from "./view"

// The preview renders the whole schedule, so it must not redo that work on edits it does not read.

const context: PageContext = { orgId: Schema.decodeSync(OrgId)(ORG), pinnedNamespace: null, timeZone: "UTC" }
const pageUpdate = (model: Model, message: Message) => update(model, message, context)
const view = withViewInputs(pageView, { context })()

const staffed = (): Model =>
	Arr.reduce(
		[
			Message.ReadDefaults({
				timeZone: "Europe/Berlin",
				nowMs: ONCALL_NOW,
				zones: ["UTC", "Europe/Berlin"],
			}),
			Message.CompletedFetchMembers({ result: Result.succeed(oncallMembers) }),
			Message.CompletedFetchSession({ orgId: ORG, grants: Policy.grantsOf(["org:engineer"]) }),
			Message.GotParticipantMenuMessage({
				key: "l0",
				message: { _tag: "ClickedItem", index: 0, item: { kind: "Item", value: memberId(0) } },
			}),
		],
		init({ _tag: "AlertsScheduleNew", search: {} }, context).model,
		(model, message) => pageUpdate(model, message).model,
	)

test("typing the name keeps the drawn preview; a new range draws it again", () => {
	// The preview's rendered node: the same object while nothing it reads has changed.
	const drawn: Array<unknown> = []
	const keep = tap<Model, Message>((simulation) => {
		drawn.push(Option.getOrNull(find(simulation.html, '[data-slot="coverage-preview"]')))
	})
	scene(
		{ update: pageUpdate, view },
		given(staffed()),
		expectView(text("Covered in this period")).toExist(),
		keep,
		type(role("textbox", { name: "Name" }), "Checkout primary"),
		type(role("textbox", { name: "Description (optional)" }), "Who swaps with whom"),
		keep,
		click(role("button", { name: "4 weeks" })),
		expectView(text("Covered in this period")).toExist(),
		keep,
	)
	expect(drawn[0]).not.toBeNull()
	expect(drawn[1]).toBe(drawn[0])
	expect(drawn[2]).not.toBe(drawn[0])
})

test("the clock moves the preview's now line while the editor stays open", () => {
	scene(
		{ update: pageUpdate, view },
		given(staffed()),
		expectView(text("Now, Tue 10 Nov, 11:30")).toExist(),
	)
	scene(
		{ update: pageUpdate, view },
		given(pageUpdate(staffed(), Message.ReadClock({ nowMs: ONCALL_NOW + 45 * 60_000 })).model),
		expectView(text("Now, Tue 10 Nov, 12:15")).toExist(),
		expectView(text("Now, Tue 10 Nov, 11:30")).toBeAbsent(),
	)
})
