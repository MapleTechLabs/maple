import { Submodel } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { errorState } from "../../../ui/error-state"
import type { PageViewInputs } from "../../contract"
import { securityLayout } from "../kit/layout"
import { focusedRepositoryOf, pageStateOf, scannedCount } from "./derive"
import { Message, type Model } from "./model"
import { repositoryBreakdown } from "./view-breakdown"
import { findingsSection } from "./view-findings"
import { repositoriesPanel } from "./view-repositories"
import { findingSheet } from "./view-sheet"
import { dependenciesLoading, firstScan, footnote, notConnected, severityRail } from "./view-states"

// The Dependencies tab inside the Security frame. No plan gate: it reads lockfiles.

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
			return scannedCount(state.repositories) === 0
				? [
						firstScan(h, model, state.repositories),
						repositoriesPanel(
							h,
							model,
							state.repositories,
							state.findings,
							focused?.id ?? null,
							clock,
						),
					]
				: [
						severityRail(h, state.findings, state.repositories, focused),
						repositoriesPanel(
							h,
							model,
							state.repositories,
							state.findings,
							focused?.id ?? null,
							clock,
						),
						...(focused === null
							? []
							: [repositoryBreakdown(h, focused, state.findings, state.production)]),
						h.div(
							[h.Class("flex flex-col gap-2")],
							[findingsSection(h, model, state, clock), footnote(h)],
						),
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
