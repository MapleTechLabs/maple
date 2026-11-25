import {
	click,
	Command,
	expect as expectView,
	expectOutMessage,
	given,
	role,
	scene,
	text,
} from "foldkit/scene"
import { describe, test } from "vitest"
import { CatalogPlan, CatalogPlanPrice, CatalogPlansResponse } from "@maple/domain/http"
import {
	AttachPlan,
	ENTERPRISE_CONTACT_URL,
	init,
	LoadPlans,
	Message as CardsMessage,
	OpenCheckout,
	OutMessage,
	PlansData,
	TrackCheckoutStarted,
	update,
} from "./pricing-cards"
import { view as cardsView } from "./pricing-cards-view"
import type { Model } from "./pricing-cards"
import type { HtmlBuilder } from "foldkit/html"
import type { Message } from "./pricing-cards"

const view = (model: Model, h: HtmlBuilder<Message>) => cardsView(model, { offer: "Subscribe" }, h)

const loaded = { ...init(), plans: PlansData.Success({ data: CatalogPlansResponse.make({ plans: [] }) }) }

describe("PricingCards Enterprise contact", () => {
	// A link the browser follows itself: it works where a script-opened tab is blocked.
	test("Talk to founder links to the booking page in a new tab", () => {
		const contact = role("link", { name: "Talk to founder (opens a new tab)" })
		scene(
			{ update, view },
			given(loaded),
			expectView(contact).toHaveAttr("href", ENTERPRISE_CONTACT_URL),
			expectView(contact).toHaveAttr("target", "_blank"),
			expectView(role("button", { name: /Talk to founder/ })).not.toExist(),
		)
	})
})

describe("PricingCards compliance", () => {
	test("the DPA is available and links to the request address", () => {
		scene(
			{ update, view },
			given(loaded),
			expectView(role("link", { name: "Request the DPA" })).toHaveAttr(
				"href",
				"mailto:privacy@maple.dev?subject=DPA%20request",
			),
		)
	})

	test("SOC 2 Type II and ISO 27001 read as in progress, not held", () => {
		scene(
			{ update, view },
			given(loaded),
			expectView(text("DPA available · SOC 2 Type II and ISO 27001 in progress")).toExist(),
		)
	})

	test("the line waits for the catalog to load", () => {
		scene(
			{ update, view },
			given(init()),
			expectView(role("link", { name: "Request the DPA" })).not.toExist(),
		)
	})
})

describe("PricingCards trial offer", () => {
	const startup = new CatalogPlan({
		id: "startup",
		name: "Startup",
		description: null,
		addOn: false,
		autoEnable: false,
		price: new CatalogPlanPrice({ amount: 39, interval: "month" }),
		items: [],
		archived: false,
	})
	const withStartup = {
		...init(),
		plans: PlansData.Success({ data: CatalogPlansResponse.make({ plans: [startup] }) }),
	}
	const trialView = (model: Model, h: HtmlBuilder<Message>) => cardsView(model, { offer: "Trial" }, h)

	const catalog = CardsMessage.SucceededLoadPlans({
		response: CatalogPlansResponse.make({ plans: [startup] }),
	})

	test("a new org starts the no-card trial inline, with no checkout", () => {
		scene(
			{ update, view: trialView },
			given(withStartup),
			expectView(text("No credit card needed · 100 GB per signal during the trial")).toExist(),
			click(role("button", { name: "Start 14-day free trial" })),
			Command.expectHas(AttachPlan({ planId: "trial" })),
			Command.resolve(
				AttachPlan({ planId: "trial" }),
				CardsMessage.SucceededAttach({ paymentUrl: null }),
			),
			expectOutMessage(OutMessage.ChangedPlan({ isLeavingForCheckout: false })),
			Command.resolve(LoadPlans(), catalog),
		)
	})

	test("a lapsed org subscribes to the plan itself, through checkout", () => {
		const url = "https://checkout.stripe.com/c/pay/cs_test"
		scene(
			{ update, view },
			given(withStartup),
			expectView(role("button", { name: "Start 14-day free trial" })).not.toExist(),
			click(role("button", { name: "Subscribe" })),
			Command.resolve(
				AttachPlan({ planId: "startup" }),
				CardsMessage.SucceededAttach({ paymentUrl: url }),
			),
			Command.expectHas(OpenCheckout({ url })),
			Command.resolve(LoadPlans(), catalog),
			Command.resolve(
				TrackCheckoutStarted({ planId: "startup" }),
				CardsMessage.CompletedTrackCheckoutStarted(),
			),
			Command.resolve(OpenCheckout({ url }), CardsMessage.CompletedOpenCheckout()),
		)
	})
})
