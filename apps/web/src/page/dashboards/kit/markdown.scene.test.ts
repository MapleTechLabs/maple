import { Submodel } from "foldkit"
import { expect, given, role, scene, text, withViewInputs } from "foldkit/scene"
import { describe, test } from "vitest"
import { renderMarkdown } from "./markdown"

const note = withViewInputs(
	Submodel.defineView<string, never, Record<string, never>>((content, _inputs, h) =>
		h.div([], renderMarkdown(h, content)),
	),
	{},
)()

const config = { update: (model: string) => ({ model }), view: note }

describe("markdown note", () => {
	test("headings, bullets and inline marks render as their elements", () => {
		scene(
			config,
			given("# Runbook\n- **Page** on-call\n- see `kubectl logs`"),
			expect(text("Runbook")).toExist(),
			expect(role("listitem", { name: /Page on-call/ })).toExist(),
			expect(role("strong")).toHaveText("Page"),
			expect(role("code")).toHaveText("kubectl logs"),
		)
	})

	test("a safe link opens in a new tab; a javascript: link is plain text", () => {
		scene(
			config,
			given("[Docs](https://maple.dev) and [bad](javascript:alert(1))"),
			expect(role("link", { name: "Docs" })).toHaveAttr("href", "https://maple.dev"),
			expect(role("link", { name: "bad" })).toBeAbsent(),
			expect(text("bad")).toExist(),
		)
	})
})
