import { EmptyMessage } from "@maple/ui/components/ui/empty"

/** A detail page whose resource sent nothing in the selected window. */
export function NoMetricsMessage({ noun }: { noun: string }) {
	return (
		<EmptyMessage dashed className="py-12">
			No metrics arrived for this {noun} in the selected window.
		</EmptyMessage>
	)
}
