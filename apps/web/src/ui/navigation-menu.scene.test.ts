import * as Animation from "@foldkit/ui/animation"
import { inertHtml as ih } from "foldkit/html"
import { click, Command, expect, given, Mount, role, scene, text, withViewInputs } from "foldkit/scene"
import { expect as assert, describe, test } from "vitest"
import { init, Message, MountNavigationMenu, update, view } from "./navigation-menu"

/** Navigation menu: a trigger opens its content in the shared popup; hovering another switches it. */
const ID = "site-nav"

const sceneView = withViewInputs(view, {
	items: [
		{ _tag: "Trigger", value: "product", label: "Product", content: [ih.a([], ["Traces"])] },
		{
			_tag: "Trigger",
			value: "docs",
			label: "Docs",
			content: [ih.div([], ["Guides and API reference."])],
		},
		{ _tag: "Link", label: "Pricing", href: "#pricing" },
	],
})
const config = { update, view: sceneView() }
const product = role("button", { name: /^Product/ })

describe("navigation menu scene", () => {
	test("defaultValue renders that item open; its trigger is expanded and the others are not", () => {
		scene(
			config,
			given(init(ID, { value: "product" })),
			Mount.resolve(MountNavigationMenu, Message.CompletedMountNavigationMenu()),
			expect(product).toHaveAttr("aria-expanded", "true"),
			expect(role("button", { name: /^Docs/ })).toHaveAttr("aria-expanded", "false"),
			expect(text("Traces")).toExist(),
			expect(text("Guides and API reference.")).toBeAbsent(),
		)
	})

	test("clicking a closed trigger opens its content", () => {
		scene(
			config,
			given(init(ID)),
			click(product),
			Mount.resolve(MountNavigationMenu, Message.CompletedMountNavigationMenu()),
			Command.resolve(
				Animation.WaitForPaint,
				Animation.Message.CompletedWaitForPaint({ generation: 1 }),
			),
			Command.resolve(
				Animation.WaitForAnimationSettled,
				Animation.Message.EndedAnimation({ generation: 1 }),
			),
			expect(product).toHaveAttr("aria-expanded", "true"),
			expect(text("Traces")).toExist(),
		)
	})

	test("hovering another trigger switches the open content after the delay; a stale delay is dropped", () => {
		const open = init(ID, { value: "product" })
		const entered = update(open, Message.EnteredTrigger({ value: "docs" }))
		const left = update(entered.model, Message.EnteredPopup())
		const stale = update(left.model, Message.ElapsedHoverDelay({ generation: 1, value: "docs" }))
		assert(stale.model.value).toBe("product")
		const switched = update(entered.model, Message.ElapsedHoverDelay({ generation: 1, value: "docs" }))
		assert({ isOpen: switched.model.isOpen, value: switched.model.value }).toEqual({
			isOpen: true,
			value: "docs",
		})
	})
})
