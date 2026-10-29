import { definePage } from "../../contract"
import { Message } from "./message"
import { Model } from "./model"

/** `/errors/issues/$issueId`: one instance per issue; tab and window changes arrive as `routeChanged`. */
export const entry = definePage(
	"ErrorIssue",
	{ Model, Message },
	{ routes: ["ErrorIssue"], key: (route) => route.issueId },
)

export const page = entry.lazy(() => import("./implementation"))
