import { clsx, type ClassValue } from "clsx"
import { extendTailwindMerge } from "tailwind-merge"

// Custom font-size tokens (tokens.css); otherwise text-ui/text-title merge as colors.
const twMerge = extendTailwindMerge({ extend: { theme: { text: ["ui", "title"] } } })

export function cn(...inputs: ClassValue[]) {
	return twMerge(clsx(inputs))
}
