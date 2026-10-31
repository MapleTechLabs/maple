import { gcpWorkloadName } from "../../../../components/infra/gcp/tabs"
import { definePage } from "../../../contract"
import { Message, Model } from "./model"
import { contextChanged, init, keysOf, routeChanged, update } from "./update"
import { view } from "./view"
import { platformSource } from "../../../../shell/source-link"

/** `/infra/gcp/$service/$name`: one workload, or a Cloud SQL instance; each is its own instance. */
export const page = definePage(
	"InfraGcpResource",
	{ Model, Message },
	{
		routes: ["InfraGcpResource"],
		key: (route) => `InfraGcpResource:${route.service}:${route.name}`,
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
	},
)
