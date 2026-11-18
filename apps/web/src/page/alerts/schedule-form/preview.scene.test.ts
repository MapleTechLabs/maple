import * as Policy from "@maple/domain/policy"
import { OrgId } from "@maple/domain"
import { Result, Schema, Array as Arr } from "effect"
import { expect as expectView, given, scene, text, withViewInputs } from "foldkit/scene"
import type { Html, HtmlBuilder } from "foldkit/html"
import { Lazy } from "foldkit/test"
import { expect, test } from "vitest"
import type { PageContext } from "../../contract"
import { memberId, ONCALL_NOW, oncallMembers } from "../shared/oncall-test-fixtures"
import { ORG } from "../../kit/alert-test-rows"
import { Message } from "./message"
import type { Model } from "./model"
import { init, update } from "./update"
import { schedulePreview } from "./preview"
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

/** Renders `first`, then `second` on the next render: `Lazy.expectAllReused` throws when a slot misses. */
const previewOf = (first: Model, second: Model) => {
	const renders = { count: 0 }
	return (_model: Model, h: HtmlBuilder<Message>): Html =>
		schedulePreview(h, renders.count++ === 0 ? first : second)
}

test("typing the name keeps the drawn preview; a new range draws it again", () => {
	const model = staffed()
	const named = Arr.reduce(
		[
			Message.ChangedName({ value: "Checkout primary" }),
			Message.ChangedDescription({ value: "Who swaps" }),
		],
		model,
		(current, message) => pageUpdate(current, message).model,
	)
	Lazy.expectAllReused({ view: previewOf(model, named), model })
	const ranged = pageUpdate(model, Message.PickedPreviewRange({ days: "28" })).model
	expect(() => Lazy.expectAllReused({ view: previewOf(model, ranged), model })).toThrow(/ArgumentsChanged/)
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
