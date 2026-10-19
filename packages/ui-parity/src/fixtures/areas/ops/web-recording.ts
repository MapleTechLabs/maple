import { formatMicros, type WarehouseRow } from "../../telemetry/rows.ts"
import { lookup } from "./synthetic.ts"

/**
 * The featured session's rrweb recording, payload inline (as self-hosted writes it): one
 * checkpoint chunk per page, each a Meta + FullSnapshot of a small storefront page followed by
 * mouse moves and the page's click.
 */

interface RrwebNode {
	readonly type: number
	readonly id: number
	readonly [key: string]: unknown
}

type Child = (nextId: () => number) => RrwebNode

const text =
	(content: string, isStyle = false): Child =>
	(nextId) => ({
		type: 3,
		id: nextId(),
		textContent: content,
		...(isStyle ? { isStyle: true } : undefined),
	})

const el =
	(tagName: string, attributes: Readonly<Record<string, string>>, children: ReadonlyArray<Child>): Child =>
	(nextId) => {
		const id = nextId()
		return { type: 2, id, tagName, attributes, childNodes: children.map((child) => child(nextId)) }
	}

const STYLE = [
	"body{margin:0;font-family:-apple-system,Helvetica,Arial,sans-serif;background:#faf7f2;color:#2b2118}",
	"header{display:flex;gap:24px;align-items:center;padding:18px 40px;background:#2b2118;color:#faf7f2}",
	"header strong{font-size:20px;margin-right:auto}",
	"main{padding:40px}",
	"h1{font-size:34px;margin:0 0 24px}",
	".grid{display:grid;grid-template-columns:repeat(3,1fr);gap:20px}",
	".card{background:#fff;border:1px solid #e6dccf;border-radius:10px;padding:20px;height:120px}",
	".primary{margin-top:28px;background:#c2410c;color:#fff;border:0;border-radius:8px;padding:14px 22px;font-size:16px}",
].join("")

/** Title, card texts and call to action per storefront page. */
type PageCopy = readonly [title: string, cards: ReadonlyArray<string>, cta: string]

const PAGE_COPY = {
	"/": [
		"Freshly roasted, shipped today",
		["House espresso", "Ethiopia Guji", "Decaf Colombia"],
		"Shop the roast",
	],
	"/products/espresso-grinder": [
		"Espresso grinder",
		["Stepless burr adjustment", "54 mm flat burrs", "Single dosing"],
		"Add to cart",
	],
	"/cart": ["Your cart", ["Espresso grinder  x1  $349", "Shipping  $0", "Total  $349"], "Checkout"],
	"/checkout": ["Checkout", ["Maria Garcia", "Card ending 4242", "Charge failed, retrying..."], "Pay $349"],
} satisfies Readonly<Record<string, PageCopy>>

const page = (path: string): Child => {
	const [title, cards, cta] = lookup(PAGE_COPY, path) ?? [path, [], "Continue"]
	return el("html", { lang: "en" }, [
		el("head", {}, [
			el("style", {}, [text(STYLE, true)]),
			el("title", {}, [text(`Acme Coffee - ${title}`)]),
		]),
		el("body", {}, [
			el("header", {}, [
				el("strong", {}, [text("Acme Coffee")]),
				el("span", {}, [text("Shop")]),
				el("span", {}, [text("Brew guides")]),
				el("span", {}, [text("Cart (1)")]),
			]),
			el("main", {}, [
				el("h1", {}, [text(title)]),
				el(
					"div",
					{ class: "grid" },
					cards.map((card) => el("div", { class: "card" }, [text(card)])),
				),
				el("button", { class: "primary" }, [text(cta)]),
			]),
		]),
	])
}

const snapshot = (path: string) => {
	const counter = { value: 1 }
	const nextId = () => {
		counter.value += 1
		return counter.value
	}
	const doctype = { type: 1, id: nextId(), name: "html", publicId: "", systemId: "" }
	return {
		node: { type: 0, id: 1, childNodes: [doctype, page(path)(nextId)] },
		initialOffset: { top: 0, left: 0 },
	}
}

export interface RecordingInput {
	readonly orgId: string
	readonly sessionId: string
	readonly host: string
	readonly startMs: number
	readonly offsets: ReadonlyArray<number>
	readonly paths: ReadonlyArray<string>
}

const WIDTH = 1280
const HEIGHT = 800

export const featuredRecording = (input: RecordingInput): ReadonlyArray<WarehouseRow> =>
	input.paths.map((path, index) => {
		const start = input.startMs + (input.offsets[index] ?? 0)
		const end = input.startMs + (input.offsets[index + 1] ?? input.offsets[index] ?? 0)
		const moves = Array.from({ length: 8 }, (_, step) => ({
			type: 3,
			timestamp: start + 1500 + step * Math.floor((end - start - 3000) / 8),
			data: {
				source: 1,
				positions: [{ x: 320 + step * 60, y: 260 + (step % 3) * 70, id: 1, timeOffset: 0 }],
			},
		}))
		const click = {
			type: 3,
			timestamp: start + 6000,
			data: { source: 2, type: 2, id: 1, x: 140, y: 420 },
		}
		const events = [
			{
				type: 4,
				timestamp: start,
				data: { href: `https://${input.host}${path}`, width: WIDTH, height: HEIGHT },
			},
			{ type: 2, timestamp: start, data: snapshot(path) },
			...moves.slice(0, 2),
			click,
			...moves.slice(2),
		]
		const payload = JSON.stringify(events)
		return {
			OrgId: input.orgId,
			SessionId: input.sessionId,
			ChunkSeq: index,
			Timestamp: formatMicros(start * 1000),
			DurationMs: end - start,
			EventCount: events.length,
			ByteSize: payload.length,
			Events: payload,
			IsCheckpoint: 1,
		}
	})
