import { definePage } from "../../contract"
import { Message } from "./message"
import { Model } from "./model"

/** `/settings/ingestion/rules/new` and `/settings/ingestion/rules/:id`: one instance per rule, or the new one. */
export const entry = definePage(
	"IngestRuleEditor",
	{ Model, Message },
	{
		routes: ["IngestRuleNew", "IngestRule"],
		key: (route) => (route._tag === "IngestRule" ? route.ruleId : `new:${route.search.template ?? ""}`),
	},
)

export const page = entry.lazy(() => import("./implementation"))
