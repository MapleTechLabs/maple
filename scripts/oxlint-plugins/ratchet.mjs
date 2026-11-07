/**
 * The per-file burndown for UI lint rules. A file listed in `ui-kit-baseline.json` may keep the
 * count it had when a rule landed, never more. Dropping below the count is also reported, so the
 * baseline only shrinks (`bun run lint:ui-baseline` rewrites it). `MAPLE_UI_BASELINE=off` reports
 * everything, which is how that script counts.
 */
import { readFileSync } from "node:fs"
import { dirname, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, "../..")
const BASELINE_OFF = process.env.MAPLE_UI_BASELINE === "off"
const BASELINE = BASELINE_OFF ? {} : JSON.parse(readFileSync(resolve(HERE, "ui-kit-baseline.json"), "utf8"))

const BURNDOWN_HINT =
	"This file is on the UI-kit burndown (scripts/oxlint-plugins/ui-kit-baseline.json) with {{allowed}} of these and now has {{count}}."

/**
 * `collect(context, push)` returns visitors that `push(node, data)` each violation. A file over its
 * baseline gets every violation reported; a file under it gets one report asking to lower it.
 */
export const ratcheted = (name, { description, message, collect }) => ({
	meta: {
		type: "problem",
		docs: { description },
		messages: {
			bad: message,
			overBaseline: `${message} ${BURNDOWN_HINT} Fix the ones you added, or more.`,
			staleBaseline: `${BURNDOWN_HINT} Lower it: run \`bun run lint:ui-baseline\`.`,
		},
	},
	create(context) {
		const allowed = BASELINE[name]?.[relative(ROOT, context.filename)] ?? 0
		const found = []
		const visitors = collect(context, (node, data = {}) => found.push({ node, data }))
		return {
			...visitors,
			"Program:exit"(program) {
				if (found.length > allowed) {
					const messageId = allowed === 0 ? "bad" : "overBaseline"
					for (const { node, data } of found)
						context.report({ node, messageId, data: { ...data, allowed, count: found.length } })
				} else if (found.length < allowed) {
					context.report({
						node: program,
						messageId: "staleBaseline",
						data: { allowed, count: found.length },
					})
				}
			},
		}
	},
})
