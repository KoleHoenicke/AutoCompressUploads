/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 kolehoenicke
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { findByCodeLazy } from "@webpack";

const MEBIBYTE = 1024 * 1024;
const FALLBACK_LIMIT = 20 * MEBIBYTE;

const getUserMaxFileSize = findByCodeLazy("getUserMaxFileSize", "getGuildMaxFileSize") as (guildId: string | null) => number;

export function getUploadLimitBytes(guildId: string | null): number {
    try {
        const value = getUserMaxFileSize(guildId);
        // Some Discord clients still expose the former 10 MiB free limit from
        // this helper even though the uploader now accepts 20 MiB. Clamp that
        // stale value to the current free floor while preserving larger Nitro
        // and guild limits returned by Discord.
        return Number.isFinite(value) && value > 0 ? Math.max(value, FALLBACK_LIMIT) : FALLBACK_LIMIT;
    } catch {
        return FALLBACK_LIMIT;
    }
}
