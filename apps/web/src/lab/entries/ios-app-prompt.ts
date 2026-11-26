import { Option } from "effect"
import { emptyMessage } from "@maple/views/ui/empty"
import type { ShellClerk } from "../../shell/model"
import { defineStaticShellLab } from "../static-shell-lab"

// `/lab/ios-app-prompt`: the sidebar's iPhone app row and its popover, for a signed-in user who has not dismissed it.
// "Don't show again" writes this fixture user's key, so a reload keeps it closed until the key is removed.

const LAB_CLERK: ShellClerk = {
	maybeUserId: Option.some("user_lab"),
	maybeUser: Option.some({ fullName: "Ada Lovelace", email: "ada@example.com", imageUrl: "" }),
	maybeOrganization: Option.none(),
	memberships: [],
	customer: undefined,
	customerReadAtMs: 0,
	maybeGrants: Option.none(),
}

export const lab = defineStaticShellLab("iPhone app prompt", {
	currentPath: "/lab/ios-app-prompt",
	breadcrumbs: [{ label: "Lab" }, { label: "iPhone app prompt" }],
	clerk: LAB_CLERK,
	page: (h) => emptyMessage(h, {}, ["The row sits with the sidebar's footer rows; it opens a popover."]),
})
