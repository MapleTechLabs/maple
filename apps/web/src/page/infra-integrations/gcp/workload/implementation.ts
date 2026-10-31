import { gcpWorkloadName } from "../../../../components/infra/gcp/tabs"
import { implementPage } from "../../../contract"
import { entry } from "./index"
import { contextChanged, init, keysOf, routeChanged, update } from "./update"
import { view } from "./view"
import { platformSource } from "../../../../shell/source-link"

export const implementation = implementPage(entry, {
	init,
	update,
	routeChanged,
	contextChanged,
	view,
	source: () => platformSource("gcp"),
	breadcrumbs: (model) => [
		{ label: "Infrastructure", href: "/infra" },
		// Back to the tab the workload is listed on.
		{ label: "Google Cloud", href: `/infra/gcp?tab=${model.service}` },
		{ label: gcpWorkloadName(model.service, keysOf(model)) },
	],
})
