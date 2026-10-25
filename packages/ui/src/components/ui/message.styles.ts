export const messageGroupStyles = "flex min-w-0 flex-col gap-1.5"

export const messageStyles =
	"group/message relative flex w-full min-w-0 gap-1.5 text-xs data-[align=end]:flex-row-reverse"

export const messageAvatarStyles =
	"flex w-fit min-w-8 shrink-0 items-center justify-center self-end overflow-hidden rounded-full bg-muted group-has-data-[slot=message-footer]/message:-translate-y-8"

export const messageContentStyles =
	"flex w-full min-w-0 flex-col gap-2 wrap-break-word group-data-[align=end]/message:*:data-slot:self-end"

export const messageHeaderStyles =
	"flex max-w-full min-w-0 items-center px-2.5 text-xs font-medium text-muted-foreground group-has-data-[variant=ghost]/message:px-0"

export const messageFooterStyles =
	"flex max-w-full min-w-0 items-center px-2.5 text-xs font-medium text-muted-foreground group-has-data-[variant=ghost]/message:px-0 group-data-[align=end]/message:justify-end"
