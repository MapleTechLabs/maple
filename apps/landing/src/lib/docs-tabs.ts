// Client side of every docs tab group: `<LanguageTabs>` and the package-manager
// switchers `remark-install-tabs.mjs` renders. A group's `data-lang-tabs` value
// is the storage key its pick is remembered under; picking a tab switches every
// group sharing that key. Groups nest (an install switcher inside a language
// panel), so triggers and panels are always resolved against their own group.
// Side-effecting on import; a module evaluates once however many scripts import it.

const readStored = (key: string) => {
	try {
		return localStorage.getItem(key)
	} catch {
		return null
	}
}

const writeStored = (key: string, id: string) => {
	try {
		localStorage.setItem(key, id)
	} catch {
		// Storage blocked: the choice just isn't remembered.
	}
}

const roots = Array.from(document.querySelectorAll<HTMLElement>("[data-lang-tabs]"))

const triggersOf = (root: HTMLElement) =>
	Array.from(root.querySelectorAll<HTMLElement>(":scope > .lt__rail > [data-lang-trigger]"))

const groupOf = (trigger: HTMLElement) => trigger.closest<HTMLElement>("[data-lang-tabs]")

// A group without the requested id keeps its current tab.
const activate = (root: HTMLElement, id: string) => {
	const triggers = triggersOf(root)
	if (!triggers.some((t) => t.dataset.langTrigger === id)) return false
	for (const t of triggers) {
		const on = t.dataset.langTrigger === id
		t.setAttribute("aria-selected", on ? "true" : "false")
		t.tabIndex = on ? 0 : -1
	}
	for (const panel of root.querySelectorAll<HTMLElement>(":scope > .lt__panels > [data-lang-panel]")) {
		panel.hidden = panel.dataset.langPanel !== id
	}
	return true
}

const select = (key: string, id: string) => {
	writeStored(key, id)
	for (const root of roots) if (root.dataset.langTabs === key) activate(root, id)
}

// A link like `?lang=typescript` (the cards on /docs/agent-tracing) opens the
// language groups on that tab when the page has one, and it becomes the
// remembered choice. The param is then dropped, so a reload keeps later picks.
const LANGUAGE_KEY = "maple-docs-language"
const url = new URL(location.href)
const requested = url.searchParams.get("lang")
const linked = roots.some(
	(root) =>
		root.dataset.langTabs === LANGUAGE_KEY && triggersOf(root).some((t) => t.dataset.langTrigger === requested),
)
	? requested
	: null
if (linked) {
	writeStored(LANGUAGE_KEY, linked)
	url.searchParams.delete("lang")
	history.replaceState(history.state, "", url)
}

for (const root of roots) {
	const key = root.dataset.langTabs ?? ""
	const stored = (key === LANGUAGE_KEY && linked) || readStored(key)
	const first = triggersOf(root)[0]?.dataset.langTrigger
	if (!(stored && activate(root, stored)) && first) activate(root, first)
	root.dataset.ready = ""
}

document.addEventListener("click", (event) => {
	const trigger = (event.target as HTMLElement | null)?.closest<HTMLElement>("[data-lang-trigger]")
	const key = trigger && groupOf(trigger)?.dataset.langTabs
	if (!trigger?.dataset.langTrigger || !key) return
	// Keep the clicked tab under the pointer when other groups above it change height.
	const top = trigger.getBoundingClientRect().top
	select(key, trigger.dataset.langTrigger)
	window.scrollBy(0, trigger.getBoundingClientRect().top - top)
})

document.addEventListener("keydown", (event) => {
	const current = event.target as HTMLElement
	const root = current.dataset?.langTrigger ? groupOf(current) : null
	const key = root?.dataset.langTabs
	if (!root || !key) return
	const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0
	if (!step) return
	event.preventDefault()
	const triggers = triggersOf(root)
	const next = triggers[(triggers.indexOf(current) + step + triggers.length) % triggers.length]
	if (next?.dataset.langTrigger) {
		select(key, next.dataset.langTrigger)
		next.focus()
	}
})
