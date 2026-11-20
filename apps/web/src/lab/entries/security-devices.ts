import { IntegrationsForbiddenError, IntegrationsPersistenceError } from "@maple/domain/http"
import { toLoadFailure } from "@maple/views/data/load-failure"
import { Array as Arr, Clock, Effect, Option, Result, Schema } from "effect"
import { Command } from "foldkit"
import { breadcrumbsOf } from "../../page/security/kit/layout"
import { Message, Model } from "../../page/security/devices/model"
import * as Devices from "../../page/security/devices/update"
import { view } from "../../page/security/devices/view"
import { AppRoute } from "../../route"
import { context, isLocalCommand } from "../security-lab/scenarios"
import {
	allClearDevices,
	authFailedDevices,
	firstSyncDevices,
	freeDevices,
	notConnectedDevices,
	premiumDevices,
	syncErrorDevices,
	twoSourceDevices,
} from "../security-devices-fixture"
import { defineShellLab } from "../shell-lab"

// `/lab/security-devices?state=<state>`: the Devices page in each state over fixtures, in the real
// shell. API Commands are dropped, so nothing leaves the browser.

const STATES = [
	"premium",
	"free",
	"two-sources",
	"not-connected",
	"first-sync",
	"auth-failed",
	"sync-error",
	"all-clear",
	"forbidden",
	"error",
	"loading",
] as const
const State = Schema.Literals(STATES)
type State = typeof State.Type
const isState = Schema.is(State)

const resultOf = (state: State, nowMs: number) => {
	switch (state) {
		case "premium":
			return Result.succeed(premiumDevices(nowMs))
		case "free":
			return Result.succeed(freeDevices(nowMs))
		case "two-sources":
			return Result.succeed(twoSourceDevices(nowMs))
		case "not-connected":
			return Result.succeed(notConnectedDevices)
		case "first-sync":
			return Result.succeed(firstSyncDevices(nowMs))
		case "auth-failed":
			return Result.succeed(authFailedDevices(nowMs))
		case "sync-error":
			return Result.succeed(syncErrorDevices(nowMs))
		case "all-clear":
			return Result.succeed(allClearDevices(nowMs))
		case "forbidden":
			return Result.fail(
				toLoadFailure(new IntegrationsForbiddenError({ message: "Missing security:manage" })),
			)
		case "error":
			return Result.fail(
				toLoadFailure(new IntegrationsPersistenceError({ message: "Database unavailable" })),
			)
		case "loading":
			return null
	}
}

const Flags = Schema.Struct({ nowMs: Schema.Finite, state: State })

export const lab = defineShellLab("Security devices", {
	Model,
	Message,
	Flags,
	flags: Effect.all({
		nowMs: Clock.currentTimeMillis,
		state: Effect.sync(() => {
			const state = Option.getOrNull(
				Option.fromNullishOr(new URLSearchParams(window.location.search).get("state")),
			)
			return isState(state) ? state : "premium"
		}),
	}),
	init: ({ nowMs, state }) => {
		const started = Devices.init(AppRoute.SecurityDevices(), context)
		const result = resultOf(state, nowMs)
		const clocked = Devices.update(started.model, Message.ReadClock({ nowMs }), context).model
		const model =
			result === null
				? clocked
				: Devices.update(
						clocked,
						Message.CompletedFetchDevices({ key: clocked.devices.key ?? "", result }),
						context,
					).model
		return { model, commands: Arr.filter(started.commands ?? [], isLocalCommand) }
	},
	update: (model, message) => {
		const next = Devices.update(model, message, context)
		return {
			model: next.model,
			commands: Command.mapMessages(Arr.filter(next.commands ?? [], isLocalCommand), (child) => child),
		}
	},
	view: (model, h) =>
		h.submodel({
			slotId: "security-devices-lab",
			model,
			view,
			viewInputs: { context },
			toParentMessage: (message) => message,
		}),
	currentPath: "/security/devices",
	breadcrumbs: breadcrumbsOf("devices"),
})
