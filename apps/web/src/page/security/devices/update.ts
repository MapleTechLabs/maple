import * as Keyed from "@maple/views/data/keyed"
import { requestKey } from "@maple/views/data/request-key"
import { Array as Arr } from "effect"
import type { AppRoute } from "../../../route"
import type { PageContext, PageReturn } from "../../contract"
import { chain, slotStep } from "../../kit/keyed-step"
import { FetchDevices, ReadDevicesClock } from "./command"
import { Message, type Model } from "./model"

type Return = PageReturn<Model, Message>

export type SecurityDevicesRoute = Extract<AppRoute, { readonly _tag: "SecurityDevices" }>

const readDevices = (model: Model, context: PageContext, mode: Keyed.ReadMode): Return =>
	slotStep(
		model,
		model.devices,
		(devices) => ({ devices }),
		requestKey(context.orgId, "deviceSecurity.devices", {}),
		mode,
		(key) => FetchDevices({ key }),
	)

export const init = (_route: SecurityDevicesRoute, context: PageContext): Return => {
	const model: Model = { nowMs: 0, devices: Keyed.idle(), expanded: [] }
	return chain({ model, commands: [ReadDevicesClock()] }, (next) => readDevices(next, context, "Load"))
}

export const routeChanged = (model: Model, _route: SecurityDevicesRoute, context: PageContext): Return =>
	readDevices(model, context, "Load")

export const update = (model: Model, message: Message, context: PageContext): Return =>
	Message.match(message, {
		ReadClock: ({ nowMs }) => ({ model: { ...model, nowMs } }),
		CompletedFetchDevices: ({ key, result }) => ({
			model: { ...model, devices: Keyed.accept(model.devices, key, result) },
		}),
		ClickedRetry: () =>
			chain({ model, commands: [ReadDevicesClock()] }, (next) =>
				readDevices(next, context, "Supersede"),
			),
		ToggledPolicy: ({ key }) => ({
			model: {
				...model,
				expanded: Arr.contains(model.expanded, key)
					? Arr.filter(model.expanded, (open) => open !== key)
					: [...model.expanded, key],
			},
		}),
	})
