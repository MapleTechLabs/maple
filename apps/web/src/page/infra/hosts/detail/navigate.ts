import { AppRoute, hrefOf } from "../../../../route"
import { PageOutMessage } from "../../../out-message"
import type { Model } from "./model"

export type Search = Model["search"]

/** The root owns the URL: a new search is asked for, and re-enters the route. */
export const navigate = (
	model: Model,
	search: Search,
): Readonly<{ model: Model; outMessage: PageOutMessage }> => ({
	model,
	outMessage: PageOutMessage.RequestedNavigation({
		url: hrefOf(AppRoute.InfraHost({ hostName: model.hostName, search })),
		isReplace: false,
	}),
})
