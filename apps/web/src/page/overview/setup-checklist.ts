import { Schema } from "effect"
import { AsyncData } from "foldkit"
import { defineMessageUnion } from "foldkit/message"
import { LoadFailure } from "../../data/load-failure"
import { TimeWindow } from "../../data/time-range"
import * as CopyButton from "../../ui/copy-button"
import * as Tabs from "../../ui/tabs"
import { QuickStartState } from "../onboarding/quick-start-state"

// The setup checklist: Clerk mode's
// "Connect your app" card over `useQuickStart` and `useIngestConnection`.

/** `readIngestKeys`: both keys from one admin-only read. */
export const Keys = Schema.Union([
	// Not "Loading": the keys are read only while the card shows, so this can hold for the whole visit.
	Schema.TaggedStruct("Pending", {}),
	Schema.TaggedStruct("Ready", { publicKey: Schema.String, privateKey: Schema.String }),
	Schema.TaggedStruct("Failed", {}),
])
export type Keys = typeof Keys.Type

export const ServiceRow = Schema.Struct({ serviceName: Schema.String, spanCount: Schema.Number })
export type ServiceRow = typeof ServiceRow.Type

/** The last hour's services: unknown until the first read settles, so no card flashes first. */
export const ServicesData = AsyncData.Schema(Schema.Array(ServiceRow), LoadFailure)

export const CopyField = Schema.Literals(["endpoint", "privateKey"])
export type CopyField = typeof CopyField.Type

export const Model = Schema.Struct({
	/** `maple-onboarding-v6-<org>`, the quick-start atom's storage key. */
	storageKey: Schema.String,
	/** `null` until the stored state was read; nothing renders before. */
	state: Schema.NullOr(QuickStartState),
	keys: Keys,
	/** The last hour's overview; data already found is kept when a later poll fails. */
	services: ServicesData.schema,
	/** `useEffectiveTimeRange(.., "1h")`: snapped on entry, unsnapped after a Reload. */
	window: Schema.NullOr(TimeWindow),
	/** An overview read is out: a poll waits for it, so a slow answer still matches `window`. */
	isOverviewInFlight: Schema.Boolean,
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
	FailedLoadOverview: { window: TimeWindow, failure: LoadFailure },
	/** `useIntervalRefresh(refresh, { intervalMs: 15000 })` while the card is mounted. */
	TickedPoll: {},
	/** A poll read the clock: the last hour up to now. */
	ResolvedPollWindow: { window: TimeWindow },
	ClickedToggleExpanded: {},
	ClickedDismiss: {},
	ClickedDismissCelebration: {},
	ClickedExploreTraces: {},
	ClickedFramework: { framework: Schema.String },
	CompletedSaveState: {},
	ClickedRevealPrivateKey: {},
	GotCopyMessage: { field: CopyField, message: CopyButton.Message },
	GotSetupTabsMessage: { message: Tabs.Message },
	GotPackageTabsMessage: { message: Tabs.Message },
	GotSnippetCopyMessage: { snippet: Schema.String, message: CopyButton.Message },
})
export type Message = typeof Message.Type
