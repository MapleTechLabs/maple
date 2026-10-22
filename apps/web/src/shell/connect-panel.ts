import { getServiceOverview } from "@maple/web-data/warehouse/services"
import { Effect, Schema } from "effect"
import { Command, type Update } from "foldkit"
import { defineMessageUnion } from "foldkit/message"
import { currentWindow, TimeWindow } from "../data/time-range"
import { MapleApiV2Client } from "../platform/api-clients"
import type { Resources } from "../platform/resources"
import { readEffectiveTimeZone } from "../platform/time-zone"
import * as CopyButton from "../ui/copy-button"
import * as Popover from "../ui/popover"

// The Connect button: the top bar's popover with
// the ingest endpoint and keys, the live connection pill and the MCP card.

export const POPOVER_ID = "shell-connect"

export const CopyField = Schema.Literals(["endpoint", "publicKey", "privateKey", "skill", "mcp"])
export type CopyField = typeof CopyField.Type

/** `retainedQueryV2("ingestKeys", "retrieve")`: both keys from one admin-only read. */
export const Keys = Schema.Union([
	Schema.TaggedStruct("Loading", {}),
	Schema.TaggedStruct("Ready", { publicKey: Schema.String, privateKey: Schema.String }),
	Schema.TaggedStruct("Failed", {}),
])
export type Keys = typeof Keys.Type

export const ServiceRow = Schema.Struct({ serviceName: Schema.String, spanCount: Schema.Number })

export const Model = Schema.Struct({
	popover: Popover.Model,
	/** The org the keys and overview were read for; another org's late answer is dropped. */
	orgId: Schema.NullOr(Schema.String),
	keys: Keys,
	/** `useIngestConnection`'s last-hour overview; empty until it lands, kept when a poll fails. */
	services: Schema.Array(ServiceRow),
	/** `useEffectiveTimeRange(.., "1h")`: resolved on open and again on each 15 s poll. */
	window: Schema.NullOr(TimeWindow),
	/** An overview read is out: a poll waits for it, so a slow answer still lands. */
	isOverviewInFlight: Schema.Boolean,
	/** The overview read sent last, across openings; only its answer counts. */
	overviewRequest: Schema.Number,
	copies: Schema.Struct({
		endpoint: CopyButton.Model,
		publicKey: CopyButton.Model,
		privateKey: CopyButton.Model,
		skill: CopyButton.Model,
		mcp: CopyButton.Model,
	}),
	/** `CopyableField masked`: each key's reveal toggle, reset when the panel unmounts. */
	isPublicKeyVisible: Schema.Boolean,
	isPrivateKeyVisible: Schema.Boolean,
})
export type Model = typeof Model.Type

const initCopies = (): Model["copies"] => ({
	endpoint: CopyButton.init(),
	publicKey: CopyButton.init(),
	privateKey: CopyButton.init(),
	skill: CopyButton.init(),
	mcp: CopyButton.init(),
})

export const init = (): Model => ({
	popover: Popover.init(POPOVER_ID, { align: "end" }),
	orgId: null,
	keys: { _tag: "Loading" },
	services: [],
	window: null,
	isOverviewInFlight: false,
	overviewRequest: 0,
	copies: initCopies(),
	isPublicKeyVisible: false,
	isPrivateKeyVisible: false,
})

export const Message = defineMessageUnion({
	GotPopoverMessage: { message: Popover.Message },
	SucceededLoadKeys: { orgId: Schema.String, publicKey: Schema.String, privateKey: Schema.String },
	FailedLoadKeys: { orgId: Schema.String },
	ResolvedWindow: { orgId: Schema.String, window: TimeWindow },
	SucceededLoadOverview: { orgId: Schema.String, request: Schema.Number, services: Schema.Array(ServiceRow) },
	FailedLoadOverview: { orgId: Schema.String, request: Schema.Number },
	/** `useIntervalRefresh(refresh, { intervalMs: 15000 })` while the panel is open and the tab shown. */
	TickedPoll: {},
	GotCopyMessage: { field: CopyField, message: CopyButton.Message },
	ClickedRevealPublicKey: {},
	ClickedRevealPrivateKey: {},
})
export type Message = typeof Message.Type

export const FetchKeys = Command.define("FetchConnectIngestKeys", {
	args: { orgId: Schema.String },
	messages: [Message.SucceededLoadKeys, Message.FailedLoadKeys],
	execute: ({ orgId }) =>
		Effect.flatMap(MapleApiV2Client, (client) => client.ingestKeys.retrieve()).pipe(
			Effect.map((keys) =>
				Message.SucceededLoadKeys({
					orgId,
					publicKey: keys.public_key,
					privateKey: keys.private_key,
				}),
			),
			Effect.orElseSucceed(() => Message.FailedLoadKeys({ orgId })),
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
					services: response.data.map((row) => ({
						serviceName: String(row.serviceName),
						spanCount: row.spanCount ?? 0,
					})),
				}),
			),
			Effect.orElseSucceed(() => Message.FailedLoadOverview({ orgId, request })),
		),
})

// UPDATE

/** The signed-in org and its namespace pin, which the overview read applies. */
export type Context = Readonly<{ orgId: string | null; pinnedNamespace: string | null }>

type UpdateReturn = Update.Return<Model, Message, Resources>

const toPopover = (message: Popover.Message) => Message.GotPopoverMessage({ message })

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
			},
			commands,
		}
	}
	if (!isOpening || context.orgId === null) return { model: { ...model, popover: next.model }, commands }
	const orgId = context.orgId
	const isSameOrg = model.orgId === orgId
	// The retained keys answer a reopen in the same org; a failure or another org reads again.
	const keys: Keys = isSameOrg ? model.keys : { _tag: "Loading" }
	return {
		model: { ...model, popover: next.model, orgId, keys, services: [], window: null, isOverviewInFlight: false },
		commands: [
			...commands,
			...(keys._tag === "Ready" ? [] : [FetchKeys({ orgId })]),
			ResolveWindow({ orgId }),
		],
	}
}

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
		SucceededLoadKeys: ({ orgId, publicKey, privateKey }) =>
			model.orgId === orgId
				? { model: { ...model, keys: { _tag: "Ready", publicKey, privateKey } } }
				: { model },
		FailedLoadKeys: ({ orgId }) =>
			model.orgId === orgId ? { model: { ...model, keys: { _tag: "Failed" } } } : { model },
		// The open read and every poll: the overview follows the clock, not the window at open.
		ResolvedWindow: ({ orgId, window }) =>
			model.orgId === orgId && model.popover.isOpen
				? {
						model: { ...model, window, isOverviewInFlight: true, overviewRequest: model.overviewRequest + 1 },
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
				? { model: { ...model, services, isOverviewInFlight: false } }
				: { model },
		// One failed poll keeps the services already found, so the pill does not un-detect them.
		FailedLoadOverview: ({ orgId, request }) =>
			isCurrent(model, orgId, request) ? { model: { ...model, isOverviewInFlight: false } } : { model },
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
	})

/** The 15 s poll runs while the panel is open on a resolved window. */
export const isPolling = (model: Model): boolean => model.popover.isOpen && model.window !== null

// DERIVED (`useIngestConnection`)

/** The org's own services: the seeded `demo-` ones do not count as a connection. */
export const realServices = (model: Model): ReadonlyArray<typeof ServiceRow.Type> =>
	model.services.filter((row) => !row.serviceName.startsWith("demo-"))

