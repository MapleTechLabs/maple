import { Avatar, AvatarFallback, AvatarImage } from "@maple/ui/components/ui/avatar"
import { cn } from "@maple/ui/lib/utils"
import { initialsFrom } from "@maple/ui/lib/initials"

/**
 * The signed-in user's avatar. Shared by the sidebar menus, the onboarding header and
 * `/account` so one image/initials fallback covers every surface.
 */
export function UserAvatar({
	imageUrl,
	initials,
	name,
	className,
}: {
	imageUrl?: string
	initials: string
	name: string
	className?: string
}) {
	return (
		<Avatar className={cn("bg-muted", className ?? "size-6 rounded-md text-3xs")}>
			{imageUrl && <AvatarImage alt={name} src={imageUrl} />}
			<AvatarFallback className="rounded-[inherit] font-medium text-muted-foreground">
				{initials}
			</AvatarFallback>
		</Avatar>
	)
}

/** Two-letter initials from a display name, e.g. "Ada Lovelace" -> "AL". */
export function userInitials(name: string) {
	return initialsFrom(name)
}
