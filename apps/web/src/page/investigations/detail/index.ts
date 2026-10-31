import { definePage } from "../../contract"
import { Message } from "./message"
import { Model } from "./model"
import { pageCode } from "../../code"

/** `/investigations/$id`: one instance per investigation; the tab and open action are search state. */
export const entry = definePage(
	"Investigation",
	{ Model, Message },
	{ routes: ["Investigation"], key: (route) => route.id },
)

export const page = entry.lazy(pageCode.Investigation)
