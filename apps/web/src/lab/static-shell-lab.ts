import { Effect, Schema } from "effect"
import type { Html, HtmlBuilder } from "foldkit/html"
import type * as Shell from "../shell"
import type { LabEntry } from "./define"
import { defineShellLab } from "./shell-lab"

// A lab page with no state of its own inside the real shell.

const Empty = Schema.Struct({})

export const defineStaticShellLab = (
	title: string,
	frame: Readonly<{
		currentPath: string
		breadcrumbs: ReadonlyArray<Shell.BreadcrumbEntry>
		page: (h: HtmlBuilder<never>) => Html
	}>,
): LabEntry =>
	defineShellLab(title, {
		Model: Empty,
		Message: Schema.Never,
		Flags: Empty,
		flags: Effect.succeed({}),
		init: () => ({ model: {} }),
		update: (model) => ({ model }),
		view: (_model, h) => frame.page(h),
		currentPath: frame.currentPath,
		breadcrumbs: frame.breadcrumbs,
	})
