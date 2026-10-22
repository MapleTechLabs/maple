import type { FrameworkId } from "../../components/quick-start/sdk-snippets"
import type { OnboardingRole } from "../../lib/onboarding-role"
import { AsyncData, Command } from "foldkit"
import type { TimeWindow } from "../../data/time-range"
import { AppRoute, hrefOf } from "../../route"
import * as CopyButton from "../../ui/copy-button"
import * as Tabs from "../../ui/tabs"
import { PageOutMessage, type PageReturn } from "../contract"
import { PACKAGE_TAB_VALUES, SETUP_TAB_VALUES } from "../kit/guided-setup"
import type { QuickStartState } from "../onboarding/quick-start-state"
import {
	FetchSetupKeys,
	FetchSetupOverview,
	ReadSetupState,
	ResolveSetupPollWindow,
	SaveSetupState,
	SendSetupTestEvent,
} from "./setup-checklist-command"
import { type CopyField, Message, type Model, type ServiceRow, ServicesData } from "./setup-checklist"

type Return = PageReturn<Model, Message>

/** What the card reads from the page context. */
export type SetupContext = Readonly<{ pinnedNamespace: string | null; timeZone: string }>

const ROLE_DEFAULT_FRAMEWORK = {
	backend: "nodejs",
	frontend: "nextjs",
	devops_sre: "otel",
	eng_leader: "nodejs",
	founder: "nextjs",
	other: "nodejs",
} as const satisfies { readonly [Role in OnboardingRole]: FrameworkId }

export const init = (storageKey: string): Return => ({
	model: {
		storageKey,
		state: null,
		keys: { _tag: "Pending" },
		services: ServicesData.Idle(),
		window: null,
		isOverviewInFlight: false,
		isSendingTest: false,
		copies: { endpoint: CopyButton.init(), privateKey: CopyButton.init() },
		isPrivateKeyVisible: false,
		setupTabs: Tabs.init({ idBase: 40, values: SETUP_TAB_VALUES, selected: "install" }),
		packageTabs: Tabs.init({ idBase: 50, values: PACKAGE_TAB_VALUES, selected: "npm" }),
		snippetCopies: {},
	},
	commands: [ReadSetupState({ storageKey })],
})

/** Back after the page was parked: the answers it waited on were dropped, so nothing is in flight. */
export const revived = (model: Model): Return => ({
	model: {
		...model,
		isOverviewInFlight: false,
		isSendingTest: false,
		copies: { endpoint: CopyButton.init(), privateKey: CopyButton.init() },
		snippetCopies: {},
	},
	// A key read still out when the page was parked was dropped: ask again.
	commands: isMounted(model) && model.keys._tag === "Pending" ? [FetchSetupKeys()] : [],
})

/** `SetupChecklist` renders (and polls) once the state is read and the checklist is not dismissed. */
export const isMounted = (model: Model): boolean => model.state !== null && !model.state.checklistDismissed

/** `useGuidedFramework`: the picked framework, else the role's default. */
export const frameworkOf = (state: QuickStartState): string =>
	state.selectedFramework ?? (state.qualifyAnswers.role === null ? "nodejs" : ROLE_DEFAULT_FRAMEWORK[state.qualifyAnswers.role])

/** `useIngestConnection`: the org's own services; the seeded `demo-` ones do not count. */
export const realServices = (model: Model): ReadonlyArray<ServiceRow> =>
	AsyncData.getOrElse(model.services, (): ReadonlyArray<ServiceRow> => []).filter(
		(row) => !row.serviceName.startsWith("demo-"),
	)

const fetchOverview = (model: Model, pinnedNamespace: string | null): Return =>
	model.window === null
		? { model }
		: {
				model: {
					...model,
					isOverviewInFlight: true,
					// A failure stays on screen while the poll retries; only a cold card shows loading.
					services: AsyncData.isIdle(model.services) ? ServicesData.Loading() : model.services,
				},
				commands: [FetchSetupOverview({ window: model.window, pinnedNamespace })],
			}

/** The page resolved its clock: snapped on entry, unsnapped after a Reload (`refreshVersion`). */
export const windowResolved = (model: Model, window: TimeWindow, pinnedNamespace: string | null): Return => {
	const next = { ...model, window }
	return isMounted(next) ? fetchOverview(next, pinnedNamespace) : { model: next }
}

const saveState = (model: Model, state: QuickStartState): Return => ({
	model: { ...model, state },
	commands: [SaveSetupState({ storageKey: model.storageKey, state })],
})

const toast = (type: "success" | "error", title: string) =>
	PageOutMessage.RequestedToast({ type, title, description: "" })

const dismissed = (model: Model): Return =>
	model.state === null ? { model } : saveState(model, { ...model.state, checklistDismissed: true })

/** `FirstTraceCelebration`'s explore: dismiss, then the traces of the first real service. */
const explore = (model: Model): Return => {
	const first = realServices(model)[0]
	const url = hrefOf(AppRoute.Traces({ search: first === undefined ? {} : { services: [first.serviceName] } }))
	return { ...dismissed(model), outMessage: PageOutMessage.RequestedNavigation({ url, isReplace: false }) }
}

const copyStep = (model: Model, field: CopyField, message: CopyButton.Message): Return => {
	const next = CopyButton.update(model.copies[field], message)
	return {
		model: { ...model, copies: { ...model.copies, [field]: next.model } },
		commands: Command.mapMessages(next.commands ?? [], (inner) => Message.GotCopyMessage({ field, message: inner })),
	}
}

const snippetCopyStep = (model: Model, snippet: string, message: CopyButton.Message): Return => {
	const next = CopyButton.update(model.snippetCopies[snippet] ?? CopyButton.init(), message)
	return {
		model: { ...model, snippetCopies: { ...model.snippetCopies, [snippet]: next.model } },
		commands: Command.mapMessages(next.commands ?? [], (inner) =>
			Message.GotSnippetCopyMessage({ snippet, message: inner }),
		),
	}
}

const tabsStep = (
	model: Model,
	slot: "setupTabs" | "packageTabs",
	message: Tabs.Message,
	wrap: (message: Tabs.Message) => Message,
): Return => {
	const next = Tabs.update(model[slot], message)
	return { model: { ...model, [slot]: next.model }, commands: Command.mapMessages(next.commands, wrap) }
}

const isWindow = (model: Model, window: TimeWindow) =>
	model.window !== null && model.window.startTime === window.startTime && model.window.endTime === window.endTime

export const update = (model: Model, message: Message, context: SetupContext): Return => {
	const { pinnedNamespace } = context
	const resolvePoll = isMounted(model) ? [ResolveSetupPollWindow({ timeZone: context.timeZone })] : []
	return Message.match<Return>(message, {
		ReadState: ({ state }) => {
			const next = { ...model, state }
			if (!isMounted(next)) return { model: next }
			// The card mounts: `useIngestConnection` reads the keys and the overview.
			const overview = fetchOverview(next, pinnedNamespace)
			return { model: overview.model, commands: [FetchSetupKeys(), ...(overview.commands ?? [])] }
		},
		SucceededLoadKeys: ({ publicKey, privateKey }) => ({
			model: { ...model, keys: { _tag: "Ready", publicKey, privateKey } },
		}),
		FailedLoadKeys: () => ({ model: { ...model, keys: { _tag: "Failed" } } }),
		SucceededLoadOverview: ({ window, services }) =>
			isWindow(model, window)
				? {
						model: {
							...model,
							services: ServicesData.Success({ data: services }),
							isOverviewInFlight: false,
						},
					}
				: { model },
		// One failed poll keeps the services already found, so the card does not un-detect them.
		FailedLoadOverview: ({ window, failure }) =>
			isWindow(model, window)
				? {
						model: {
							...model,
							isOverviewInFlight: false,
							services: AsyncData.hasData(model.services)
								? model.services
								: ServicesData.Failure({ error: failure }),
						},
					}
				: { model },
		// A tick during a slow read waits for it: a new window would drop its answer.
		TickedPoll: () => (model.isOverviewInFlight ? { model } : { model, commands: resolvePoll }),
		ResolvedPollWindow: ({ window }) => windowResolved(model, window, pinnedNamespace),
		ClickedToggleExpanded: () =>
			model.state === null
				? { model }
				: saveState(model, { ...model.state, checklistExpanded: !model.state.checklistExpanded }),
		ClickedDismiss: () => ({
			...dismissed(model),
			outMessage: toast("success", "Setup checklist hidden. You can reset it from settings later"),
		}),
		ClickedDismissCelebration: () => dismissed(model),
		ClickedExploreTraces: () => explore(model),
		ClickedFramework: ({ framework }) =>
			model.state === null
				? { model }
				: saveState({ ...model, snippetCopies: {} }, { ...model.state, selectedFramework: framework }),
		ClickedSendTestEvent: () =>
			model.keys._tag !== "Ready" || model.keys.publicKey === "" || model.isSendingTest
				? { model }
				: {
						model: { ...model, isSendingTest: true },
						commands: [SendSetupTestEvent({ publicKey: model.keys.publicKey })],
					},
		CompletedSendTestEvent: ({ isSent }) =>
			isSent
				? {
						model: { ...model, isSendingTest: false },
						commands: resolvePoll,
						outMessage: toast("success", "Test event sent. Watch for it to land below."),
					}
				: {
						model: { ...model, isSendingTest: false },
						outMessage: toast("error", "Couldn't reach the ingest endpoint. Double-check your API key."),
					},
		CompletedSaveState: () => ({ model }),
		ClickedRevealPrivateKey: () => ({ model: { ...model, isPrivateKeyVisible: !model.isPrivateKeyVisible } }),
		GotCopyMessage: ({ field, message: inner }) => copyStep(model, field, inner),
		GotSetupTabsMessage: ({ message: inner }) =>
			tabsStep(model, "setupTabs", inner, (child) => Message.GotSetupTabsMessage({ message: child })),
		GotPackageTabsMessage: ({ message: inner }) =>
			tabsStep(model, "packageTabs", inner, (child) => Message.GotPackageTabsMessage({ message: child })),
		GotSnippetCopyMessage: ({ snippet, message: inner }) => snippetCopyStep(model, snippet, inner),
	})
}
