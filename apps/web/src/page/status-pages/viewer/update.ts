import { Option } from "effect"
import * as Keyed from "@maple/views/data/keyed"
import { requestKey } from "@maple/views/data/request-key"
import type { AppRoute } from "../../../route"
import type { PageContext, PageReturn } from "../../contract"
import { pageIdFromUrl } from "../shared/commands"
import { FetchView } from "./command"
import { Message } from "./message"
import type { Model } from "./model"

export type Return = PageReturn<Model, Message>

type ViewRoute = Extract<AppRoute, { readonly _tag: "StatusPageView" }>

const request = (model: Model, context: PageContext, mode: Keyed.ReadMode): Return => {
	const pageId = model.pageId
	if (pageId === null) return { model }
	return Option.match(
		Keyed.requestFor(model.snapshot, requestKey(context.orgId, "statusPages.view", { pageId }), mode),
		{
			onNone: () => ({ model }),
			onSome: (snapshot) => ({
				model: { ...model, snapshot },
				commands: [FetchView({ key: snapshot.key, pageId })],
			}),
		},
	)
}

export const init = (route: ViewRoute, context: PageContext): Return =>
	request(
		{ pageId: Option.getOrNull(pageIdFromUrl(route.pageId)), snapshot: Keyed.idle() },
		context,
		"Load",
	)

export const update = (model: Model, message: Message, context: PageContext): Return =>
	Message.match<Return>(message, {
		CompletedFetchView: ({ key, result }) => ({
			model: { ...model, snapshot: Keyed.accept(model.snapshot, key, result) },
		}),
		ClickedRetry: () => request(model, context, "Supersede"),
	})
