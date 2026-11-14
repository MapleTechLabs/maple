/**
 * The Acme Shop storefront the replay plate records: a three-route single-page
 * app instrumented with the browser SDK. Its checkout fails the way the seeded
 * incident does (payment-svc times out), so the replay shows the failed request.
 */
import { MapleBrowser } from "../../../../../packages/browser/dist/index.mjs"

declare const __MAPLE__: { readonly endpoint: string; readonly ingestKey: string }

interface Product {
	readonly slug: string
	readonly name: string
	readonly price: number
	readonly tone: string
}

const TRAIL_RUNNER: Product = { slug: "trail-runner-2", name: "Trail Runner 2", price: 148, tone: "#c2410c" }

const PRODUCTS: ReadonlyArray<Product> = [
	TRAIL_RUNNER,
	{ slug: "linen-overshirt", name: "Linen Overshirt", price: 96, tone: "#a16207" },
	{ slug: "merino-crew", name: "Merino Crew", price: 84, tone: "#3f6212" },
	{ slug: "canvas-tote", name: "Canvas Tote", price: 38, tone: "#1e3a8a" },
	{ slug: "field-cap", name: "Field Cap", price: 32, tone: "#7c2d12" },
	{ slug: "wool-socks", name: "Wool Socks, 3 pack", price: 26, tone: "#374151" },
]

MapleBrowser.init({
	ingestKey: __MAPLE__.ingestKey,
	endpoint: __MAPLE__.endpoint,
	serviceName: "storefront-web",
	environment: "production",
	replay: { enabled: true, sampleRate: 1 },
	privacy: { maskAllInputs: true },
})

const cart: Array<Product> = []
const app = document.getElementById("app")!
const money = (n: number) => `$${n.toFixed(2)}`

const header = () => `
	<header class="bar">
		<a href="/" data-link class="brand">acme<span>.</span></a>
		<nav><a href="/" data-link>Shop</a><a href="/" data-link>Journal</a><a href="/cart" data-link class="cart">Cart (${cart.length})</a></nav>
	</header>`

const card = (p: Product) => `
	<a class="card" href="/product/${p.slug}" data-link>
		<div class="swatch" style="background:${p.tone}"></div>
		<div class="row"><span>${p.name}</span><span>${money(p.price)}</span></div>
	</a>`

const views = {
	home: () =>
		`${header()}<main><h1>Made for the long way round.</h1><p class="lede">Autumn pieces, built to be worn out.</p><section class="grid">${PRODUCTS.map(card).join("")}</section></main>`,
	product: (slug) => {
		const p = PRODUCTS.find((x) => x.slug === slug) ?? TRAIL_RUNNER
		return `${header()}<main class="pdp"><div class="swatch big" style="background:${p.tone}"></div><div><h1>${p.name}</h1><p class="price">${money(p.price)}</p><p class="lede">Waxed cotton, recycled sole, five-year repair promise.</p><div class="sizes">${["S", "M", "L", "XL"].map((s) => `<button class="size">${s}</button>`).join("")}</div><button id="add" class="primary">Add to cart</button></div></main>`
	},
	cart: () => {
		const total = cart.reduce((sum, p) => sum + p.price, 0)
		return `${header()}<main class="checkout"><h1>Checkout</h1>${cart.map((p) => `<div class="line"><span>${p.name}</span><span>${money(p.price)}</span></div>`).join("")}<div class="line total"><span>Total</span><span>${money(total)}</span></div><label>Email<input id="email" type="email" autocomplete="off" /></label><label>Card<input id="card" autocomplete="off" /></label><button id="pay" class="primary">Pay ${money(total)}</button><p id="status" class="status"></p></main>`
	},
} satisfies Record<string, (param: string) => string>

const isRoute = (route: string): route is keyof typeof views => route in views

const render = () => {
	const [, route = "", param = ""] = location.pathname.split("/")
	app.innerHTML = (isRoute(route) ? views[route] : views.home)(param)
	document.title = `Acme · ${route === "" ? "Shop" : route}`
}

const onClick = async (event: MouseEvent) => {
	const target = event.target instanceof Element ? event.target : null
	const link = target?.closest<HTMLAnchorElement>("a[data-link]")
	if (link) {
		event.preventDefault()
		history.pushState(null, "", link.getAttribute("href"))
		render()
		return
	}
	if (target?.closest(".size")) {
		for (const b of document.querySelectorAll(".size")) b.classList.remove("on")
		target.closest(".size")?.classList.add("on")
	}
	if (target?.id === "add") {
		const slug = location.pathname.split("/")[2]
		const product = PRODUCTS.find((p) => p.slug === slug)
		if (product) cart.push(product)
		await fetch("/api/cart", { method: "POST", body: JSON.stringify({ slug }) })
		render()
	}
	if (target?.id === "pay") {
		const status = document.getElementById("status")!
		status.textContent = "Processing…"
		const response = await fetch("/api/checkout", {
			method: "POST",
			body: JSON.stringify({ items: cart.length }),
		})
		status.textContent = response.ok ? "Paid" : "Payment failed. Your card was not charged, try again."
		status.className = response.ok ? "status" : "status error"
		if (!response.ok) console.error(`POST /api/checkout ${response.status}: payment-svc timed out`)
	}
}

document.addEventListener("click", (event) => void onClick(event))
window.addEventListener("popstate", render)
render()
