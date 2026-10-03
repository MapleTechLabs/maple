<script setup lang="ts">
/** A name and a count on one line, for the lists inside the AI columns. */
defineProps({
	icon: { type: String, default: "[[icon]]" },
	label: { type: String, default: "[[label]]" },
	value: { type: String, default: "[[value]]" },
})
</script>

<template><tr>
<td class="w-[14px] py-1 pr-2 align-middle" style="border-top:1px solid #302b26"><img :src="icon" width="14" height="14" alt="" style="display:block;border:0;width:14px;height:14px"></td>
<td class="py-1 align-middle" style="border-top:1px solid #302b26"><p class="m-0 font-mono text-[11px] leading-[18px] text-maple-fg">{{ label }}</p></td>
<td class="py-1 text-right align-middle" style="border-top:1px solid #302b26"><p class="m-0 font-mono text-[11px] font-semibold leading-[18px] text-maple-fg">{{ value }}</p></td>
</tr></template>
