import { cn } from "@maple/ui/lib/utils"

/** Tiny muted text action used inside log detail surfaces ("Show full message", "Open detail"). */
export function LogTextButton({ className, ...props }: React.ComponentProps<"button">) {
	return (
		<button
			type="button"
			className={cn(
				"flex cursor-pointer items-center gap-1 text-[10px] text-muted-foreground transition-colors hover:text-foreground",
				className,
			)}
			{...props}
		/>
	)
}
