import { OrgId } from "@maple/domain"
import { Effect, Result, Schema } from "effect"
import { AsyncData, Command, type Update } from "foldkit"
import type { HtmlBuilder } from "foldkit/html"
import { defineMessageUnion } from "foldkit/message"
import type { PageContext, PageReturn } from "../../page/contract"
import { Message as PageMessage } from "../../page/services/detail/message"
import { Model as PageModel } from "../../page/services/detail/model"
import * as DetailUpdate from "../../page/services/detail/update"
import { view as pageView } from "../../page/services/detail/view"
import type { Resources } from "../../platform/resources"
import {
	RUNTIMES_COMMITS,
	RUNTIMES_DEPENDENCIES,
	RUNTIMES_ISSUES,
	RUNTIMES_NOW,
	RUNTIMES_OPERATIONS,
	RUNTIMES_POINTS,
	RUNTIMES_RELEASES,
	RUNTIMES_SERVICE,
	RUNTIMES_USAGE,
	RUNTIMES_WORKLOADS,
	RUNTIMES_RUNTIMES,
} from "../service-runtimes-fixture"
import { defineShellLab } from "../shell-lab"

// `/lab/service-runtimes`: the service page's Overview tab for `fleet-api` (Google Cloud Run, no
// Kubernetes) over one hour, in the real shell. Every read is answered from the fixture.

const CONTEXT: PageContext = {
	orgId: Schema.decodeSync(OrgId)("org_lab_service_runtimes"),
	pinnedNamespace: null,
	timeZone: "UTC",
}

const Flags = Schema.Struct({})
type Flags = typeof Flags.Type

const Model = Schema.Struct({ page: PageModel })
type Model = typeof Model.Type

const Message = defineMessageUnion({ GotPageMessage: { message: PageMessage } })
type Message = typeof Message.Type
type Return = Update.Return<Model, Message, Resources>

const isPending = (data: AsyncData.AsyncData<unknown, unknown>) =>
	AsyncData.isLoading(data) || AsyncData.isRefreshing(data)

/** One read: its slot and the answer its fetch would have sent. */
type Answer = (model: PageModel) => ReadonlyArray<PageMessage>

const slot =
	<S extends { readonly key: string | null; readonly data: AsyncData.AsyncData<unknown, unknown> }>(
		read: (model: PageModel) => S,
		answer: (key: string) => PageMessage,
	): Answer =>
	(model) => {
		const target = read(model)
		return isPending(target.data) ? [answer(target.key ?? "")] : []
	}

/** Every read the Overview tab makes; adding a read is one more entry. */
const ANSWERS: ReadonlyArray<Answer> = [
	slot(
		(model) => model.overview,
		(key) =>
			PageMessage.CompletedFetchOverview({
				key,
				result: Result.succeed({
					points: RUNTIMES_POINTS,
					releases: RUNTIMES_RELEASES,
					environments: ["production", "staging"],
				}),
			}),
	),
	slot(
		(model) => model.operations,
		(key) => PageMessage.CompletedFetchOperations({ key, result: Result.succeed(RUNTIMES_OPERATIONS) }),
	),
	slot(
		(model) => model.issues,
		(key) => PageMessage.CompletedFetchIssues({ key, result: Result.succeed(RUNTIMES_ISSUES) }),
	),
	slot(
		(model) => model.usage,
		(key) => PageMessage.CompletedFetchUsage({ key, result: Result.succeed(RUNTIMES_USAGE) }),
	),
	slot(
		(model) => model.workloads,
		(key) => PageMessage.CompletedFetchWorkloads({ key, result: Result.succeed(RUNTIMES_WORKLOADS) }),
	),
	slot(
		(model) => model.runtimes,
		(key) => PageMessage.CompletedFetchRuntimes({ key, result: Result.succeed(RUNTIMES_RUNTIMES) }),
	),
	slot(
		(model) => model.dependencies,
		(key) =>
			PageMessage.CompletedFetchDependencies({ key, result: Result.succeed(RUNTIMES_DEPENDENCIES) }),
	),
	slot(
		(model) => model.uptimeMonitors,
		(key) => PageMessage.CompletedFetchUptimeMonitors({ key, result: Result.succeed([]), isAdmin: true }),
	),
	(model) =>
		Object.entries(model.commits).flatMap(([sha, data]) => {
			const commit = RUNTIMES_COMMITS.get(sha)
			return AsyncData.isLoading(data) && commit !== undefined
				? [PageMessage.CompletedFetchCommit({ sha, result: Result.succeed(commit) })]
				: []
		}),
]

const answers = (model: PageModel): ReadonlyArray<PageMessage> => ANSWERS.flatMap((answer) => answer(model))

/** Answers pending reads until none is left (an answer can start the next read). */
const settle = (
	result: PageReturn<PageModel, PageMessage>,
	depth = 0,
): PageReturn<PageModel, PageMessage> => {
	const pending = answers(result.model)
	if (pending.length === 0 || depth > 6) return result
	const next = pending.reduce<PageReturn<PageModel, PageMessage>>((acc, message) => {
		const answered = DetailUpdate.update(acc.model, message, CONTEXT)
		return {
			model: answered.model,
			commands: [...(acc.commands ?? []), ...(answered.commands ?? [])],
			outMessage: acc.outMessage ?? answered.outMessage,
		}
	}, result)
	return settle(next, depth + 1)
}

const isRead = (name: string) => /^(Fetch|ResolveServiceDetailClock)/.test(name)

const step = (result: PageReturn<PageModel, PageMessage>): Return => {
	const settled = settle(result)
	return {
		model: { page: settled.model },
		commands: Command.mapMessages(
			(settled.commands ?? []).filter((command) => !isRead(command.name)),
			(message) => Message.GotPageMessage({ message }),
		),
	}
}

const init = (_flags: Flags): Return => {
	const started = DetailUpdate.init(
		{ serviceName: RUNTIMES_SERVICE, search: { timePreset: "1h" } },
		CONTEXT,
	)
	const clocked = DetailUpdate.update(
		started.model,
		PageMessage.CompletedResolveClock({ nowMs: RUNTIMES_NOW, mode: "Load" }),
		CONTEXT,
	)
	return step({ ...clocked, commands: [...(started.commands ?? []), ...(clocked.commands ?? [])] })
}

/** Navigation out of the page (a tab, a row) is dropped: the lab stays on its one view. */
const update = (model: Model, message: Message): Return =>
	Message.match<Return>(message, {
		GotPageMessage: ({ message: inner }) => step(DetailUpdate.update(model.page, inner, CONTEXT)),
	})

const view = (model: Model, h: HtmlBuilder<Message>) =>
	h.submodel({
		slotId: "service-runtimes-lab",
		model: model.page,
		view: pageView,
		viewInputs: { context: CONTEXT },
		toParentMessage: (message: PageMessage) => Message.GotPageMessage({ message }),
	})

export const lab = defineShellLab("Service runtimes", {
	Model,
	Message,
	Flags,
	flags: Effect.succeed({}),
	init,
	update,
	view,
	currentPath: "/lab/service-runtimes",
	breadcrumbs: [{ label: "Services" }, { label: RUNTIMES_SERVICE }],
})
