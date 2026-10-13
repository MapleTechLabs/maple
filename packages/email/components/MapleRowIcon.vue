<script setup lang="ts">
/** A 16px leading icon cell for a list row (favicon, brand mark). */
defineProps({ icon: { type: String, default: "[[icon]]" } })
</script>

<template><td class="w-[16px] pr-2 align-middle"><img :src="icon" width="16" height="16" alt="" style="display:block;border:0;width:16px;height:16px;border-radius:3px"></td></template>
