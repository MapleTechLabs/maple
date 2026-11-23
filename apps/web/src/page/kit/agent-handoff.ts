import { V2OnboardingAgentHandoff, V2OnboardingAgentRun } from "@maple/domain/http/v2"
import { OnboardingHandoffArm, onboardingHandoffArm } from "@maple/domain/onboarding-agent-run"
import { Effect, Option, Predicate, Schema } from "effect"
import { Command } from "foldkit"
import { defineMessageUnion } from "foldkit/message"
import * as CopyButton from "@maple/views/ui/copy-button"
import { openPendingClipboardWrite } from "@maple/ui/lib/clipboard"
import { trackProduct } from "../../data/analytics"
import { MapleApiV2Client } from "../../platform/api-clients"
import { ingestUrl } from "../../platform/ingest-url"
import { apiPublicUrl } from "../../platform/api-base-url"
import { isClerkAuthEnabled } from "../../platform/auth-mode"
import type { Resources } from "../../platform/resources"
import { agentSetupPrompt } from "./onboard-skill"

/**
 * The coding-agent prompt's handoff: Copy mints a single-use code into the prompt (a new run), and
 * the run's stages are read back while the connect step polls.
 */

export const AgentSurface = Schema.Literals(["connect_step", "connect_panel"])
export type AgentSurface = typeof AgentSurface.Type

export const Model = Schema.Struct({
	surface: AgentSurface,
	copy: CopyButton.Model,
	/** A copy is minting its code: the clipboard is written once the code is back. */
	isMinting: Schema.Boolean,
	/** The prompt the last copy wrote, kept for "Show prompt" when the clipboard refused it. */
	copiedPrompt: Schema.NullOr(Schema.String),
	isCopyFailed: Schema.Boolean,
	isPromptShown: Schema.Boolean,
	/** The mint failed (an API key session, the store down): the prompt went out without a code. */
	isTrackingUnavailable: Schema.Boolean,
	isShownTracked: Schema.Boolean,
	run: Schema.NullOr(V2OnboardingAgentRun),
	/** The last read answered 404 (no run yet): reads pause until a copy starts one. */
	isRunMissing: Schema.Boolean,
	/** The org's arm of the handoff experiment, once read; `control` copies the prompt without a code. */
	arm: Schema.NullOr(OnboardingHandoffArm),
})
export type Model = typeof Model.Type

export const init = (surface: AgentSurface): Model => ({
	surface,
	copy: CopyButton.init(),
	isMinting: false,
	copiedPrompt: null,
	isCopyFailed: false,
	isPromptShown: false,
	isTrackingUnavailable: false,
	isShownTracked: false,
	run: null,
	isRunMissing: false,
	arm: null,
})

/**
 * How the copy that started with the click went: `written` or `refused` when the browser took the
 * write in the gesture (a `ClipboardItem` holding the pending prompt), `not_attempted` where it has
 * no `ClipboardItem`, so the prompt is written once it exists.
 */
export const ClipboardOutcome = Schema.Literals(["written", "refused", "not_attempted"])
export type ClipboardOutcome = typeof ClipboardOutcome.Type

export const Message = defineMessageUnion({
	ClickedCopyPrompt: { publicKey: Schema.String },
	SucceededMint: {
		publicKey: Schema.String,
		handoff: V2OnboardingAgentHandoff,
		clipboard: ClipboardOutcome,
	},
	FailedMint: { publicKey: Schema.String, clipboard: ClipboardOutcome },
	/** A `control` org's copy: the prompt went out without a code, by design. */
	SkippedMint: { publicKey: Schema.String, clipboard: ClipboardOutcome },
	ResolvedArm: { arm: OnboardingHandoffArm },
	GotCopyMessage: { message: CopyButton.Message },
	ClickedShowPrompt: {},
	SucceededLoadRun: { run: V2OnboardingAgentRun },
	FailedLoadRun: { isMissing: Schema.Boolean },
	CompletedTrack: {},
})
export type Message = typeof Message.Type

/** The prompt a copy puts on the clipboard: the one builder, so the copy and "Show prompt" agree. */
const handoffPrompt = (publicKey: string, handoff: Option.Option<V2OnboardingAgentHandoff>): string =>
	Option.match(handoff, {
		onNone: () => agentSetupPrompt(ingestUrl, publicKey),
		onSome: (minted) =>
			agentSetupPrompt(ingestUrl, publicKey, { code: minted.handoff_code, apiUrl: apiPublicUrl }),
	})

/** The org's arm, read on every call (the page outlives an org switch); self-hosted is always `handoff`. */
const readArm: Effect.Effect<OnboardingHandoffArm> = Effect.sync(() => {
	const orgId = window.Clerk?.organization?.id
	return isClerkAuthEnabled && orgId !== undefined ? onboardingHandoffArm(orgId) : "handoff"
})

export const ResolveArm = Command.define("ResolveOnboardingHandoffArm", {
	messages: [Message.ResolvedArm],
	execute: Effect.map(readArm, (arm) => Message.ResolvedArm({ arm })),
})

/**
 * `POST /v2/onboarding/agent_run` (never for a `control` org), then the prompt with its code on the
 * clipboard. The clipboard write opens first, synchronously in the click's task, because Safari
 * refuses one that starts after the request; the prompt fills it once the code is back.
 */
export const mintHandoff = (publicKey: string, armOf: Effect.Effect<OnboardingHandoffArm>) =>
	Effect.gen(function* () {
		const pending = yield* Effect.sync(openPendingClipboardWrite)
		const arm = yield* armOf
		const client = yield* MapleApiV2Client
		const minted =
			arm === "control"
				? Option.none<V2OnboardingAgentHandoff>()
				: yield* Effect.option(client.onboardingAgentRun.start())
		yield* Effect.sync(() => pending.fill(handoffPrompt(publicKey, minted)))
		const clipboard = yield* Option.match(pending.written, {
			onNone: () => Effect.succeed<ClipboardOutcome>("not_attempted"),
			onSome: (written) =>
				Effect.map(
					Effect.promise(() => written),
					(ok): ClipboardOutcome => (ok ? "written" : "refused"),
				),
		})
		if (arm === "control") return Message.SkippedMint({ publicKey, clipboard })
		return Option.match(minted, {
			onNone: () => Message.FailedMint({ publicKey, clipboard }),
			onSome: (handoff) => Message.SucceededMint({ publicKey, handoff, clipboard }),
		})
	})

export const MintHandoff = Command.define("MintOnboardingAgentHandoff", {
	args: { publicKey: Schema.String },
	messages: [Message.SucceededMint, Message.FailedMint, Message.SkippedMint],
	execute: ({ publicKey }) => mintHandoff(publicKey, readArm),
})

/** The API's 404 for a person with no run yet, as the client decodes it (the public envelope). */
const isRunNotFound = (error: unknown): boolean =>
	Predicate.hasProperty(error, "error") &&
	Predicate.isTagged(error.error, "@maple/http/errors/OnboardingAgentRunNotFoundError")

/** `GET /v2/onboarding/agent_run`: the caller's latest run; none yet (404) is a failed read. */
export const LoadAgentRun = Command.define("LoadOnboardingAgentRun", {
	messages: [Message.SucceededLoadRun, Message.FailedLoadRun],
	execute: Effect.gen(function* () {
		const client = yield* MapleApiV2Client
		return yield* client.onboardingAgentRun.retrieve()
	}).pipe(
		Effect.map((run) => Message.SucceededLoadRun({ run })),
		Effect.catch((error) => Effect.succeed(Message.FailedLoadRun({ isMissing: isRunNotFound(error) }))),
	),
})

const AgentEvent = Schema.Literals([
	"onboarding_agent_prompt_shown",
	"onboarding_agent_prompt_copied",
	"onboarding_agent_run_reported",
	"onboarding_agent_run_completed",
])

export const TrackAgentEvent = Command.define("TrackOnboardingAgentEvent", {
	args: { event: AgentEvent, surface: AgentSurface, hasHandoffCode: Schema.NullOr(Schema.Boolean) },
	messages: [Message.CompletedTrack],
	execute: ({ event, surface, hasHandoffCode }) =>
		Effect.flatMap(readArm, (arm) =>
			trackProduct(
				event,
				hasHandoffCode === null
					? { surface, arm }
					: { surface, arm, has_handoff_code: hasHandoffCode },
			),
		).pipe(Effect.as(Message.CompletedTrack())),
})

/** The run still takes reports: the page keeps reading it. */
export const isRunOpen = (run: V2OnboardingAgentRun): boolean =>
	run.status === "waiting_for_agent" || run.status === "in_progress"

/** The connect step's poll reads the run only while one is open. */
export const isPolling = (model: Model): boolean => model.run !== null && isRunOpen(model.run)

/**
 * Whether a poll reads the run: an open one, or none known yet until a read says there is none
 * (a failed read retries; a 404 waits for a copy, so the console is not a 404 every 5 seconds).
 */
export const shouldReadRun = (model: Model): boolean =>
	model.run === null ? !model.isRunMissing : isRunOpen(model.run)

type Step = Readonly<{
	model: Model
	commands: ReadonlyArray<Command.Command<Message, never, Resources>>
}>

/** The prompt was shown: tracked once per mount. */
export const shown = (model: Model): Step =>
	model.isShownTracked
		? { model, commands: [] }
		: {
				model: { ...model, isShownTracked: true },
				commands: [
					ResolveArm(),
					TrackAgentEvent({
						event: "onboarding_agent_prompt_shown",
						surface: model.surface,
						hasHandoffCode: null,
					}),
				],
			}

const copyStep = (model: Model, message: CopyButton.Message): Step => {
	const next = CopyButton.update(model.copy, message)
	const isFailed = message._tag === "FailedCopy" && message.generation === model.copy.generation
	return {
		model: { ...model, copy: next.model, isCopyFailed: isFailed || model.isCopyFailed },
		commands: Command.mapMessages(next.commands ?? [], (child) =>
			Message.GotCopyMessage({ message: child }),
		),
	}
}

/**
 * Puts `prompt` on the clipboard and tracks the copy: written here only when the click could not
 * open the write itself; otherwise the copy button just shows how that write went.
 */
const copyPrompt = (
	model: Model,
	prompt: string,
	hasHandoffCode: boolean,
	clipboard: ClipboardOutcome,
): Step => {
	const base = { ...model, isMinting: false, copiedPrompt: prompt }
	const generation = model.copy.generation + 1
	const next =
		clipboard === "not_attempted"
			? copyStep(base, CopyButton.Message.ClickedCopy({ text: prompt }))
			: copyStep(
					{ ...base, copy: { ...base.copy, generation } },
					clipboard === "written"
						? CopyButton.Message.SucceededCopy({ generation })
						: CopyButton.Message.FailedCopy({ generation }),
				)
	return {
		model: next.model,
		commands: [
			...next.commands,
			TrackAgentEvent({
				event: "onboarding_agent_prompt_copied",
				surface: model.surface,
				hasHandoffCode,
			}),
		],
	}
}

const track = (model: Model, event: typeof AgentEvent.Type) =>
	TrackAgentEvent({ event, surface: model.surface, hasHandoffCode: null })

/** A read of the shown run from before its latest report, or from before it closed. */
const isOlderRead = (run: V2OnboardingAgentRun, shown: V2OnboardingAgentRun): boolean =>
	(shown.last_reported_at !== null &&
		(run.last_reported_at === null || run.last_reported_at < shown.last_reported_at)) ||
	(!isRunOpen(shown) && isRunOpen(run))

/**
 * A read run replaces the shown one when it is the same run or a newer one; with none shown, only
 * an open run is picked up. The first report and completing are tracked once each.
 */
const loadedRun = (model: Model, run: V2OnboardingAgentRun): Step => {
	const previous = model.run
	// A closed run from an earlier visit is not shown, and counts as "none yet": reads pause until a copy.
	if (previous === null)
		return isRunOpen(run)
			? { model: { ...model, run }, commands: [] }
			: { model: { ...model, isRunMissing: true }, commands: [] }
	if (run.created_at < previous.created_at) return { model, commands: [] }
	const isSameRun = run.created_at === previous.created_at
	// Polls overlap: a slower, older read of the same run never replaces a newer one.
	if (isSameRun && isOlderRead(run, previous)) return { model, commands: [] }
	return {
		model: { ...model, run },
		commands: [
			// The first report, not a status change: an unclaimed run that expires was never reported.
			...(isSameRun && previous.last_reported_at === null && run.last_reported_at !== null
				? [track(model, "onboarding_agent_run_reported")]
				: []),
			...(isSameRun && previous.status !== "completed" && run.status === "completed"
				? [track(model, "onboarding_agent_run_completed")]
				: []),
		],
	}
}

export const update = (model: Model, message: Message): Step =>
	Message.match<Step>(message, {
		// Every copy mints a fresh code: a code is single use, and a new run replaces the old.
		ClickedCopyPrompt: ({ publicKey }) =>
			model.isMinting
				? { model, commands: [] }
				: {
						model: { ...model, isMinting: true, isCopyFailed: false, isPromptShown: false },
						commands: [MintHandoff({ publicKey })],
					},
		SucceededMint: ({ publicKey, handoff, clipboard }) =>
			copyPrompt(
				{ ...model, run: handoff.run, isTrackingUnavailable: false },
				handoffPrompt(publicKey, Option.some(handoff)),
				true,
				clipboard,
			),
		FailedMint: ({ publicKey, clipboard }) =>
			copyPrompt(
				{ ...model, isTrackingUnavailable: true },
				handoffPrompt(publicKey, Option.none()),
				false,
				clipboard,
			),
		SkippedMint: ({ publicKey, clipboard }) =>
			copyPrompt(
				{ ...model, arm: "control" },
				handoffPrompt(publicKey, Option.none()),
				false,
				clipboard,
			),
		ResolvedArm: ({ arm }) => ({ model: { ...model, arm }, commands: [] }),
		GotCopyMessage: ({ message: child }) => copyStep(model, child),
		ClickedShowPrompt: () => ({ model: { ...model, isPromptShown: !model.isPromptShown }, commands: [] }),
		SucceededLoadRun: ({ run }) => loadedRun(model, run),
		FailedLoadRun: ({ isMissing }) => ({ model: { ...model, isRunMissing: isMissing }, commands: [] }),
		CompletedTrack: () => ({ model, commands: [] }),
	})
