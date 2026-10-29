import { definePage } from "../../contract"
import { statusPagesHref } from "../shared/commands"
import { Message } from "./message"
import { Model } from "./model"
import { init, update } from "./update"
import { view } from "./view"

/** `/status-pages/new`: the one-screen builder. */
export const page = definePage(
	"StatusPageNew",
	{ Model, Message },
	{
		routes: ["StatusPageNew"],
		init,
		update,
		view,
		breadcrumbs: () => [
			{ label: "Status pages", href: statusPagesHref() },
			{ label: "New", isPageHeading: true },
		],
	},
)
