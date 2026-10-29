import { definePage } from "../../contract"
import { Message } from "./message"
import { Model } from "./model"

/** `/investigations/$id`: one instance per investigation; the tab and open action are search state. */
export const entry = definePage(
	"Investigation",
	{ Model, Message },
	{ routes: ["Investigation"], key: (route) => route.id },
)

export const page = entry.lazy(() => import("./implementation"))
