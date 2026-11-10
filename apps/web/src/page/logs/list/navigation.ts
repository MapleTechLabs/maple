import { AppRoute, hrefOf } from "../../../route"
import { PageOutMessage, type PageReturn } from "../../contract"
import type { Search } from "./derive"
import type { Message } from "./message"
import type { Model } from "./model"

/** The list's URL search, as a new history entry or (`isReplace`) in place. */
export const navigate = (model: Model, search: Search, isReplace = false): PageReturn<Model, Message> => ({
	model,
	outMessage: PageOutMessage.RequestedNavigation({ url: hrefOf(AppRoute.Logs({ search })), isReplace }),
})
