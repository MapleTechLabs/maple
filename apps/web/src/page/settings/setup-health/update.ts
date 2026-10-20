import { Effect, Option } from "effect"
import { AsyncData, Command } from "foldkit"
import { toLoadFailure } from "../../../data/load-failure"
import { MapleApiV2Client } from "../../../platform/api-clients"
import type { PageReturn } from "../../contract"
import { Message, type Model } from "./model"

type Return = PageReturn<Model, Message>

/** `setupAuditAtom`: `instrumentationAudit.retrieve`. */
export const FetchSetupAudit = Command.define("FetchSetupAudit", {
	messages: [Message.CompletedFetchAudit],
	execute: Effect.flatMap(MapleApiV2Client, (client) => client.instrumentationAudit.retrieve()).pipe(
		Effect.mapError(toLoadFailure),
		Effect.result,
		Effect.map((result) => Message.CompletedFetchAudit({ result })),
	),
})

export const init = (): Return => ({
	model: { audit: AsyncData.Loading(), isPassingOpen: false },
	commands: [FetchSetupAudit()],
})

/** Back on the tab: the last report stays. The audit is a dozen warehouse reads, so only Re-run repeats it. */
export const revisit = (model: Model): Return =>
	Option.match(AsyncData.loadIfMissing(model.audit), {
		onNone: () => ({ model }),
		onSome: (audit) => ({ model: { ...model, audit }, commands: [FetchSetupAudit()] }),
	})

export const update = (model: Model, message: Message): Return =>
	Message.match<Return>(message, {
		CompletedFetchAudit: ({ result }) => ({ model: { ...model, audit: AsyncData.settle(model.audit, result) } }),
		// `useAtomRefresh`: the report stays while the audit re-runs (`waiting` spins Re-run).
		ClickedRerun: () =>
			AsyncData.isRefreshing(model.audit)
				? { model }
				: {
						model: { ...model, audit: Option.getOrElse(AsyncData.revalidate(model.audit), () => model.audit) },
						commands: [FetchSetupAudit()],
					},
		ClickedRetry: () => ({ model: { ...model, audit: AsyncData.Loading() }, commands: [FetchSetupAudit()] }),
		ToggledPassing: () => ({ model: { ...model, isPassingOpen: !model.isPassingOpen } }),
	})
