// Follow the OS theme before first paint so light-mode users don't see a dark flash.
// A file, not an inline script, so the CSP's `script-src 'self'` allows it. entry.ts takes over from here.
;(() => {
	const theme = window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark"
	const root = document.documentElement
	root.classList.remove("light", "dark")
	root.classList.add(theme)
	root.style.colorScheme = theme
})()
