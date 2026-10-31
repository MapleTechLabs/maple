import { implementPage } from "../../contract"
import { entry } from "./index"
import { ingestionHref } from "./hrefs"
import { init, update } from "./update"
import { view } from "./view"

export const implementation = implementPage(entry, {
	init,
	update,
	view,
	breadcrumbs: () => [
		{ label: "Settings", href: "/settings" },
		{ label: "Ingestion", href: ingestionHref() },
	],
})
