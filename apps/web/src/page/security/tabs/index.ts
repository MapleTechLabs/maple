import { definePage } from "../../contract"
import { Message } from "./model"
import { Model } from "./model"

/**
 * `/security` and its tabs (Overview, Findings, Runs) as one instance per org: a tab change keeps
 * the instance, so the targets, runs and findings one tab read serve the next.
 */
export const entry = definePage(
	"Security",
	{ Model, Message },
	{ routes: ["Security", "SecurityFindings", "SecurityRuns"], key: () => "security" },
)

export const page = entry.lazy(() => import("./implementation"))
