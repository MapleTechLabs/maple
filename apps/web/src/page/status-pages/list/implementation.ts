import { implementPage } from "../../contract"
import { entry } from "./index"
import { init, update } from "./update"
import { view } from "./view"

export const implementation = implementPage(entry, {
	init,
	update,
	view,
	breadcrumbs: () => [{ label: "Status pages", isPageHeading: true }],
})
