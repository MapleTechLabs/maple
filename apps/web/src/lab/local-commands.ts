import { Array as Arr } from "effect"
import type { Command } from "foldkit"
import * as Animation from "@foldkit/ui/animation"
import { LoadChartRuntime } from "@maple/views/charts/chart-runtime"
import * as Dialog from "@maple/views/ui/dialog"
import * as Menu from "@maple/views/ui/menu"
import * as Popover from "@maple/views/ui/popover"
import * as Select from "@maple/views/ui/select"
import * as Tooltip from "@maple/views/ui/tooltip"
import type { Resources } from "../platform/resources"

/** The kit's own UI commands and the chart runtime; every page read and write is dropped. */
const LOCAL_COMMANDS: ReadonlySet<string> = new Set([
	LoadChartRuntime.name,
	Animation.WaitForPaint.name,
	Animation.WaitForAnimationSettled.name,
	Dialog.WaitForDialogTransition.name,
	Menu.FocusMenuItem.name,
	Menu.WaitSubmenuDelay.name,
	Menu.WaitForMenuExit.name,
	Select.FocusSelectItem.name,
	Select.WaitForSelectExit.name,
	Popover.WaitHoverDelay.name,
	Popover.WaitForPopoverExit.name,
	Tooltip.WaitOpenDelay.name,
	Tooltip.CheckFocusVisible.name,
])

/** An allowlist, not a denylist: a new API command stays off the real API with fixture ids. */
export const keepLocal = <M>(commands: ReadonlyArray<Command.Command<M, never, Resources>> | undefined) =>
	Arr.filter(commands ?? [], (command) => LOCAL_COMMANDS.has(command.name))
