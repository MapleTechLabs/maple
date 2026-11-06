import { expect as expectView, given, Mount, role, scene, withViewInputs } from "foldkit/scene"
import { describe, test } from "vitest"
import * as Dialog from "@maple/views/ui/dialog"
import { MountDialog } from "@maple/views/ui/dialog"
import { chainDestinations, chainOf } from "../shared/escalation-test-fixtures"
import { init, Message, openEdit, update } from "./dialog"
import { view as dialogView } from "./view"

const view = withViewInputs(dialogView, { id: "chain", destinations: chainDestinations })()
const editing = () =>
	openEdit(
		init("chain"),
		chainOf({
			n: 1,
			name: "Checkout on-call",
			steps: [
				{ destinations: [1], wait: 10 },
				{ destinations: [2], wait: 15 },
			],
			repeat: 1,
		}),
	).model

describe("escalation chain dialog view", () => {
	test("while a save is in flight the fields and step controls are disabled", () => {
		scene(
			{ update, view },
			given(update(editing(), Message.ClickedSave()).model),
			Mount.resolve(MountDialog, Dialog.Message.CompletedMountDialog()),
			expectView(role("textbox", { name: "Name" })).toBeDisabled(),
			expectView(role("textbox", { name: "Description" })).toBeDisabled(),
			expectView(role("spinbutton", { name: "Repeat the whole chain" })).toBeDisabled(),
			expectView(role("button", { name: "Move step 1 down" })).toBeDisabled(),
			expectView(role("button", { name: "Remove step 1" })).toBeDisabled(),
			expectView(role("button", { name: "Add step" })).toBeDisabled(),
			expectView(role("button", { name: /^Stop notifying/ })).toBeDisabled(),
		)
	})

	test("before a save the same controls are editable", () => {
		scene(
			{ update, view },
			given(editing()),
			Mount.resolve(MountDialog, Dialog.Message.CompletedMountDialog()),
			expectView(role("textbox", { name: "Name" })).not.toBeDisabled(),
			expectView(role("spinbutton", { name: "Repeat the whole chain" })).not.toBeDisabled(),
			expectView(role("button", { name: "Add step" })).not.toBeDisabled(),
		)
	})
})
