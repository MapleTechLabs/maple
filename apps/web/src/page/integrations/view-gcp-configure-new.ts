import type { V2GcpConnector } from "@maple/domain/http/v2"
import { Option } from "effect"
import type { ChildAttribute, Html, HtmlBuilder } from "foldkit/html"
import { button } from "../../ui/button"
import { createRequest, isScopeReady } from "./gcp-configure-derive"
import type { ConfigureModel } from "./gcp-configure-schema"
import { Message } from "./message"
import type { Model } from "./model"
import { collectFields } from "./view-gcp-configure-collect"
import { logFilter } from "./view-gcp-configure-filter"
import { configureFooter, configureHeader, configurePanel } from "./view-gcp-configure-parts"
import { scopeFields } from "./view-gcp-configure-scope"

// `NewConnection`: the scope, then what to collect. Creating it leads into the run step.

type H = HtmlBuilder<Message>

const FORM_ID = "gcp-configure-form"

export const newConnection = (
	h: H,
	model: Model,
	configure: ConfigureModel,
	options: Readonly<{
		title: ReadonlyArray<Html | string>
		existing: ReadonlyArray<V2GcpConnector>
		metricsAvailable: boolean
		close: ReadonlyArray<ChildAttribute>
	}>,
): ReadonlyArray<Html> => {
	const isScope = configure.step === "scope"
	const submitting = configure.isCreating
	const submit = isScope ? Message.SubmittedGcpScope() : Message.SubmittedGcpCreate()
	return [
		configureHeader(h, options.title, isScope ? 0 : 1),
		configurePanel(h, [
			h.form(
				[h.Id(FORM_ID), h.Class("flex w-full flex-col gap-6 text-left"), h.OnSubmit(submit)],
				[
					...(isScope
						? scopeFields(h, model, configure, options.existing)
						: [
								collectFields(h, {
									flags: configure.newFlags,
									metricsAvailable: options.metricsAvailable,
									logFilter: logFilter(h, configure, { sinkExists: false }),
								}),
							]),
					...(configure.createError === null
						? []
						: [
								h.p(
									[h.Class("text-xs text-destructive-foreground"), h.Role("alert")],
									[configure.createError],
								),
							]),
				],
			),
		]),
		configureFooter(h, [
			isScope
				? button(h, { variant: "outline", slot: "dialog-close", attributes: options.close }, [
						"Cancel",
					])
				: button(
						h,
						{
							variant: "outline",
							isDisabled: submitting,
							attributes: [h.OnClick(Message.ClickedGcpConfigureBack())],
						},
						["Back"],
					),
			button(
				h,
				{
					type: "submit",
					isDisabled: isScope ? !isScopeReady(configure) : Option.isNone(createRequest(configure)),
					isLoading: submitting,
					attributes: [h.Attribute("form", FORM_ID)],
				},
				["Continue"],
			),
		]),
	]
}
