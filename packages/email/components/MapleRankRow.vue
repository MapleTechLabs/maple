<script setup lang="ts">
/** One ranked row: optional icon and the name over a share bar, the count, and
    a tinted trailing figure. */
defineProps({
	rowBorder: { type: String, default: "[[rowBorder]]" },
	label: { type: String, default: "[[label]]" },
	barWidth: { type: String, default: "[[barWidth]]" },
	value: { type: String, default: "[[value]]" },
	aside: { type: String, default: "[[aside]]" },
	asideColor: { type: String, default: "[[asideColor]]" },
})
</script>

<template><tr>
<td class="px-3 py-2 align-middle" :style="`border-bottom:${rowBorder}`"><table><tbody><tr>[[#rowIcon]]<td class="align-middle"><p class="m-0 font-mono text-[12px] leading-[20px] text-maple-fg">{{ label }}</p></td></tr></tbody></table><div style="margin-top:4px;height:3px;border-radius:2px;background-color:#302b26"><div :style="`width:${barWidth}%;height:3px;border-radius:2px;background-color:#e8872a`"></div></div></td>
<td class="px-3 py-2 text-right align-middle" :style="`border-bottom:${rowBorder}`"><p class="m-0 font-mono text-[12px] font-semibold leading-[20px] text-maple-fg">{{ value }}</p></td>
<td class="px-3 py-2 text-right align-middle" :style="`border-bottom:${rowBorder}`"><p class="m-0 font-mono text-[11px] leading-[20px]" :style="`color:${asideColor}`">{{ aside }}</p></td>
</tr></template>
