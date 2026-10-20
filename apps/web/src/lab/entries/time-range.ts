import * as Page from "../time-range-lab"
import { defineShellLab } from "../shell-lab"

// `/lab/time-range`: the time range picker over plain state.
// TODO(picker): the "D" hotkey, the timezone list and the custom tab are the picker's own gaps.

export const lab = defineShellLab("Time range picker", {
	Model: Page.Model,
	Message: Page.Message,
	Flags: Page.Flags,
	flags: Page.flags,
	init: Page.init,
	update: Page.update,
	view: Page.view,
	currentPath: "/lab/time-range",
	breadcrumbs: [{ label: "Lab" }, { label: "Time range picker" }],
})
