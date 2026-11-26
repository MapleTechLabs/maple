import * as CopyButton from "@maple/views/ui/copy-button"
import type { Html, HtmlBuilder } from "foldkit/html"
import { click, Command, expect as expectView, given, role, scene, text } from "foldkit/scene"
import { describe, test } from "vitest"
import { codeBlock } from "./code-block"

const MASKED = "MAPLE_INGEST_KEY=maple_sk_•••• bunx alchemy deploy maple.ts"
const REAL = "MAPLE_INGEST_KEY=maple_sk_real bunx alchemy deploy maple.ts"

const update = (model: CopyButton.Model, message: CopyButton.Message) => CopyButton.update(model, message)

const view = (model: CopyButton.Model, h: HtmlBuilder<CopyButton.Message>): Html =>
	codeBlock(h, {
		code: MASKED,
		copyValue: REAL,
		language: "Deploy",
		lang: "shell",
		copy: model,
		toCopyMessage: (message) => message,
	})

describe("codeBlock", () => {
	test("shows the masked command and copies the real one", () => {
		scene(
			{ update, view },
			given(CopyButton.init()),
			expectView(text(REAL)).not.toExist(),
			click(role("button", { name: "Copy Code" })),
			Command.expectExact(CopyButton.WriteClipboard({ text: REAL, generation: 1 })),
			Command.resolve(CopyButton.WriteClipboard, CopyButton.Message.SucceededCopy({ generation: 1 })),
			Command.resolve(
				CopyButton.WaitCopyStatus,
				CopyButton.Message.ElapsedCopyStatus({ generation: 1 }),
			),
		)
	})
})
