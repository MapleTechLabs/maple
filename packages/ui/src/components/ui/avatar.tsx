"use client"

import { Avatar as AvatarPrimitive } from "@base-ui/react/avatar"
import type React from "react"
import { cn } from "../../lib/utils"
import { avatarFallbackStyles, avatarImageStyles, avatarStyles } from "./avatar.styles"

export function Avatar({ className, ...props }: AvatarPrimitive.Root.Props): React.ReactElement {
	return <AvatarPrimitive.Root className={cn(avatarStyles, className)} data-slot="avatar" {...props} />
}

export function AvatarImage({ className, ...props }: AvatarPrimitive.Image.Props): React.ReactElement {
	return (
		<AvatarPrimitive.Image
			className={cn(avatarImageStyles, className)}
			data-slot="avatar-image"
			{...props}
		/>
	)
}

export function AvatarFallback({ className, ...props }: AvatarPrimitive.Fallback.Props): React.ReactElement {
	return (
		<AvatarPrimitive.Fallback
			className={cn(avatarFallbackStyles, className)}
			data-slot="avatar-fallback"
			{...props}
		/>
	)
}

export { AvatarPrimitive }
