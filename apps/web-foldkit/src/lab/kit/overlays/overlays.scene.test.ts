import { all, expect, expectAll, given, Mount, role, scene, type } from "foldkit/scene"
import { describe, test } from "vitest"
import * as Dialog from "../../../ui/dialog"
import * as Toast from "../../../ui/toast"
import { init, update } from "./update"
import { view } from "./view"

/** The `/lab/kit/overlays` gallery: `?item=` opens one overlay; the command palette filters. */
const config = { update, view }
const toastPortals = () => [
	Mount.resolve(Toast.PortalToasts, Toast.Message.CompletedPortalToasts()),
	Mount.resolve(Toast.PortalToasts, Toast.Message.CompletedPortalToasts()),
]

describe("kit overlays gallery", () => {
	test("without an item it lists every overlay and opens none", () => {
		scene(
			config,
			given(init({ item: null }).model),
			...toastPortals(),
			expectAll(all.role("link")).toHaveCount(18),
			expect(role("dialog")).toBeAbsent(),
		)
	})

	test("an unknown item is ignored; a known one is marked current and rendered open", () => {
		scene(
			config,
			given(init({ item: "nope" }).model),
			...toastPortals(),
			expect(role("region", { name: "nope" })).toBeAbsent(),
		)
		scene(
			config,
			given(init({ item: "alert-dialog" }).model),
			...toastPortals(),
			Mount.resolve(Dialog.MountDialog, Dialog.Message.CompletedMountDialog()),
			expect(role("link", { name: "alert-dialog" })).toHaveAttr("aria-current", "page"),
			expect(role("alertdialog", { name: "Delete this alert rule?" })).toExist(),
		)
	})

	test("the command palette filters its groups as the input changes, keeping the first match active", () => {
		scene(
			config,
			given(init({ item: "command" }).model),
			...toastPortals(),
			Mount.resolve(Dialog.MountDialog, Dialog.Message.CompletedMountDialog()),
			expectAll(all.role("option")).toHaveCount(5),
			type(role("combobox"), "da"),
			expectAll(all.role("option")).toHaveCount(1),
			expect(role("option", { name: "Create dashboard" })).toHaveAttr("data-highlighted", ""),
			expect(role("group", { name: "Pages" })).toBeAbsent(),
		)
	})
})
