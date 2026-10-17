import type { OrgId } from "@maple/domain"
import { Option } from "effect"
import type { Update } from "foldkit"
import * as Keyed from "../../data/keyed"
import { requestKey } from "../../data/request-key"
import type { TimeWindow } from "../../data/time-range"
import type { Resources } from "../../platform/resources"
import { CheckProbeSession, FetchServicesFacets, ResolveWindow } from "./command"
import { foldLabToasts, initLabToasts } from "../toasts"
import { Message, type Model } from "./model"

type UpdateReturn = Update.Return<Model, Message, Resources>

export const init = (): UpdateReturn => ({
	model: {
		session: "Checking",
		orgId: null,
		facets: Keyed.idle(),
		alertRuleCount: null,
		toasts: initLabToasts(),
	},
	commands: [CheckProbeSession()],
})

/** What `getServicesFacetsResultAtom({ data: window })` becomes: a keyed request on the slot. */
const requestFacets = (
	model: Model,
	orgId: OrgId,
	window: TimeWindow,
	mode: Keyed.RequestMode,
): UpdateReturn => {
	const key = requestKey(orgId, "getServicesFacets", { data: window })
	return Option.match(Keyed.request(model.facets, key, mode), {
		onNone: () => ({ model }),
		onSome: (facets) => ({
			model: { ...model, facets },
			commands: [FetchServicesFacets({ key, window })],
		}),
	})
}

const foldToasts = foldLabToasts<Model, Message>((message) => Message.GotToastMessage({ message }))

export const update = (model: Model, message: Message): UpdateReturn =>
	Message.match<UpdateReturn>(message, {
		SucceededCheckProbeSession: ({ orgId }) => ({
			model: { ...model, session: "SignedIn", orgId },
			commands: [ResolveWindow({ mode: "Load" })],
		}),
		FailedCheckProbeSession: ({ session }) => ({ model: { ...model, session } }),
		CompletedResolveWindow: ({ window, mode }) =>
			model.orgId === null ? { model } : requestFacets(model, model.orgId, window, mode),
		CompletedFetchServicesFacets: ({ key, result }) => ({
			model: { ...model, facets: Keyed.accept(model.facets, key, result) },
		}),
		// A liveQuery emission from the previous org's Subscription can still be queued: drop it.
		UpdatedAlertRules: ({ orgId, count }) =>
			orgId === model.orgId ? { model: { ...model, alertRuleCount: count } } : { model },
		ClickedRefresh: () => ({ model, commands: [ResolveWindow({ mode: "Refresh" })] }),
		GotToastMessage: ({ message }) => foldToasts(model, message),
	})
