import { useMountEffect } from "@maple/ui/hooks/use-mount-effect"
import { Button } from "@maple/ui/components/ui/button"
import {
	Command,
	CommandDialog,
	CommandDialogPopup,
	CommandFooter,
	CommandGroup,
	CommandGroupLabel,
	CommandInput,
	CommandItem,
	CommandList,
	CommandShortcut,
} from "@maple/ui/components/ui/command"
import {
	ContextMenu,
	ContextMenuContent,
	ContextMenuItem,
	ContextMenuSeparator,
	ContextMenuShortcut,
	ContextMenuTrigger,
} from "@maple/ui/components/ui/context-menu"
import {
	DropdownMenu,
	DropdownMenuCheckboxItem,
	DropdownMenuContent,
	DropdownMenuGroup,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuRadioGroup,
	DropdownMenuRadioItem,
	DropdownMenuSeparator,
	DropdownMenuShortcut,
	DropdownMenuSub,
	DropdownMenuSubContent,
	DropdownMenuSubTrigger,
	DropdownMenuTrigger,
} from "@maple/ui/components/ui/dropdown-menu"
import { Kbd } from "@maple/ui/components/ui/kbd"
import { toastManager } from "@maple/ui/components/ui/toast"

// Menus, the command palette and toasts for `/lab/kit/overlays`, each open on mount.
export function KitDropdownMenu() {
	return (
		<DropdownMenu defaultOpen>
			<DropdownMenuTrigger render={<Button variant="outline" />}>Row actions</DropdownMenuTrigger>
			<DropdownMenuContent className="w-56">
				<DropdownMenuGroup>
					<DropdownMenuLabel>Trace</DropdownMenuLabel>
					<DropdownMenuItem>
						Open trace <DropdownMenuShortcut>Enter</DropdownMenuShortcut>
					</DropdownMenuItem>
					<DropdownMenuItem>
						Copy trace id <DropdownMenuShortcut>Cmd C</DropdownMenuShortcut>
					</DropdownMenuItem>
				</DropdownMenuGroup>
				<DropdownMenuSub>
					<DropdownMenuSubTrigger>Add to dashboard</DropdownMenuSubTrigger>
					<DropdownMenuSubContent>
						<DropdownMenuItem>Checkout latency</DropdownMenuItem>
						<DropdownMenuItem>Payments</DropdownMenuItem>
					</DropdownMenuSubContent>
				</DropdownMenuSub>
				<DropdownMenuSeparator />
				<DropdownMenuCheckboxItem defaultChecked>Show attributes</DropdownMenuCheckboxItem>
				<DropdownMenuCheckboxItem>Wrap lines</DropdownMenuCheckboxItem>
				<DropdownMenuSeparator />
				<DropdownMenuRadioGroup defaultValue="comfortable">
					<DropdownMenuRadioItem value="compact">Compact</DropdownMenuRadioItem>
					<DropdownMenuRadioItem value="comfortable">Comfortable</DropdownMenuRadioItem>
				</DropdownMenuRadioGroup>
				<DropdownMenuSeparator />
				<DropdownMenuItem variant="destructive">Delete</DropdownMenuItem>
			</DropdownMenuContent>
		</DropdownMenu>
	)
}

export function KitContextMenu() {
	return (
		// Not `defaultOpen`: a context menu anchors at the pointer, so the parity scenario opens it
		// with a right-click on the trigger instead of letting it open at (0, 0).
		<ContextMenu>
			<ContextMenuTrigger className="flex h-40 w-80 items-center justify-center rounded-lg border border-dashed text-muted-foreground text-sm">
				Right-click a span
			</ContextMenuTrigger>
			<ContextMenuContent className="w-52">
				<ContextMenuItem>
					Filter by service <ContextMenuShortcut>F</ContextMenuShortcut>
				</ContextMenuItem>
				<ContextMenuItem>Exclude service</ContextMenuItem>
				<ContextMenuSeparator />
				<ContextMenuItem variant="destructive">Hide span</ContextMenuItem>
			</ContextMenuContent>
		</ContextMenu>
	)
}

const COMMANDS = [
	{
		group: "Pages",
		items: [
			["Overview", "G O"],
			["Traces", "G T"],
			["Logs", "G L"],
		],
	},
	{
		group: "Actions",
		items: [
			["Create dashboard", ""],
			["Invite teammate", ""],
		],
	},
] as const

export function KitCommand() {
	return (
		<CommandDialog defaultOpen>
			<CommandDialogPopup>
				<Command>
					<CommandInput placeholder="Search pages, dashboards, actions" />
					<CommandList>
						{COMMANDS.map(({ group, items }) => (
							<CommandGroup key={group}>
								<CommandGroupLabel>{group}</CommandGroupLabel>
								{items.map(([title, shortcut]) => (
									<CommandItem key={title} value={title}>
										<span className="truncate text-sm">{title}</span>
										{shortcut ? <CommandShortcut>{shortcut}</CommandShortcut> : null}
									</CommandItem>
								))}
							</CommandGroup>
						))}
					</CommandList>
					<CommandFooter>
						<span className="flex items-center gap-1.5">
							<Kbd>Enter</Kbd> to open
						</span>
						<span className="flex items-center gap-1.5">
							<Kbd>Esc</Kbd> to close
						</span>
					</CommandFooter>
				</Command>
			</CommandDialogPopup>
		</CommandDialog>
	)
}

export type KitToastType = "default" | "success" | "error" | "info" | "warning" | "loading"

const TOAST_COPY = {
	default: { title: "Dashboard saved", description: "Checkout latency is up to date." },
	success: { title: "Schema applied", description: "All 14 tables are on the latest version." },
	error: { title: "Failed to delete rule", description: "The alert rule is referenced by a policy." },
	info: { title: "New version available", description: "Reload to get the latest Maple." },
	warning: { title: "Approaching ingest quota", description: "82% of this month's spans are used." },
	loading: { title: "Exporting logs", description: "Preparing 12,480 rows." },
} satisfies Record<KitToastType, { title: string; description: string }>

// Adds one toast with no timeout and closes it on unmount (StrictMode remounts). Deferred a
// tick: child effects run before the root ToastProvider subscribes to the manager.
export function KitToast({ type }: { type: KitToastType }) {
	useMountEffect(() => {
		const copy = TOAST_COPY[type]
		const ids: Array<string> = []
		const timer = window.setTimeout(() => {
			ids.push(
				toastManager.add(
					type === "default" ? { ...copy, timeout: 0 } : { ...copy, timeout: 0, type },
				),
			)
		}, 0)
		return () => {
			window.clearTimeout(timer)
			ids.forEach((id) => toastManager.close(id))
		}
	})
	return (
		<p className="text-muted-foreground text-sm">Toast type: {type}, shown in the bottom right corner.</p>
	)
}
