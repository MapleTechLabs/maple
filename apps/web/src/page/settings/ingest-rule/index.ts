import { definePage } from "../../contract"
import { ingestionHref } from "./hrefs"
import { Message } from "./message"
import { Model } from "./model"
import { init, update } from "./update"
import { view } from "./view"

/** `/settings/ingestion/rules/new` and `/settings/ingestion/rules/:id`: one instance per rule, or the new one. */
export const page = definePage(
	"IngestRuleEditor",
	{ Model, Message },
	{
		routes: ["IngestRuleNew", "IngestRule"],
		key: (route) => (route._tag === "IngestRule" ? route.ruleId : `new:${route.search.template ?? ""}`),
		init,
		update,
		view,
		breadcrumbs: () => [
			{ label: "Settings", href: "/settings" },
			{ label: "Ingestion", href: ingestionHref() },
		],
	},
)
