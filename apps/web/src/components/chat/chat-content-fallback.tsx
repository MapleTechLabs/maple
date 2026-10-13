import { Skeleton } from "@maple/ui/components/ui/skeleton"

/** Suspense fallback for the global chat's lazily loaded panel and conversation. */
export function ChatContentFallback({ label }: { label: string }) {
	return (
		<div className="flex flex-1 flex-col gap-3 p-4" aria-label={label}>
			<Skeleton className="h-16 w-3/4" />
			<Skeleton className="h-20 w-4/5 self-end" />
			<Skeleton className="mt-auto h-20" />
		</div>
	)
}
