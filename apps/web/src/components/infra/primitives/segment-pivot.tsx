import { SegmentedSelect } from "@/components/common/segmented-select"

/**
 * A single-select segmented control over a small closed set: which metric a
 * chart shows, which workload kind a list is about. The compact infra size of
 * the shared `SegmentedSelect`.
 */
export function SegmentPivot<V extends string>({
	options,
	value,
	onChange,
	ariaLabel,
	className,
}: {
	options: ReadonlyArray<{ value: V; label: string }>
	value: V
	onChange: (value: V) => void
	ariaLabel: string
	className?: string
}) {
	return (
		<SegmentedSelect
			size="xs"
			options={options}
			value={value}
			onChange={onChange}
			aria-label={ariaLabel}
			className={className}
		/>
	)
}
