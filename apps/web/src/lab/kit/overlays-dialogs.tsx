import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogPopup,
	AlertDialogTitle,
	AlertDialogTrigger,
} from "@maple/ui/components/ui/alert-dialog"
import { Button } from "@maple/ui/components/ui/button"
import {
	Dialog,
	DialogClose,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogPanel,
	DialogPopup,
	DialogTitle,
	DialogTrigger,
} from "@maple/ui/components/ui/dialog"
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@maple/ui/components/ui/hover-card"
import { Input } from "@maple/ui/components/ui/input"
import { Label } from "@maple/ui/components/ui/label"
import {
	Popover,
	PopoverDescription,
	PopoverPopup,
	PopoverTitle,
	PopoverTrigger,
} from "@maple/ui/components/ui/popover"
import {
	Sheet,
	SheetDescription,
	SheetFooter,
	SheetHeader,
	SheetPanel,
	SheetPopup,
	SheetTitle,
	SheetTrigger,
} from "@maple/ui/components/ui/sheet"
import { Tooltip, TooltipPopup, TooltipTrigger } from "@maple/ui/components/ui/tooltip"

// Dialog-like and anchored-card overlays for `/lab/kit/overlays`, each open on mount.
export function KitDialog() {
	return (
		<Dialog defaultOpen>
			<DialogTrigger render={<Button variant="outline" />}>Open dialog</DialogTrigger>
			<DialogPopup>
				<DialogHeader>
					<DialogTitle>Rename dashboard</DialogTitle>
					<DialogDescription>
						The new name shows in the sidebar for everyone in the org.
					</DialogDescription>
				</DialogHeader>
				<DialogPanel>
					<Label className="flex flex-col items-start gap-2">
						Name
						<Input defaultValue="Checkout latency" />
					</Label>
				</DialogPanel>
				<DialogFooter>
					<DialogClose render={<Button variant="ghost" />}>Cancel</DialogClose>
					<Button>Save</Button>
				</DialogFooter>
			</DialogPopup>
		</Dialog>
	)
}

export function KitAlertDialog() {
	return (
		<AlertDialog defaultOpen>
			<AlertDialogTrigger render={<Button variant="destructive-outline" />}>
				Delete alert rule
			</AlertDialogTrigger>
			<AlertDialogPopup>
				<AlertDialogHeader>
					<AlertDialogTitle>Delete this alert rule?</AlertDialogTitle>
					<AlertDialogDescription>
						Checkout p95 latency stops evaluating and its open incidents are resolved.
					</AlertDialogDescription>
				</AlertDialogHeader>
				<AlertDialogFooter>
					<AlertDialogCancel>Cancel</AlertDialogCancel>
					<AlertDialogAction variant="destructive">Delete rule</AlertDialogAction>
				</AlertDialogFooter>
			</AlertDialogPopup>
		</AlertDialog>
	)
}

export function KitSheet() {
	return (
		<Sheet defaultOpen>
			<SheetTrigger render={<Button variant="outline" />}>Open sheet</SheetTrigger>
			<SheetPopup side="right">
				<SheetHeader>
					<SheetTitle>Span details</SheetTitle>
					<SheetDescription>POST /api/checkout on checkout-svc</SheetDescription>
				</SheetHeader>
				<SheetPanel>
					<p className="text-sm">Duration 412 ms, status Error, 14 child spans.</p>
				</SheetPanel>
				<SheetFooter>
					<Button variant="outline">Open trace</Button>
				</SheetFooter>
			</SheetPopup>
		</Sheet>
	)
}

export function KitPopover() {
	return (
		<Popover defaultOpen>
			<PopoverTrigger render={<Button variant="outline" />}>Share</PopoverTrigger>
			<PopoverPopup className="w-72">
				<PopoverTitle>Share this view</PopoverTitle>
				<PopoverDescription>
					Anyone in the org with the link sees the same filters.
				</PopoverDescription>
			</PopoverPopup>
		</Popover>
	)
}

export function KitTooltip() {
	return (
		<Tooltip defaultOpen>
			<TooltipTrigger render={<Button variant="outline" />}>Hover target</TooltipTrigger>
			<TooltipPopup>Last refreshed 2 minutes ago</TooltipPopup>
		</Tooltip>
	)
}

export function KitHoverCard() {
	return (
		<HoverCard defaultOpen>
			<HoverCardTrigger render={<Button variant="link" />}>payment-svc</HoverCardTrigger>
			<HoverCardContent className="w-72">
				<div className="flex flex-col gap-1">
					<span className="font-medium text-sm">payment-svc</span>
					<span className="text-muted-foreground text-xs">412 req/s, 1.8% errors, p95 238 ms</span>
				</div>
			</HoverCardContent>
		</HoverCard>
	)
}
