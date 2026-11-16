import { OrgId } from "@maple/domain"
import { toLoadFailure } from "@maple/views/data/load-failure"
import { Effect, Option, Result, Schema, Array as Arr } from "effect"
import { AsyncData, Command, type Update } from "foldkit"
import type { HtmlBuilder } from "foldkit/html"
import { defineMessageUnion } from "foldkit/message"
import { fromString as urlFromString } from "foldkit/url"
import type { PageContext, PageReturn } from "../../page/contract"
import { Message as PageMessage } from "../../page/services/detail/message"
import { Model as PageModel } from "../../page/services/detail/model"
import * as DetailUpdate from "../../page/services/detail/update"
import { view as pageView } from "../../page/services/detail/view"
import type { Resources } from "../../platform/resources"
import { urlToAppRoute } from "../../route"
import { PROFILES_NOW, PROFILES_PROFILE, PROFILES_SERVICE } from "../service-profiles-fixture"
import { defineShellLab } from "../shell-lab"

// `/lab/service-profiles`: the service page's Profiles tab over one hour of `checkout-api`, in the
// real shell. `?state=empty` is a service that sent no profiles, `?state=failed` a failed read.
// Reads are answered from the fixture, nothing leaves the tab.

const CONTEXT: PageContext = {
	orgId: Schema.decodeSync(OrgId)("org_lab_service_profiles"),
	pinnedNamespace: null,
	timeZone: "UTC",
	hasProfiling: true,
}

const LabState = Schema.Literals(["loaded", "empty", "failed"])
type LabState = typeof LabState.Type

const Flags = Schema.Struct({ state: LabState })
type Flags = typeof Flags.Type

const Model = Schema.Struct({ page: PageModel, state: LabState })
type Model = typeof Model.Type

const Message = defineMessageUnion({ GotPageMessage: { message: PageMessage } })
type Message = typeof Message.Type
type Return = Update.Return<Model, Message, Resources>

const isPending = (data: AsyncData.AsyncData<unknown, unknown>) =>
	AsyncData.isLoading(data) || AsyncData.isRefreshing(data)

/** The answers to every read still pending, as the Messages their fetches would have sent. */
const answers = (model: PageModel, state: LabState): ReadonlyArray<PageMessage> => [
	...(isPending(model.overview.data)
		? [
				PageMessage.CompletedFetchOverview({
					key: model.overview.key ?? "",
					result: Result.succeed({ points: [], releases: [], environments: ["production"] }),
				}),
			]
		: []),
	...(isPending(model.workloads.data)
		? [
				PageMessage.CompletedFetchWorkloads({
					key: model.workloads.key ?? "",
					result: Result.succeed([]),
				}),
			]
		: []),
	...(isPending(model.runtimes.data)
		? [PageMessage.CompletedFetchRuntimes({ key: model.runtimes.key ?? "", result: Result.succeed([]) })]
		: []),
	...(isPending(model.profile.data)
		? [
				PageMessage.CompletedFetchProfile({
					key: model.profile.key ?? "",
					result:
						state === "failed"
							? Result.fail(toLoadFailure("profile store down"))
							: Result.succeed(state === "empty" ? null : PROFILES_PROFILE),
				}),
			]
		: []),
]

/** Answers pending reads until none is left (an answer can start the next read). */
const settle = (
	result: PageReturn<PageModel, PageMessage>,
	state: LabState,
	depth = 0,
): PageReturn<PageModel, PageMessage> => {
	const pending = answers(result.model, state)
	if (pending.length === 0 || depth > 6) return result
	const next = Arr.reduce(pending, result, (acc, message): PageReturn<PageModel, PageMessage> => {
		const answered = DetailUpdate.update(acc.model, message, CONTEXT)
		return {
			model: answered.model,
			commands: [...(acc.commands ?? []), ...(answered.commands ?? [])],
			outMessage: acc.outMessage ?? answered.outMessage,
		}
	})
	return settle(next, state, depth + 1)
}

const isRead = (name: string) => /^(Fetch|ResolveServiceDetailClock)/.test(name)

const step = (result: PageReturn<PageModel, PageMessage>, state: LabState): Return => {
	const settled = settle(result, state)
	return {
		model: { page: settled.model, state },
		commands: Command.mapMessages(
			Arr.filter(settled.commands ?? [], (command) => !isRead(command.name)),
			(message) => Message.GotPageMessage({ message }),
		),
	}
}

/** The page's URL writes (a tab switch), applied to its own search the way a route change would. */
const follow = (model: PageModel, url: string): PageReturn<PageModel, PageMessage> =>
	Option.match(urlFromString(new URL(url, "http://localhost").href), {
		onNone: () => ({ model }),
		onSome: (parsed) => {
			const route = urlToAppRoute(parsed)
			return route._tag === "Service" ? DetailUpdate.routeChanged(model, route, CONTEXT) : { model }
		},
	})

const init = (flags: Flags): Return => {
	const started = DetailUpdate.init(
		{ serviceName: PROFILES_SERVICE, search: { timePreset: "1h", tab: "profiles" } },
		CONTEXT,
	)
	const clocked = DetailUpdate.update(
		started.model,
		PageMessage.CompletedResolveClock({ nowMs: PROFILES_NOW, mode: "Load" }),
		CONTEXT,
	)
	return step(
		{ ...clocked, commands: [...(started.commands ?? []), ...(clocked.commands ?? [])] },
		flags.state,
	)
}

/** A tab switch is followed in place; a retry reads the fixture, so `?state=failed` then loads. */
const update = (model: Model, message: Message): Return =>
	Message.match<Return>(message, {
		GotPageMessage: ({ message: inner }) => {
			const state = inner._tag === "ClickedRetry" ? "loaded" : model.state
			const next = DetailUpdate.update(model.page, inner, CONTEXT)
			const out = next.outMessage
			if (out === undefined || out._tag !== "RequestedNavigation") return step(next, state)
			const followed = follow(next.model, out.url)
			return step(
				{ ...followed, commands: [...(next.commands ?? []), ...(followed.commands ?? [])] },
				state,
			)
		},
	})

const view = (model: Model, h: HtmlBuilder<Message>) =>
	h.submodel({
		slotId: "service-profiles-lab",
		model: model.page,
		view: pageView,
		viewInputs: { context: CONTEXT },
		toParentMessage: (message: PageMessage) => Message.GotPageMessage({ message }),
	})

const decodeState = Schema.decodeUnknownOption(LabState)

export const lab = defineShellLab("Service profiles", {
	Model,
	Message,
	Flags,
	flags: Effect.sync(() => ({
		state: Option.getOrElse(
			decodeState(new URLSearchParams(window.location.search).get("state")),
			(): LabState => "loaded",
		),
	})),
	init,
	update,
	view,
	currentPath: "/lab/service-profiles",
	breadcrumbs: [{ label: "Services" }, { label: PROFILES_SERVICE }],
})
