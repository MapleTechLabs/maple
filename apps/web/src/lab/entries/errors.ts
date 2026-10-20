import * as Page from "../errors-lab/model"
import { ErrorsLabFlags, errorsLabFlags, init, update } from "../errors-lab/update"
import { view } from "../errors-lab/view"
import { defineShellLab } from "../shell-lab"

// `/lab/errors`: the errors hub over fixtures, inside the real shell.

export const lab = defineShellLab("Errors", {
	Model: Page.Model,
	Message: Page.Message,
	Flags: ErrorsLabFlags,
	flags: errorsLabFlags,
	init: (flags) => ({ model: init(flags) }),
	update,
	view,
	currentPath: "/lab/errors",
	breadcrumbs: [{ label: "Lab" }, { label: "Errors" }],
})
