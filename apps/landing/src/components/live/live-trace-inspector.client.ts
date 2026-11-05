import { Array as Arr, Predicate, Record as Rec } from "effect"
/**
 * Wires waterfall row hover to the side-panel attribute inspector.
 * Touch users get the same behaviour via `pointerenter` (rAF debounced).
 */

export function wireInspector(traceId: string) {
	const inspector = document.querySelector<HTMLElement>(`[data-trace-inspector="${traceId}"]`)
	const trace = document.querySelector<HTMLElement>(`[data-trace-id="${traceId}"]`)
	if (!inspector || !trace) return

	const titleEl = inspector.querySelector<HTMLElement>("[data-inspector-title]")!
	const durEl = inspector.querySelector<HTMLElement>("[data-inspector-duration]")!
	const attrsEl = inspector.querySelector<HTMLElement>("[data-inspector-attrs]")!

	const renderRow = (row: HTMLElement) => {
		const service = row.dataset.service ?? ""
		const op = row.dataset.op ?? ""
		const dur = row.dataset.duration ?? ""
		let attrs: Record<string, string> = {}
		try {
			// oxlint-disable-next-line effecttsgo/global-json -- landing client island; keeps the effect runtime out of the marketing bundle
			const parsed: unknown = JSON.parse(row.dataset.attrs ?? "{}")
			attrs = isStringRecord(parsed) ? parsed : {}
		} catch {
			attrs = {}
		}
		titleEl.textContent = `${service} · ${op}`
		durEl.textContent = `${dur}ms`
		attrsEl.innerHTML = renderAttrs(attrs)
	}

	trace.addEventListener("pointerover", (e) => {
		const row = (e.target as HTMLElement | null)?.closest<HTMLElement>(".waterfall-row")
		if (row) renderRow(row)
	})
}

const isStringRecord = (value: unknown): value is Record<string, string> =>
	Predicate.isObject(value) && Arr.every(Rec.values(value), (v) => typeof v === "string")

function renderAttrs(attrs: Record<string, string>): string {
	const escape = (s: string) =>
		s.replace(
			/[&<>"']/g,
			(c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string,
		)
	const rows = Arr.join(
		Arr.map(
			Rec.toEntries(attrs),
			([k, v]) =>
				`<dt class="text-fg-muted">${escape(k)}</dt><dd class="text-fg break-all">${escape(v)}</dd>`,
		),
		"",
	)
	return `<div class="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">${rows}</div>`
}
