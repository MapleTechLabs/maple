import { Submodel } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { errorState } from "@maple/views/ui/error-state"
import { vstack } from "@maple/views/ui/stack"
import type { PageViewInputs } from "../../contract"
import { securityLayout } from "../kit/layout"
import { focusedRepositoryOf, pageStateOf } from "./derive"
import { Message, type Model } from "./model"
import { allRepositoriesPane } from "./view-matrix"
import { repositoryPane } from "./view-repository"
import { findingSheet } from "./view-sheet"
import { dependenciesLoading, footnote, notConnected } from "./view-states"

// The Dependencies tab inside the Security frame: a switcher scopes it to one repository or all of
// them. No plan gate: it reads lockfiles.

type H = HtmlBuilder<Message>
type Clock = Readonly<{ nowMs: number; timeZone: string }>

const body = (h: H, model: Model, clock: Clock): ReadonlyArray<Html> => {
	const state = pageStateOf(model)
	switch (state._tag) {
		case "Loading":
			return dependenciesLoading(h)
		case "Failed":
			return [
				errorState(h, {
					failure: state.failure,
					title: "Couldn't load dependency scans",
					onRetry: Message.ClickedRetry(),
				}),
			]
		case "NotConnected":
			return [notConnected(h)]
		case "Ready": {
			const focused = focusedRepositoryOf(model)
			return [
				vstack(h, { gap: "4" }, [
					...(focused === null
						? allRepositoriesPane(h, model, state, clock)
						: repositoryPane(h, model, { ...state, repository: focused }, clock)),
					footnote(h),
				]),
			]
		}
	}
}

export const view = Submodel.defineView<Model, Message, PageViewInputs>((model, inputs, h) => {
	const clock: Clock = { nowMs: model.nowMs, timeZone: inputs.context.timeZone }
	return securityLayout(
		h,
		{ source: "dependencies", overlay: [findingSheet(h, model, clock)] },
		body(h, model, clock),
	)
})
