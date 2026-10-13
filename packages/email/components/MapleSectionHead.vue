<script setup lang="ts">
/** Section title with its icon, a one-line plain-English hint, and a link. */
defineProps({
	icon: { type: String, default: "[[icon]]" },
	title: { type: String, default: "[[title]]" },
	hint: { type: String, default: "[[hint]]" },
	href: { type: String, default: "[[href]]" },
	linkText: { type: String, default: "[[linkText]]" },
})
</script>

<template>
<table class="w-full"><tbody><tr>
<td class="w-[16px] pr-2 align-middle"><img :src="icon" width="16" height="16" alt="" style="display:block;border:0;width:16px;height:16px"></td>
<td class="align-middle"><p class="m-0 font-mono text-[13px] font-semibold leading-[20px] text-maple-fg">{{ title }}</p></td>
<td class="text-right align-middle"><a :href="href" target="_blank" class="font-mono text-[10px] uppercase tracking-widest text-maple-orange no-underline">{{ linkText }} &rarr;</a></td>
</tr></tbody></table>
<p class="m-0 mb-2.5 mt-0.5 font-mono text-[11px] leading-[16px] text-maple-fg-muted">{{ hint }}</p>
</template>
