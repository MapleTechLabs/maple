import { GCP_SCOPE_NAMES } from "../../components/integrations/gcp-connector-state"
import type { ChildAttribute, Html, HtmlBuilder } from "foldkit/html"
import * as DialogView from "../../ui/dialog-view"
import { skeleton } from "../../ui/skeleton"
import type { ConfigureModel } from "./gcp-configure-schema"
import { Message } from "./message"
import type { Model } from "./model"
import { configureConnector, metricsAvailable } from "./update-gcp-configure"
import { chooseConfirm, chooseStage } from "./view-gcp-configure-choose"
import { configureHeader, configurePanel } from "./view-gcp-configure-parts"
import { methodApplyStage, methodStage } from "./view-gcp-configure-method"
import { applyStage } from "./view-gcp-configure-run"

// `GcpConfigure`: an existing connection's Edit data and Reconnect, in one dialog. A new connection
// is made in the connect flow (`view-flow-gcp.ts`).

type H = HtmlBuilder<Message>

const stages = (
	h: H,
	model: Model,
	configure: ConfigureModel,
	close: ReadonlyArray<ChildAttribute>,
	timeZone: string,
): ReadonlyArray<Html> => {
	const connector = configureConnector(model, configure)
	const available = metricsAvailable(model)
	if (connector === undefined)
		return [configureHeader(h, ["Google Cloud"], 1), configurePanel(h, [skeleton(h, "h-40 w-full")])]
	const created = configure.created?.id === connector.id
	const title = [
		GCP_SCOPE_NAMES[connector.scope_type],
		" ",
		h.span([h.Class("font-mono whitespace-nowrap")], [connector.scope_id]),
	]
	if (configure.opened === null)
		return configure.connectionStage === "choose"
			? chooseStage(h, configure, connector, { title, metricsAvailable: available, close })
			: methodStage(h, configure, connector, title)
	return configure.method === "script"
		? applyStage(h, model, configure, connector, { title, created, opened: configure.opened, timeZone })
		: methodApplyStage(h, model, configure, connector, { title, opened: configure.opened })
}

/** `GcpConfigureFrame`: the dialog every step renders in, open while the wizard is. */
export const gcpConfigure = (h: H, model: Model, timeZone: string): ReadonlyArray<Html> => {
	const configure = model.gcpCard.configure
	if (configure === null || configure.target._tag === "New") return []
	const connector = configureConnector(model, configure)
	return [
		h.submodel({
			slotId: "gcp-configure",
			model: configure.dialog,
			view: DialogView.view,
			toParentMessage: (message) => Message.GotGcpConfigureDialogMessage({ message }),
			viewInputs: {
				hasTrigger: false,
				hasDescription: false,
				className: "font-display sm:max-w-2xl",
				nestedDialogs: configure.confirm.isOpen ? 1 : 0,
				toView: ({ portal }) => portal ?? h.empty,
				toContent: (close) => stages(h, model, configure, close, timeZone),
			},
		}),
		...(connector === undefined ? [] : [chooseConfirm(h, configure, connector)]),
	]
}
