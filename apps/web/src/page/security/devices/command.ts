import { readClock } from "@maple/views/data/timing"
import { Effect, Schema } from "effect"
import { Command } from "foldkit"
import { settleTo } from "@maple/views/data/load-failure"
import { MapleInternalApiClient } from "../../../platform/api-clients"
import { Message } from "./model"

// The Devices page's read on the api Worker. Names start with `SecurityApi` (and the clock's with
// `ReadSecurity`) so the lab drops them.

export const ReadDevicesClock = readClock("ReadSecurityDevicesClock", Message.ReadClock)

export const FetchDevices = Command.define("SecurityApiDevices", {
	args: { key: Schema.String },
	messages: [Message.CompletedFetchDevices],
	execute: ({ key }) =>
		Effect.flatMap(MapleInternalApiClient, (api) => api.deviceSecurity.devices()).pipe(
			settleTo((result) => Message.CompletedFetchDevices({ key, result })),
		),
})
