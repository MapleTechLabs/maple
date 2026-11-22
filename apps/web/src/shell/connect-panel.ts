import { retrieveSetupKeys } from "../data/ingest-keys"
import { isOwnService } from "../page/kit/own-services"
import { getServiceOverview } from "@maple/web-data/warehouse/services"
import { Effect, Schema, Array as Arr } from "effect"
import { Command, type Update } from "foldkit"
import { defineMessageUnion } from "foldkit/message"
import { currentWindow, TimeWindow } from "../data/time-range"
import type { Resources } from "../platform/resources"
import { readEffectiveTimeZone } from "../platform/time-zone"
import * as CopyButton from "@maple/views/ui/copy-button"
import * as Popover from "@maple/views/ui/popover"
import * as AgentHandoff from "../page/kit/agent-handoff"

// The Connect button: the top bar's popover with
// the ingest endpoint and keys, the live connection pill and the MCP card.

export const POPOVER_ID = "shell-connect"

export const CopyField = Schema.Literals(["endpoint", "publicKey", "privateKey", "mcp", "mcpCommand"])
export type CopyField = typeof CopyField.Type

/** The setup keys: both for an engineer and up, the public key alone (`privateKey` null) for a member. */
export const Keys = Schema.Union([
	Schema.TaggedStruct("Loading", {}),
	Schema.TaggedStruct("Ready", { publicKey: Schema.String, privateKey: Schema.NullOr(Schema.String) }),
	Schema.TaggedStruct("Failed", {}),
])
export type Keys = typeof Keys.Type

export const ServiceRow = Schema.Struct({ serviceName: Schema.String, spanCount: Schema.Number })

export const Model = Schema.Struct({
	popover: Popover.Model,
	/** The org the keys and overview were read for; another org's late answer is dropped. */
	orgId: Schema.NullOr(Schema.String),
	keys: Keys,
	/** The last-hour overview; empty until it lands, kept when a poll fails. */
	services: Schema.Array(ServiceRow),
	/** `useEffectiveTimeRange(.., "1h")`: resolved on open and again on each 15 s poll. */
	window: Schema.NullOr(TimeWindow),
	/** An overview read is out: a poll waits for it, so a slow answer still lands. */
	isOverviewInFlight: Schema.Boolean,
	/** The last overview read failed: the pill says the status is unknown until one succeeds. */
	isOverviewFailed: Schema.Boolean,
	/** The overview read sent last, across openings; only its answer counts. */
	overviewRequest: Schema.Number,
	/** The key read sent last, across openings; an earlier opening's late answer is dropped. */
	keysRequest: Schema.Number,
	copies: Schema.Struct({
		endpoint: CopyButton.Model,
		publicKey: CopyButton.Model,
		privateKey: CopyButton.Model,
		mcp: CopyButton.Model,
		mcpCommand: CopyButton.Model,
	}),
	/** `CopyableField masked`: each key's reveal toggle, reset when the panel unmounts. */
	isPublicKeyVisible: Schema.Boolean,
	isPrivateKeyVisible: Schema.Boolean,
	/** The coding-agent prompt: Copy mints its handoff code. */
	agent: AgentHandoff.Model,
})
export type Model = typeof Model.Type

const initCopies = (): Model["copies"] => ({
	endpoint: CopyButton.init(),
	publicKey: CopyButton.init(),
	privateKey: CopyButton.init(),
	mcp: CopyButton.init(),
	mcpCommand: CopyButton.init(),
})

export const init = (): Model => ({
	popover: Popover.init(POPOVER_ID, { align: "end" }),
	orgId: null,
	keys: { _tag: "Loading" },
	services: [],
	window: null,
	isOverviewInFlight: false,
	isOverviewFailed: false,
	overviewRequest: 0,
	keysRequest: 0,
	copies: initCopies(),
	isPublicKeyVisible: false,
	isPrivateKeyVisible: false,
	agent: AgentHandoff.init("connect_panel"),
})

export const Message = defineMessageUnion({
	GotPopoverMessage: { message: Popover.Message },
	SucceededLoadKeys: {
		orgId: Schema.String,
		request: Schema.Number,
		publicKey: Schema.String,
		privateKey: Schema.NullOr(Schema.String),
	},
	FailedLoadKeys: { orgId: Schema.String, request: Schema.Number },
	ResolvedWindow: { orgId: Schema.String, window: TimeWindow },
	SucceededLoadOverview: {
		orgId: Schema.String,
		request: Schema.Number,
		services: Schema.Array(ServiceRow),
	},
	FailedLoadOverview: { orgId: Schema.String, request: Schema.Number },
	/** `useIntervalRefresh(refresh, { intervalMs: 15000 })` while the panel is open and the tab shown. */
	TickedPoll: {},
	GotCopyMessage: { field: CopyField, message: CopyButton.Message },
	ClickedRevealPublicKey: {},
	ClickedRevealPrivateKey: {},
	GotAgentMessage: { message: AgentHandoff.Message },
})
export type Message = typeof Message.Type

export const FetchKeys = Command.define("FetchConnectIngestKeys", {
	args: { orgId: Schema.String, request: Schema.Number },
	messages: [Message.SucceededLoadKeys, Message.FailedLoadKeys],
	execute: ({ orgId, request }) =>
		retrieveSetupKeys.pipe(
			Effect.map((keys) =>
				Message.SucceededLoadKeys({
					orgId,
					request,
					publicKey: keys.publicKey,
					privateKey: keys.privateKey,
				}),
			),
			Effect.orElseSucceed(() => Message.FailedLoadKeys({ orgId, request })),
		),
})

/** The effective zone's last hour, snapped as a mounted `useEffectiveTimeRange` resolves it. */
export const ResolveWindow = Command.define("ResolveConnectWindow", {
	args: { orgId: Schema.String },
	messages: [Message.ResolvedWindow],
	execute: ({ orgId }) =>
		Effect.flatMap(readEffectiveTimeZone, (timeZone) =>
			currentWindow({ preset: "1h", snap: true, timeZone }),
		).pipe(Effect.map((window) => Message.ResolvedWindow({ orgId, window }))),
})

/** `getServiceOverviewResultAtom({ data: { startTime, endTime } })`, the pin applied ("top"). */
export const FetchOverview = Command.define("FetchConnectOverview", {
	args: {
		orgId: Schema.String,
		window: TimeWindow,
		request: Schema.Number,
		pinnedNamespace: Schema.NullOr(Schema.String),
	},
	messages: [Message.SucceededLoadOverview, Message.FailedLoadOverview],
	execute: ({ orgId, window, request, pinnedNamespace }) =>
		getServiceOverview({
			data: pinnedNamespace === null ? window : { ...window, namespaces: [pinnedNamespace] },
		}).pipe(
			Effect.map((response) =>
				Message.SucceededLoadOverview({
					orgId,
					request,
					services: Arr.map(response.data, (row) => ({
						serviceName: String(row.serviceName),
						spanCount: row.spanCount ?? 0,
					})),
				}),
			),
			Effect.orElseSucceed(() => Message.FailedLoadOverview({ orgId, request })),
		),
})

/** The signed-in org and its namespace pin, which the overview read applies. */
export type Context = Readonly<{ orgId: string | null; pinnedNamespace: string | null }>

type UpdateReturn = Update.Return<Model, Message, Resources>

const toPopover = (message: Popover.Message) => Message.GotPopoverMessage({ message })

const toAgent = (commands: ReadonlyArray<Command.Command<AgentHandoff.Message, never, Resources>>) =>
	Command.mapMessages(commands, (message) => Message.GotAgentMessage({ message }))

/** `{open && <ConnectPanel />}`: opening mounts the panel's reads; closing unmounts its state. */
const popoverStep = (model: Model, message: Popover.Message, context: Context): UpdateReturn => {
	const next = Popover.update(model.popover, message)
	const commands = Command.mapMessages(next.commands ?? [], toPopover)
	const isOpening = !model.popover.isOpen && next.model.isOpen
	const isClosing = model.popover.isOpen && !next.model.isOpen
	if (isClosing) {
		return {
			model: {
				...init(),
				popover: next.model,
				orgId: model.orgId,
				keys: model.keys,
				overviewRequest: model.overviewRequest,
				keysRequest: model.keysRequest,
			},
			commands,
		}
	}
	if (!isOpening || context.orgId === null) return { model: { ...model, popover: next.model }, commands }
	const orgId = context.orgId
	const shown = AgentHandoff.shown(model.agent)
	// Every open reads the keys again: a key rolled in Settings since the last open must never be copied.
	const keys: Keys = { _tag: "Loading" }
	const keysRequest = model.keysRequest + 1
	return {
		model: {
			...model,
			popover: next.model,
			orgId,
			keys,
			keysRequest,
			services: [],
			window: null,
			isOverviewInFlight: false,
			isOverviewFailed: false,
			agent: shown.model,
		},
		commands: [
			...commands,
			...toAgent(shown.commands),
			FetchKeys({ orgId, request: keysRequest }),
			ResolveWindow({ orgId }),
		],
	}
}

const isCurrentKeys = (model: Model, orgId: string, request: number) =>
	model.orgId === orgId && model.keysRequest === request

const isCurrent = (model: Model, orgId: string, request: number) =>
	model.orgId === orgId && model.overviewRequest === request

const copyStep = (model: Model, field: CopyField, message: CopyButton.Message): UpdateReturn => {
	const next = CopyButton.update(model.copies[field], message)
	return {
		model: { ...model, copies: { ...model.copies, [field]: next.model } },
		commands: Command.mapMessages(next.commands ?? [], (child) =>
			Message.GotCopyMessage({ field, message: child }),
		),
	}
}

export const update = (model: Model, message: Message, context: Context): UpdateReturn =>
	Message.match<UpdateReturn>(message, {
		GotPopoverMessage: ({ message: child }) => popoverStep(model, child, context),
		SucceededLoadKeys: ({ orgId, request, publicKey, privateKey }) =>
			isCurrentKeys(model, orgId, request)
				? { model: { ...model, keys: { _tag: "Ready", publicKey, privateKey } } }
				: { model },
		FailedLoadKeys: ({ orgId, request }) =>
			isCurrentKeys(model, orgId, request)
				? { model: { ...model, keys: { _tag: "Failed" } } }
				: { model },
		// The open read and every poll: the overview follows the clock, not the window at open.
		ResolvedWindow: ({ orgId, window }) =>
			model.orgId === orgId && model.popover.isOpen
				? {
						model: {
							...model,
							window,
							isOverviewInFlight: true,
							overviewRequest: model.overviewRequest + 1,
						},
						commands: [
							FetchOverview({
								orgId,
								window,
								request: model.overviewRequest + 1,
								pinnedNamespace: context.pinnedNamespace,
							}),
						],
					}
				: { model },
		SucceededLoadOverview: ({ orgId, request, services }) =>
			isCurrent(model, orgId, request)
				? { model: { ...model, services, isOverviewInFlight: false, isOverviewFailed: false } }
				: { model },
		// One failed poll keeps the services already found, so the pill does not un-detect them.
		FailedLoadOverview: ({ orgId, request }) =>
			isCurrent(model, orgId, request)
				? { model: { ...model, isOverviewInFlight: false, isOverviewFailed: true } }
				: { model },
		TickedPoll: () =>
			model.popover.isOpen && model.window !== null && model.orgId !== null && !model.isOverviewInFlight
				? { model, commands: [ResolveWindow({ orgId: model.orgId })] }
				: { model },
		GotCopyMessage: ({ field, message: child }) => copyStep(model, field, child),
		ClickedRevealPublicKey: () => ({
			model: { ...model, isPublicKeyVisible: !model.isPublicKeyVisible },
		}),
		ClickedRevealPrivateKey: () => ({
			model: { ...model, isPrivateKeyVisible: !model.isPrivateKeyVisible },
		}),
		GotAgentMessage: ({ message: child }) => {
			const next = AgentHandoff.update(model.agent, child)
			return { model: { ...model, agent: next.model }, commands: toAgent(next.commands) }
		},
	})

/** Navigation closes the panel: its links lead elsewhere, and an open panel would hide the page. */
export const close = (model: Model): UpdateReturn =>
	model.popover.isOpen
		? popoverStep(model, Popover.Message.ClickedClose(), { orgId: model.orgId, pinnedNamespace: null })
		: { model }

/** The 15 s poll runs while the panel is open on a resolved window. */
export const isPolling = (model: Model): boolean => model.popover.isOpen && model.window !== null

/** The org's own services: seeded `demo-` ones and onboarding's test trace do not count as a connection. */
export const realServices = (model: Model): ReadonlyArray<typeof ServiceRow.Type> =>
	Arr.filter(model.services, (row) => isOwnService(row.serviceName))
