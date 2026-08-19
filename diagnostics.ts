/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 kolehoenicke
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

export interface CompressionDiagnostics {
    channelLimitBytes: number;
    error?: {
        code: string;
        message: string;
        name: string;
    };
    file: {
        extension: string;
        inputBytes: number;
        mimeType: string;
    };
    output?: {
        bytes: number;
        extension: string;
        mimeType: string;
    };
    runtime: {
        hardwareConcurrency: number | null;
        opfsAvailable: boolean;
        platform: string;
        userAgent: string;
    };
    targetBytes: number;
    timestamp: string;
    version: string;
}

let lastDiagnostics: CompressionDiagnostics | null = null;

export function setLastDiagnostics(diagnostics: CompressionDiagnostics) {
    lastDiagnostics = diagnostics;
}

export function serializeLastDiagnostics(): string | null {
    return lastDiagnostics ? JSON.stringify(lastDiagnostics, null, 2) : null;
}
