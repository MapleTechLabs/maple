import { definePage } from "../../contract"
import { Message } from "./message"
import { Model } from "./model"
import { pageCode } from "../../code"

/** `/status-pages/$pageId`: one instance per page; Settings, JSON and the live screen are search. */
export const entry = definePage(
	"StatusPage",
	{ Model, Message },
	{ routes: ["StatusPage"], key: (route) => route.pageId },
)

export const page = entry.lazy(pageCode.StatusPage)
