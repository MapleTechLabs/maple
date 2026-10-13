// Turns docs shell blocks that only install packages into a package-manager
// switcher: `npm install` gains pnpm and bun twins, `pip install` a uv twin.
// Authors keep writing plain npm/pip, so the `/docs/<slug>.md` twins (served
// from the source body) stay plain. The output is the markup LanguageTabs
// renders, driven by the same script (`docs-tabs.ts`), with each variant kept a
// real code node so Shiki and the copy buttons treat it like any other block.

const SHELL_LANGS = new Set(["bash", "sh", "shell", "console"])

const MANAGERS = {
	js: {
		storageKey: "maple-docs-js-package-manager",
		variants: [
			{ id: "npm", convert: (command) => command },
			{ id: "pnpm", convert: (command) => npmTo(command, "pnpm", "-D") },
			{ id: "bun", convert: (command) => npmTo(command, "bun", "--dev") },
		],
	},
	python: {
		storageKey: "maple-docs-python-package-manager",
		variants: [
			{ id: "pip", convert: (command) => command },
			{ id: "uv", convert: (command) => command.replace(PIP_INSTALL, "$1uv add") },
		],
	},
}

const NPM_INSTALL = /^(\s*)npm\s+(?:install|i|add)(?=\s|$)/
const PIP_INSTALL = /^(\s*)(?:pip3?|python3?\s+-m\s+pip)\s+install(?=\s|$)/
const DEV_FLAG = /(?<=\s)(?:-D|--save-dev)(?=\s|$)/g

const npmTo = (command, manager, devFlag) => {
	const args = command.replace(NPM_INSTALL, "").split(/\s+/)
	const verb = args.some((arg) => arg && arg !== "\\" && !arg.startsWith("-")) ? "add" : "install"
	return command.replace(NPM_INSTALL, `$1${manager} ${verb}`).replace(DEV_FLAG, devFlag)
}

const ecosystemOf = (command) =>
	NPM_INSTALL.test(command) ? "js" : PIP_INSTALL.test(command) ? "python" : undefined

/**
 * The per-manager variants of a shell block, or undefined when the block does
 * anything besides installing packages (exports, chained commands, a mix of
 * npm and pip), so it renders unchanged.
 */
export function installVariants(source) {
	// Logical commands: a trailing `\` continues onto the next line.
	const commands = []
	let current = []
	for (const line of source.split("\n")) {
		current.push(line)
		if (!line.trimEnd().endsWith("\\")) {
			commands.push(current.join("\n"))
			current = []
		}
	}
	if (current.length) commands.push(current.join("\n"))

	let ecosystem
	for (const command of commands) {
		const trimmed = command.trim()
		if (trimmed === "" || trimmed.startsWith("#")) continue
		if (/[;&|]/.test(command)) return undefined
		const kind = ecosystemOf(command)
		if (!kind || (ecosystem && kind !== ecosystem)) return undefined
		ecosystem = kind
	}
	if (!ecosystem) return undefined

	const { storageKey, variants } = MANAGERS[ecosystem]
	return {
		storageKey,
		variants: variants.map(({ id, convert }) => ({
			id,
			value: commands.map((command) => (ecosystemOf(command) ? convert(command) : command)).join("\n"),
		})),
	}
}

const el = (tagName, properties, children = []) => ({ type: "element", tagName, properties, children })

const terminalIcon = () =>
	el(
		"svg",
		{
			className: ["lt__icon"],
			viewBox: "0 0 24 24",
			fill: "none",
			stroke: "currentColor",
			strokeWidth: "1.6",
			strokeLinecap: "round",
			strokeLinejoin: "round",
			ariaHidden: "true",
		},
		[
			el("rect", { x: "2.5", y: "4.5", width: "19", height: "15", rx: "2.5" }),
			el("polyline", { points: "6.5 9.5 9.5 12 6.5 14.5" }),
			el("line", { x1: "12.5", y1: "14.5", x2: "16.5", y2: "14.5" }),
		],
	)

// mdast nodes of an unknown type become the element named by `data.hName`;
// `hChildren` supplies ready-made hast for the tab rail.
const tabsNode = (code, { storageKey, variants }) => ({
	type: "installTabs",
	data: { hName: "div", hProperties: { className: ["lt", "lt--code"], dataLangTabs: storageKey } },
	children: [
		{
			type: "installTabsRail",
			data: {
				hName: "div",
				hProperties: { className: ["lt__rail"], role: "tablist", ariaLabel: "Package manager" },
				hChildren: variants.map(({ id }, index) =>
					el(
						"button",
						{
							type: "button",
							role: "tab",
							className: ["lt__tab"],
							dataLangTrigger: id,
							ariaSelected: index === 0 ? "true" : "false",
							tabIndex: index === 0 ? 0 : -1,
						},
						[terminalIcon(), el("span", {}, [{ type: "text", value: id }])],
					),
				),
			},
		},
		{
			type: "installTabsPanels",
			data: { hName: "div", hProperties: { className: ["lt__panels"] } },
			children: variants.map(({ id, value }) => ({
				type: "installTabsPanel",
				data: { hName: "div", hProperties: { dataLangPanel: id, role: "tabpanel" } },
				children: [{ ...code, value }],
			})),
		},
	],
})

export default function remarkInstallTabs() {
	return (tree, file) => {
		// Only docs load the tabs script; elsewhere the block stays a block.
		if (!file.path?.includes("/src/content/docs/")) return
		const walk = (node) => {
			if (!Array.isArray(node.children)) return
			node.children = node.children.map((child) => {
				if (child.type === "code" && SHELL_LANGS.has(child.lang)) {
					const install = installVariants(child.value)
					return install ? tabsNode(child, install) : child
				}
				walk(child)
				return child
			})
		}
		walk(tree)
	}
}
