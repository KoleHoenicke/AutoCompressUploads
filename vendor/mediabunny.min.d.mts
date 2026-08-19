/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

export const MP4: unknown;
export const QTFF: unknown;
export const MATROSKA: unknown;
export const WEBM: unknown;
export const MP3: unknown;
export const WAVE: unknown;
export const OGG: unknown;
export const ADTS: unknown;
export const FLAC: unknown;
export const MPEG_TS: unknown;

export class BlobSource {
    constructor(blob: Blob);
}

export class BufferTarget {
    buffer: ArrayBuffer | null;
}

export interface StreamTargetChunk {
    data: Uint8Array<ArrayBuffer>;
    position: number;
    type: "write";
}

export class StreamTarget {
    constructor(
        writable: WritableStream<StreamTargetChunk>,
        options?: { chunked?: boolean; chunkSize?: number; },
    );
}

export class Input {
    constructor(options: { formats: unknown[]; source: BlobSource; });
    computeDuration(): Promise<number>;
    dispose(): void;
    getDurationFromMetadata(): Promise<number | null>;
    getPrimaryAudioTrack(): Promise<{
        getNumberOfChannels(): Promise<number>;
    } | null>;
    getPrimaryVideoTrack(): Promise<{
        getDisplayHeight(): Promise<number>;
        getDisplayWidth(): Promise<number>;
    } | null>;
}

export class Mp4OutputFormat { }
export class OggOutputFormat { }
export class WebMOutputFormat { }

export class Output {
    constructor(options: {
        format: Mp4OutputFormat | OggOutputFormat | WebMOutputFormat;
        target: BufferTarget | StreamTarget;
    });
}

export class Quality {
    constructor(options: {
        bitrate: number;
        bitrateMode?: "constant" | "variable";
    });
}

export class Conversion {
    discardedTracks: Array<{ reason: string; }>;
    isValid: boolean;
    onProgress?: (progress: number, processedTime: number) => unknown;

    static init(options: Record<string, unknown>): Promise<Conversion>;
    cancel(): Promise<void>;
    execute(): Promise<void>;
}
