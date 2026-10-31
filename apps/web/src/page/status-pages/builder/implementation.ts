import { implementPage } from "../../contract"
import { entry } from "./index"
import { statusPagesHref } from "../shared/commands"
import { init, update } from "./update"
import { view } from "./view"

export const implementation = implementPage(entry, {
	init,
	update,
	view,
	breadcrumbs: () => [
		{ label: "Status pages", href: statusPagesHref() },
		{ label: "New", isPageHeading: true },
	],
})
