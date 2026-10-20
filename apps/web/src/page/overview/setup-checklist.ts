import { Schema } from "effect"
import { defineMessageUnion } from "foldkit/message"
import { TimeWindow } from "../../data/time-range"
import * as CopyButton from "../../ui/copy-button"
import * as Tabs from "../../ui/tabs"
import { QuickStartState } from "../onboarding/quick-start-state"

// The setup checklist: Clerk mode's
// "Connect your app" card over `useQuickStart` and `useIngestConnection`.

/** `readIngestKeys`: both keys from one admin-only read. */
export const Keys = Schema.Union([
	Schema.TaggedStruct("Loading", {}),
	Schema.TaggedStruct("Ready", { publicKey: Schema.String, privateKey: Schema.String }),
	Schema.TaggedStruct("Failed", {}),
])
export type Keys = typeof Keys.Type

export const ServiceRow = Schema.Struct({ serviceName: Schema.String, spanCount: Schema.Number })
export type ServiceRow = typeof ServiceRow.Type

export const CopyField = Schema.Literals(["endpoint", "privateKey"])
export type CopyField = typeof CopyField.Type

export const Model = Schema.Struct({
	/** `maple-onboarding-v6-<org>`, the quick-start atom's storage key. */
	storageKey: Schema.String,
	/** `null` until the stored state was read; nothing renders before. */
	state: Schema.NullOr(QuickStartState),
	keys: Keys,
	/** The last hour's overview; empty until it lands, kept when a later poll fails. */
	services: Schema.Array(ServiceRow),
	/** `useEffectiveTimeRange(.., "1h")`: snapped on entry, unsnapped after a Reload. */
	window: Schema.NullOr(TimeWindow),
	isSendingTest: Schema.Boolean,
	copies: Schema.Struct({ endpoint: CopyButton.Model, privateKey: CopyButton.Model }),
	isPrivateKeyVisible: Schema.Boolean,
	setupTabs: Tabs.Model,
	packageTabs: Tabs.Model,
	snippetCopies: Schema.Record(Schema.String, CopyButton.Model),
})
export type Model = typeof Model.Type

export const Message = defineMessageUnion({
	ReadState: { state: QuickStartState },
	SucceededLoadKeys: { publicKey: Schema.String, privateKey: Schema.String },
	FailedLoadKeys: {},
	SucceededLoadOverview: { window: TimeWindow, services: Schema.Array(ServiceRow) },
	FailedLoadOverview: { window: TimeWindow },
	/** `useIntervalRefresh(refresh, { intervalMs: 15000 })` while the card is mounted. */
	TickedPoll: {},
	/** A poll or a sent test event read the clock: the last hour up to now. */
	ResolvedPollWindow: { window: TimeWindow },
	ClickedToggleExpanded: {},
	ClickedDismiss: {},
	ClickedDismissCelebration: {},
	ClickedExploreTraces: {},
	ClickedFramework: { framework: Schema.String },
	ClickedSendTestEvent: {},
	CompletedSendTestEvent: { isSent: Schema.Boolean },
	CompletedSaveState: {},
	ClickedRevealPrivateKey: {},
	GotCopyMessage: { field: CopyField, message: CopyButton.Message },
	GotSetupTabsMessage: { message: Tabs.Message },
	GotPackageTabsMessage: { message: Tabs.Message },
	GotSnippetCopyMessage: { snippet: Schema.String, message: CopyButton.Message },
})
export type Message = typeof Message.Type
