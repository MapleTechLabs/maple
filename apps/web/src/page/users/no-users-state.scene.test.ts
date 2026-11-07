import { OrgId } from "@maple/domain"
import * as CopyButton from "@maple/views/ui/copy-button"
import { Schema } from "effect"
import type { Html, HtmlBuilder } from "foldkit/html"
import { click, Command, expect as expectView, given, role, scene } from "foldkit/scene"
import { describe, test } from "vitest"
import { IDENTIFY_USERS_PROMPT } from "../../components/ingest/onboard-skill"
import type { PageContext } from "../contract"
import { Message } from "./list/message"
import type { Model } from "./list/model"
import { init, update as updateWith } from "./list/update"
import { noUsersState } from "./view-states"

const context: PageContext = {
	orgId: Schema.decodeSync(OrgId)("org_acme"),
	pinnedNamespace: null,
	timeZone: "UTC",
}

const update = (model: Model, message: Message) => updateWith(model, message, context)

const view = (model: Model, h: HtmlBuilder<Message>): Html =>
	noUsersState(h, {
		promptCopy: model.promptCopy,
		toPromptCopyMessage: (message) => Message.GotPromptCopyMessage({ message }),
		docsHref: "/docs/explore/users",
	})

describe("users empty state", () => {
	test("copies the identify-users agent prompt, then says so", () => {
		scene(
			{ update, view },
			given(init({ search: {} }, context).model),
			click(role("button", { name: "Build with your agent" })),
			Command.expectExact(CopyButton.WriteClipboard({ text: IDENTIFY_USERS_PROMPT, generation: 1 })),
			Command.resolve(CopyButton.WriteClipboard, CopyButton.Message.SucceededCopy({ generation: 1 })),
			expectView(role("button", { name: "Prompt copied" })).toHaveAttr("data-copy-state", "copied"),
			Command.resolve(
				CopyButton.WaitCopyStatus,
				CopyButton.Message.ElapsedCopyStatus({ generation: 1 }),
			),
			expectView(role("button", { name: "Build with your agent" })).toHaveAttr(
				"data-copy-state",
				"idle",
			),
		)
	})
})
