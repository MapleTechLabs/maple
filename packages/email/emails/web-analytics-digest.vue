<script setup lang="ts">
/**
 * Weekly web analytics email — the page skeleton. Same token/slot contract as
 * weekly-digest.vue: `[[token]]` is an escaped value, `[[#slot]]` a hole filled
 * with compiled fragments (see scripts/build.ts).
 */
</script>

<template>
<MapleShell>
<MapleHeader title="[[orgName]]" subtitle="">
<template #subtitle>Web analytics &middot; [[dateStart]] &ndash; [[dateEnd]]</template>
</MapleHeader>
<MapleDivider />
[[#highlightBanner]]
<MapleSection class="px-5 pt-4">
<table class="w-full border-collapse"><tbody>
<tr>[[#summaryRowOne]]</tr>
<tr>[[#summaryRowTwo]]</tr>
</tbody></table>
</MapleSection>
[[#pagesSection]]
[[#sourcesSection]]
[[#aiSection]]
<MapleSection class="px-6 pb-2 pt-6">
<MapleCta href="[[analyticsUrl]]">Open web analytics &rarr;</MapleCta>
</MapleSection>
<MapleFooter>Powered by <a href="[[baseUrl]]" target="_blank" class="text-maple-fg-muted no-underline">Maple</a> &middot; You get this because your team uses Maple web analytics. <a href="[[unsubscribeUrl]]" target="_blank" class="text-maple-fg-muted underline">Unsubscribe</a></MapleFooter>
</MapleShell>
</template>
