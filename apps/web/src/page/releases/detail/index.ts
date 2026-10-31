import { definePage } from "../../contract"
import { Message } from "./message"
import { Model } from "./model"
import { pageCode } from "../../code"

/** `/releases/$commitSha`: one instance per commit; a search change arrives as `routeChanged`. */
export const entry = definePage(
	"Release",
	{ Model, Message },
	{ routes: ["Release"], key: (route) => route.commitSha },
)

export const page = entry.lazy(pageCode.Release)
