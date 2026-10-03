import { Avatar, AvatarFallback, AvatarImage } from "@maple/ui/components/ui/avatar"
import { cn } from "@maple/ui/lib/utils"

/** A GitHub login's avatar, from GitHub's public `<login>.png` redirect; the initial while it loads. */
export function AuthorAvatar({ login, className }: { login: string; className?: string }) {
	return (
		<Avatar className={cn("size-[18px] text-[9px]", className)}>
			<AvatarImage src={`https://github.com/${encodeURIComponent(login)}.png?size=64`} alt="" />
			<AvatarFallback>{login.slice(0, 1).toUpperCase()}</AvatarFallback>
		</Avatar>
	)
}

/** Avatar and login on one line, the way an author is shown everywhere in Code Review. */
export function AuthorLabel({ login, className }: { login: string; className?: string }) {
	return (
		<span className={cn("inline-flex min-w-0 items-center gap-1.5", className)}>
			<AuthorAvatar login={login} />
			<span className="truncate">{login}</span>
		</span>
	)
}
