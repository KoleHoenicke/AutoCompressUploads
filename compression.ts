/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 kolehoenicke
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { applyPalette, GIFEncoder, quantize } from "gifenc";

import {
    ADTS,
    BlobSource,
    BufferTarget,
    Conversion,
    FLAC,
    Input,
    MATROSKA,
    MP3,
    MP4,
    Mp4OutputFormat,
    MPEG_TS,
    OGG,
    OggOutputFormat,
    Output,
    QTFF,
    Quality,
    StreamTarget,
    WAVE,
    WEBM,
    WebMOutputFormat,
} from "./vendor/mediabunny.min.mjs";

const IMAGE_EXTENSIONS = new Set(["avif", "jpeg", "jpg", "png", "webp"]);
const AUDIO_EXTENSIONS = new Set(["aac", "flac", "m4a", "mp3", "oga", "ogg", "opus", "wav", "wave"]);
const VIDEO_EXTENSIONS = new Set(["m2ts", "m4v", "mkv", "mov", "mp4", "mts", "ts", "webm"]);

const AUDIO_INPUT_FORMATS = [MP4, QTFF, MATROSKA, WEBM, MP3, WAVE, OGG, ADTS, FLAC];
const VIDEO_INPUT_FORMATS = [MP4, QTFF, MATROSKA, WEBM, MPEG_TS];

interface AudioEncodingProfile {
    codec: "aac" | "opus";
    createFormat(): Mp4OutputFormat | OggOutputFormat;
    extension: "m4a" | "ogg";
    label: string;
    mimeType: "audio/mp4" | "audio/ogg";
}

interface VideoEncodingProfile {
    audioCodec: "aac" | "opus";
    createFormat(): Mp4OutputFormat | WebMOutputFormat;
    extension: "mp4" | "webm";
    label: string;
    mimeType: "video/mp4" | "video/webm";
    videoCodec: "avc" | "vp8" | "vp9";
}

const AAC_AUDIO_PROFILE: AudioEncodingProfile = {
    codec: "aac",
    createFormat: () => new Mp4OutputFormat(),
    extension: "m4a",
    label: "AAC/M4A",
    mimeType: "audio/mp4",
};
const OPUS_AUDIO_PROFILE: AudioEncodingProfile = {
    codec: "opus",
    createFormat: () => new OggOutputFormat(),
    extension: "ogg",
    label: "Opus/Ogg",
    mimeType: "audio/ogg",
};
const MP4_VIDEO_PROFILE: VideoEncodingProfile = {
    audioCodec: "aac",
    createFormat: () => new Mp4OutputFormat(),
    extension: "mp4",
    label: "H.264/AAC MP4",
    mimeType: "video/mp4",
    videoCodec: "avc",
};
const VP9_VIDEO_PROFILE: VideoEncodingProfile = {
    audioCodec: "opus",
    createFormat: () => new WebMOutputFormat(),
    extension: "webm",
    label: "VP9/Opus WebM",
    mimeType: "video/webm",
    videoCodec: "vp9",
};
const VP8_VIDEO_PROFILE: VideoEncodingProfile = {
    audioCodec: "opus",
    createFormat: () => new WebMOutputFormat(),
    extension: "webm",
    label: "VP8/Opus WebM",
    mimeType: "video/webm",
    videoCodec: "vp8",
};

function prefersOpenCodecs(): boolean {
    return /\bLinux\b/i.test(navigator.userAgent) && !/\bAndroid\b/i.test(navigator.userAgent);
}

function getAudioEncodingProfiles(): AudioEncodingProfile[] {
    return prefersOpenCodecs()
        ? [OPUS_AUDIO_PROFILE, AAC_AUDIO_PROFILE]
        : [AAC_AUDIO_PROFILE, OPUS_AUDIO_PROFILE];
}

function getVideoEncodingProfiles(): VideoEncodingProfile[] {
    return prefersOpenCodecs()
        ? [VP9_VIDEO_PROFILE, VP8_VIDEO_PROFILE, MP4_VIDEO_PROFILE]
        : [MP4_VIDEO_PROFILE, VP9_VIDEO_PROFILE, VP8_VIDEO_PROFILE];
}

type ProgressCallback = (progress: number) => void;

export interface CompressionOptions {
    maximumVideoHeight: number;
    minimumVideoBitrate: number;
    targetBytes: number;
}

export const TEMP_OUTPUT_CLEANUP = Symbol("AutoCompressUploadsTemporaryOutputCleanup");

export interface CompressedFile extends File {
    [TEMP_OUTPUT_CLEANUP]?: () => Promise<void>;
}

export const enum CompressionErrorCode {
    Cancelled = "cancelled",
    CodecUnsupported = "codec_unsupported",
    Compatibility = "discord_compatibility",
    ImageTooLarge = "image_too_large",
    MediaTooLong = "media_too_long",
    OutputTooLarge = "output_too_large",
    StorageUnavailable = "storage_unavailable",
    VideoTooLong = "video_too_long",
}

export class CompressionError extends Error {
    constructor(public readonly code: CompressionErrorCode, message: string) {
        super(message);
        this.name = "CompressionError";
    }
}

export function getExtension(file: File): string {
    const dot = file.name.lastIndexOf(".");
    return dot === -1 ? "" : file.name.slice(dot + 1).toLowerCase();
}

export function isCompressibleImage(file: File): boolean {
    return file.type.startsWith("image/") && IMAGE_EXTENSIONS.has(getExtension(file));
}

export function isCompressibleGif(file: File): boolean {
    return file.type === "image/gif" && getExtension(file) === "gif";
}

export function isCompressibleAudio(file: File): boolean {
    return file.type.startsWith("audio/") && AUDIO_EXTENSIONS.has(getExtension(file));
}

export function isCompressibleVideo(file: File): boolean {
    return file.type.startsWith("video/") && VIDEO_EXTENSIONS.has(getExtension(file));
}

function outputName(originalName: string, extension: string): string {
    const dot = originalName.lastIndexOf(".");
    const stem = dot === -1 ? originalName : originalName.slice(0, dot);
    return `${stem}.${extension}`;
}

function throwIfAborted(signal: AbortSignal) {
    if (signal.aborted) throw new CompressionError(CompressionErrorCode.Cancelled, "Compression was cancelled");
}

function canvasToBlob(canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob> {
    return new Promise((resolve, reject) => {
        canvas.toBlob(blob => {
            if (blob) resolve(blob);
            else reject(new Error(`The browser could not encode ${type}`));
        }, type, quality);
    });
}

async function isAnimatedImage(file: File): Promise<boolean> {
    if (typeof ImageDecoder === "undefined" || !await ImageDecoder.isTypeSupported(file.type)) return false;

    const decoder = new ImageDecoder({
        data: file.stream(),
        preferAnimation: true,
        type: file.type,
    });
    try {
        await decoder.tracks.ready;
        const track = decoder.tracks.selectedTrack;
        return Boolean(track?.animated && track.frameCount > 1);
    } finally {
        decoder.close();
    }
}

export async function compressImage(
    file: File,
    targetBytes: number,
    signal: AbortSignal,
    onProgress: ProgressCallback,
): Promise<File> {
    throwIfAborted(signal);
    if (await isAnimatedImage(file)) return compressGif(file, targetBytes, signal, onProgress);

    const bitmap = await createImageBitmap(file);
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d", { alpha: true });
    if (!context) {
        bitmap.close();
        throw new Error("Canvas rendering is unavailable");
    }

    let scale = 1;
    let quality = 0.92;
    let best: Blob | null = null;

    try {
        for (let attempt = 0; attempt < 14; attempt++) {
            throwIfAborted(signal);

            canvas.width = Math.max(2, Math.round(bitmap.width * scale));
            canvas.height = Math.max(2, Math.round(bitmap.height * scale));
            context.clearRect(0, 0, canvas.width, canvas.height);
            context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);

            const blob = await canvasToBlob(canvas, "image/webp", quality);
            if (!best || blob.size < best.size) best = blob;
            onProgress((attempt + 1) / 14);

            if (blob.size <= targetBytes) {
                return new File([blob], outputName(file.name, "webp"), {
                    lastModified: file.lastModified,
                    type: "image/webp",
                });
            }

            if (quality > 0.52) {
                quality -= 0.1;
            } else {
                quality = 0.78;
                const estimatedScale = Math.sqrt(targetBytes / blob.size) * 0.94;
                scale *= Math.min(0.86, Math.max(0.5, estimatedScale));
            }
        }
    } finally {
        bitmap.close();
        canvas.width = 1;
        canvas.height = 1;
    }

    if (best && best.size <= targetBytes) {
        return new File([best], outputName(file.name, "webp"), {
            lastModified: file.lastModified,
            type: "image/webp",
        });
    }

    throw new CompressionError(CompressionErrorCode.ImageTooLarge, "This image could not be reduced below the upload limit");
}

interface GifEncodingOptions {
    colors: number;
    frameStep: number;
    scale: number;
}

async function encodeGifAttempt(
    file: File,
    options: GifEncodingOptions,
    signal: AbortSignal,
    onProgress: ProgressCallback,
): Promise<Uint8Array<ArrayBuffer>> {
    if (typeof ImageDecoder === "undefined" || !await ImageDecoder.isTypeSupported(file.type)) {
        throw new CompressionError(CompressionErrorCode.CodecUnsupported, "Animated image decoding is unavailable");
    }

    const decoder = new ImageDecoder({
        data: file.stream(),
        preferAnimation: true,
        type: file.type,
    });

    try {
        await decoder.tracks.ready;
        const track = decoder.tracks.selectedTrack;
        if (!track || track.frameCount < 1) throw new Error("No GIF frames were found");

        const gif = GIFEncoder();
        const canvas = document.createElement("canvas");
        const context = canvas.getContext("2d", { alpha: true, willReadFrequently: true });
        if (!context) throw new Error("Canvas rendering is unavailable");
        let initialized = false;

        for (let frameIndex = 0; frameIndex < track.frameCount; frameIndex += options.frameStep) {
            throwIfAborted(signal);
            const { image } = await decoder.decode({ completeFramesOnly: true, frameIndex });
            try {
                if (!initialized) {
                    canvas.width = Math.max(1, Math.round(image.displayWidth * options.scale));
                    canvas.height = Math.max(1, Math.round(image.displayHeight * options.scale));
                    initialized = true;
                }

                context.clearRect(0, 0, canvas.width, canvas.height);
                context.drawImage(image, 0, 0, canvas.width, canvas.height);
                const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
                const palette = quantize(data, options.colors, {
                    clearAlpha: true,
                    format: "rgba4444",
                    oneBitAlpha: true,
                });
                const indexed = applyPalette(data, palette, "rgba4444");
                const transparentIndex = palette.findIndex(color => color[3] === 0);
                const framesRepresented = Math.min(options.frameStep, track.frameCount - frameIndex);
                const durationMs = Math.max(20, Math.round((image.duration ?? 100_000) / 1000 * framesRepresented));
                const repeat = frameIndex === 0
                    ? track.repetitionCount === Infinity ? 0 : track.repetitionCount === 0 ? -1 : track.repetitionCount
                    : undefined;

                gif.writeFrame(indexed, canvas.width, canvas.height, {
                    delay: durationMs,
                    palette,
                    repeat,
                    transparent: transparentIndex !== -1,
                    transparentIndex: Math.max(0, transparentIndex),
                });
            } finally {
                image.close();
            }

            onProgress(Math.min(0.98, (frameIndex + options.frameStep) / track.frameCount));
        }

        gif.finish();
        canvas.width = 1;
        canvas.height = 1;
        return gif.bytesView() as Uint8Array<ArrayBuffer>;
    } finally {
        decoder.close();
    }
}

export async function compressGif(
    file: File,
    targetBytes: number,
    signal: AbortSignal,
    onProgress: ProgressCallback,
): Promise<File> {
    let options: GifEncodingOptions = {
        colors: 256,
        frameStep: 1,
        scale: Math.min(1, Math.max(0.2, Math.sqrt(targetBytes / file.size) * 1.05)),
    };

    for (let attempt = 0; attempt < 6; attempt++) {
        const bytes = await encodeGifAttempt(
            file,
            options,
            signal,
            progress => onProgress((attempt + progress) / 6),
        );
        if (bytes.byteLength <= targetBytes) {
            onProgress(1);
            return new File([bytes], outputName(file.name, "gif"), {
                lastModified: file.lastModified,
                type: "image/gif",
            });
        }

        const correction = targetBytes / bytes.byteLength;
        if (options.colors > 64 && correction > 0.65) {
            options = { ...options, colors: options.colors === 256 ? 128 : 64 };
            continue;
        }

        let scale = options.scale * Math.min(0.88, Math.max(0.5, Math.sqrt(correction) * 0.93));
        let { frameStep } = options;
        if (scale < 0.18 && frameStep < 4) {
            frameStep *= 2;
            scale = Math.min(0.28, scale * 1.35);
        }
        options = { ...options, frameStep, scale: Math.max(0.08, scale) };
    }

    throw new CompressionError(CompressionErrorCode.ImageTooLarge, "This animated GIF could not be reduced below the upload limit");
}

const TEMP_DIRECTORY_NAME = "auto-compress-uploads";

interface MediaOutputTarget {
    cleanup?: () => Promise<void>;
    finish(originalFile: File): Promise<CompressedFile>;
    target: BufferTarget | StreamTarget;
}

function supportsOriginPrivateFileSystem(): boolean {
    return typeof navigator.storage?.getDirectory === "function";
}

async function createMediaOutputTarget(
    targetBytes: number,
    extension: string,
    mimeType: string,
): Promise<MediaOutputTarget> {
    if (!supportsOriginPrivateFileSystem()) {
        if (targetBytes > 96 * 1024 * 1024) {
            throw new CompressionError(
                CompressionErrorCode.StorageUnavailable,
                "Disk-backed temporary storage is unavailable, so files above 96 MB cannot be compressed safely",
            );
        }

        const target = new BufferTarget();
        return {
            target,
            async finish(originalFile) {
                if (!target.buffer) throw new Error("The video encoder returned no output");
                return new File([target.buffer], outputName(originalFile.name, extension), {
                    lastModified: originalFile.lastModified,
                    type: mimeType,
                });
            },
        };
    }

    const root = await navigator.storage.getDirectory();
    const directory = await root.getDirectoryHandle(TEMP_DIRECTORY_NAME, { create: true });
    const entryName = `${Date.now()}-${crypto.randomUUID()}.${extension}`;
    const handle = await directory.getFileHandle(entryName, { create: true });
    const writable = await handle.createWritable();
    const target = new StreamTarget(writable, { chunked: true, chunkSize: 4 * 1024 * 1024 });
    let cleaned = false;
    let cleanupTask: Promise<void> | null = null;
    const cleanup = async () => {
        if (cleaned) return;
        if (cleanupTask) return cleanupTask;

        cleanupTask = (async () => {
            for (let attempt = 0; attempt < 5; attempt++) {
                try {
                    await directory.removeEntry(entryName);
                    cleaned = true;
                    return;
                } catch (error) {
                    if (error instanceof DOMException && error.name === "NotFoundError") {
                        cleaned = true;
                        return;
                    }
                    if (attempt < 4) await new Promise(resolve => setTimeout(resolve, 50));
                }
            }
        })().finally(() => {
            cleanupTask = null;
        });
        return cleanupTask;
    };

    return {
        cleanup,
        target,
        async finish(originalFile) {
            const storedFile = await handle.getFile();
            const file = new File([storedFile], outputName(originalFile.name, extension), {
                lastModified: originalFile.lastModified,
                type: mimeType,
            }) as CompressedFile;
            file[TEMP_OUTPUT_CLEANUP] = cleanup;
            return file;
        },
    };
}

export async function cleanupStaleTemporaryOutputs(): Promise<void> {
    if (!supportsOriginPrivateFileSystem()) return;

    try {
        const root = await navigator.storage.getDirectory();
        const directory = await root.getDirectoryHandle(TEMP_DIRECTORY_NAME);
        for await (const name of directory.keys()) {
            await directory.removeEntry(name).catch(() => { });
        }
        await root.removeEntry(TEMP_DIRECTORY_NAME).catch(() => { });
    } catch {
        // The directory does not exist yet or storage is temporarily unavailable.
    }
}

const RELIABLE_AUDIO_BITRATES = [192_000, 128_000, 96_000, 64_000, 48_000, 24_000];

async function renderAudioAttempt(
    file: File,
    targetBytes: number,
    audioBitrate: number,
    sourceAudioChannels: number,
    profile: AudioEncodingProfile,
    signal: AbortSignal,
    onProgress: ProgressCallback,
): Promise<CompressedFile> {
    const input = new Input({
        formats: AUDIO_INPUT_FORMATS,
        source: new BlobSource(file),
    });

    try {
        const audioTrack = await input.getPrimaryAudioTrack();
        if (!audioTrack) throw new Error("No audio track was found");

        const outputTarget = await createMediaOutputTarget(targetBytes, profile.extension, profile.mimeType).catch(error => {
            if (error instanceof CompressionError) throw error;
            throw new CompressionError(
                CompressionErrorCode.StorageUnavailable,
                `Temporary storage is unavailable (${error instanceof Error ? error.message : String(error)})`,
            );
        });

        try {
            const output = new Output({
                format: profile.createFormat(),
                target: outputTarget.target,
            });
            const conversion = await Conversion.init({
                audio: {
                    codec: profile.codec,
                    forceTranscode: true,
                    numberOfChannels: Math.min(sourceAudioChannels, audioBitrate >= 64_000 ? 2 : 1),
                    quality: new Quality({ bitrate: audioBitrate, bitrateMode: "variable" }),
                    sampleRate: 48_000,
                },
                input,
                output,
                showWarnings: false,
                tracks: "primary",
                video: { discard: true },
            });

            if (!conversion.isValid) {
                const reason = conversion.discardedTracks.map(track => track.reason).join(", ");
                throw new CompressionError(
                    CompressionErrorCode.CodecUnsupported,
                    `This system cannot encode ${profile.label} audio (${reason || "unsupported codec"})`,
                );
            }

            const cancel = () => void conversion.cancel();
            signal.addEventListener("abort", cancel, { once: true });
            conversion.onProgress = progress => onProgress(Math.min(0.98, progress));
            try {
                throwIfAborted(signal);
                await conversion.execute();
            } finally {
                signal.removeEventListener("abort", cancel);
            }

            throwIfAborted(signal);
            return await outputTarget.finish(file);
        } catch (error) {
            await outputTarget.cleanup?.();
            if (signal.aborted) {
                throw new CompressionError(CompressionErrorCode.Cancelled, "Compression was cancelled");
            }
            throw error;
        }
    } finally {
        input.dispose();
    }
}

async function renderAudioWithCodecFallback(
    file: File,
    targetBytes: number,
    audioBitrate: number,
    sourceAudioChannels: number,
    signal: AbortSignal,
    onProgress: ProgressCallback,
): Promise<CompressedFile> {
    let highestProgress = 0;
    let lastError: unknown;
    const reportProgress = (progress: number) => {
        highestProgress = Math.max(highestProgress, progress);
        onProgress(highestProgress);
    };

    for (const profile of getAudioEncodingProfiles()) {
        try {
            return await renderAudioAttempt(
                file,
                targetBytes,
                audioBitrate,
                sourceAudioChannels,
                profile,
                signal,
                reportProgress,
            );
        } catch (error) {
            if (!isRetryableMediaError(error) || signal.aborted) throw error;
            lastError = error;
        }
    }

    throw new CompressionError(
        CompressionErrorCode.CodecUnsupported,
        `This system cannot encode AAC or Opus audio (${lastError instanceof Error ? lastError.message : "unsupported codecs"})`,
    );
}

export async function compressAudio(
    file: File,
    targetBytes: number,
    signal: AbortSignal,
    onProgress: ProgressCallback,
): Promise<File> {
    const probe = new Input({
        formats: AUDIO_INPUT_FORMATS,
        source: new BlobSource(file),
    });

    let duration: number;
    let sourceAudioChannels: number;
    try {
        duration = await probe.getDurationFromMetadata() ?? await probe.computeDuration();
        const audioTrack = await probe.getPrimaryAudioTrack();
        if (!audioTrack) throw new Error("No audio track was found");
        sourceAudioChannels = await audioTrack.getNumberOfChannels();
    } finally {
        probe.dispose();
    }

    if (!Number.isFinite(duration) || duration <= 0) throw new Error("The audio duration could not be determined");

    const availableBitrate = Math.floor(targetBytes * 8 * 0.9 / duration);
    const initialIndex = RELIABLE_AUDIO_BITRATES.findIndex(bitrate => bitrate <= availableBitrate);
    if (initialIndex === -1) {
        throw new CompressionError(
            CompressionErrorCode.MediaTooLong,
            "This audio is too long to fit above the minimum reliable bitrate",
        );
    }

    let lastSize = 0;
    const finalIndex = Math.min(RELIABLE_AUDIO_BITRATES.length, initialIndex + 3);
    for (let bitrateIndex = initialIndex; bitrateIndex < finalIndex; bitrateIndex++) {
        throwIfAborted(signal);
        const attempt = bitrateIndex - initialIndex;
        const audioBitrate = RELIABLE_AUDIO_BITRATES[bitrateIndex];
        const output = await renderAudioWithCodecFallback(
            file,
            targetBytes,
            audioBitrate,
            sourceAudioChannels,
            signal,
            progress => onProgress((attempt + progress) / 3),
        );
        lastSize = output.size;
        if (lastSize <= targetBytes) {
            onProgress(1);
            return output;
        }
        await output[TEMP_OUTPUT_CLEANUP]?.();
    }

    throw new CompressionError(
        CompressionErrorCode.OutputTooLarge,
        `The encoded audio remained too large (${(lastSize / 1_048_576).toFixed(1)} MB)`,
    );
}

function even(value: number): number {
    return Math.max(2, Math.floor(value / 2) * 2);
}

function chooseVideoDimensions(width: number, height: number, maximumHeight: number, bitrate: number) {
    let bitrateHeight = maximumHeight;
    if (bitrate < 120_000) bitrateHeight = Math.min(bitrateHeight, 240);
    else if (bitrate < 300_000) bitrateHeight = Math.min(bitrateHeight, 360);
    else if (bitrate < 850_000) bitrateHeight = Math.min(bitrateHeight, 480);
    else if (bitrate < 1_600_000) bitrateHeight = Math.min(bitrateHeight, 720);

    const scale = Math.min(1, bitrateHeight / height);
    return {
        height: even(height * scale),
        width: even(width * scale),
    };
}

function chooseFrameRate(videoBitrate: number): number {
    if (videoBitrate < 240_000) return 15;
    if (videoBitrate < 450_000) return 20;
    if (videoBitrate < 700_000) return 24;
    return 30;
}

interface EncodingBudget {
    audioBitrate: number;
    audioChannels: number;
    audioSampleRate: number;
    videoBitrate: number;
}

function chooseEncodingBudget(
    totalBitrate: number,
    hasAudio: boolean,
    sourceAudioChannels: number,
    minimumVideoBitrate: number,
): EncodingBudget {
    if (!hasAudio) {
        return {
            audioBitrate: 0,
            audioChannels: 0,
            audioSampleRate: 0,
            videoBitrate: totalBitrate,
        };
    }

    let desiredAudioBitrate: number;
    if (totalBitrate >= 700_000) desiredAudioBitrate = 96_000;
    else if (totalBitrate >= 350_000) desiredAudioBitrate = 64_000;
    else if (totalBitrate >= 200_000) desiredAudioBitrate = 48_000;
    else if (totalBitrate >= 120_000) desiredAudioBitrate = 48_000;
    else desiredAudioBitrate = 24_000;

    // Preserve enough room for the video before spending bits on audio. Stick
    // to AAC configurations Chromium encodes reliably; arbitrary values between
    // these tiers can pass capability checks and still fail midway through.
    const availableAudioBitrate = Math.min(desiredAudioBitrate, totalBitrate - minimumVideoBitrate);
    const audioBitrate = [96_000, 64_000, 48_000, 24_000]
        .find(bitrate => bitrate <= availableAudioBitrate) ?? 24_000;
    const videoBitrate = totalBitrate - audioBitrate;

    return {
        audioBitrate,
        audioChannels: Math.min(sourceAudioChannels, audioBitrate >= 64_000 ? 2 : 1),
        // Chromium's AAC encoder reports some lower sample rates as supported
        // and then fails mid-encode. Keeping 48 kHz is reliable; mono plus the
        // bitrate reduction still saves nearly all of the intended space.
        audioSampleRate: 48_000,
        videoBitrate,
    };
}

async function renderVideoAttempt(
    file: File,
    targetBytes: number,
    videoBitrate: number,
    audioBitrate: number,
    audioChannels: number,
    audioSampleRate: number,
    maximumVideoHeight: number,
    hardwareAcceleration: "no-preference" | "prefer-software",
    profile: VideoEncodingProfile,
    signal: AbortSignal,
    onProgress: ProgressCallback,
): Promise<CompressedFile> {
    const input = new Input({
        formats: VIDEO_INPUT_FORMATS,
        source: new BlobSource(file),
    });

    try {
        const videoTrack = await input.getPrimaryVideoTrack();
        if (!videoTrack) throw new Error("No video track was found");

        const [width, height] = await Promise.all([
            videoTrack.getDisplayWidth(),
            videoTrack.getDisplayHeight(),
        ]);
        const dimensions = chooseVideoDimensions(width, height, maximumVideoHeight, videoBitrate);

        const outputTarget = await createMediaOutputTarget(targetBytes, profile.extension, profile.mimeType).catch(error => {
            if (error instanceof CompressionError) throw error;
            throw new CompressionError(
                CompressionErrorCode.StorageUnavailable,
                `Temporary storage is unavailable (${error instanceof Error ? error.message : String(error)})`,
            );
        });
        try {
            const output = new Output({
                format: profile.createFormat(),
                target: outputTarget.target,
            });
            const audio = audioBitrate > 0 ? {
                codec: profile.audioCodec,
                forceTranscode: true,
                numberOfChannels: audioChannels,
                quality: new Quality({ bitrate: audioBitrate, bitrateMode: "variable" }),
                sampleRate: audioSampleRate,
            } : undefined;
            const conversion = await Conversion.init({
                audio,
                input,
                output,
                showWarnings: false,
                tracks: "primary",
                video: {
                    codec: profile.videoCodec,
                    fit: "contain",
                    forceTranscode: true,
                    frameRate: chooseFrameRate(videoBitrate),
                    hardwareAcceleration,
                    height: dimensions.height,
                    keyFrameInterval: 4,
                    quality: new Quality({ bitrate: videoBitrate, bitrateMode: "variable" }),
                    width: dimensions.width,
                },
            });

            if (!conversion.isValid) {
                const reason = conversion.discardedTracks.map(track => track.reason).join(", ");
                throw new CompressionError(
                    CompressionErrorCode.CodecUnsupported,
                    `This system cannot encode ${profile.label} video (${reason || "unsupported codec"})`,
                );
            }

            const cancel = () => void conversion.cancel();
            signal.addEventListener("abort", cancel, { once: true });
            conversion.onProgress = progress => onProgress(Math.min(0.98, progress));

            try {
                throwIfAborted(signal);
                await conversion.execute();
            } finally {
                signal.removeEventListener("abort", cancel);
            }

            throwIfAborted(signal);
            return await outputTarget.finish(file);
        } catch (error) {
            await outputTarget.cleanup?.();
            if (signal.aborted) {
                throw new CompressionError(CompressionErrorCode.Cancelled, "Compression was cancelled");
            }
            throw error;
        }
    } finally {
        input.dispose();
    }
}

function isRetryableMediaError(error: unknown): boolean {
    if (error instanceof CompressionError) return error.code === CompressionErrorCode.CodecUnsupported;
    if (error instanceof DOMException) {
        return ["EncodingError", "NotSupportedError", "OperationError"].includes(error.name);
    }
    return error instanceof Error && /\b(codec|decod|encod)\w*\b/i.test(`${error.name} ${error.message}`);
}

async function renderVideoWithHardwareFallback(
    file: File,
    targetBytes: number,
    budget: EncodingBudget,
    maximumVideoHeight: number,
    profile: VideoEncodingProfile,
    signal: AbortSignal,
    onProgress: ProgressCallback,
): Promise<CompressedFile> {
    let highestProgress = 0;
    const reportProgress = (progress: number) => {
        highestProgress = Math.max(highestProgress, progress);
        onProgress(highestProgress);
    };

    try {
        return await renderVideoAttempt(
            file,
            targetBytes,
            budget.videoBitrate,
            budget.audioBitrate,
            budget.audioChannels,
            budget.audioSampleRate,
            maximumVideoHeight,
            "no-preference",
            profile,
            signal,
            reportProgress,
        );
    } catch (error) {
        if (!isRetryableMediaError(error) || signal.aborted) throw error;
    }

    return renderVideoAttempt(
        file,
        targetBytes,
        budget.videoBitrate,
        budget.audioBitrate,
        budget.audioChannels,
        budget.audioSampleRate,
        maximumVideoHeight,
        "prefer-software",
        profile,
        signal,
        reportProgress,
    );
}

async function renderVideoWithCodecFallback(
    file: File,
    targetBytes: number,
    budget: EncodingBudget,
    maximumVideoHeight: number,
    signal: AbortSignal,
    onProgress: ProgressCallback,
): Promise<CompressedFile> {
    let highestProgress = 0;
    let lastError: unknown;
    const reportProgress = (progress: number) => {
        highestProgress = Math.max(highestProgress, progress);
        onProgress(highestProgress);
    };

    for (const profile of getVideoEncodingProfiles()) {
        try {
            return await renderVideoWithHardwareFallback(
                file,
                targetBytes,
                budget,
                maximumVideoHeight,
                profile,
                signal,
                reportProgress,
            );
        } catch (error) {
            if (!isRetryableMediaError(error) || signal.aborted) throw error;
            lastError = error;
        }
    }

    throw new CompressionError(
        CompressionErrorCode.CodecUnsupported,
        `This system cannot encode H.264/AAC or VP9/Opus video (${lastError instanceof Error ? lastError.message : "unsupported codecs"})`,
    );
}

export async function compressVideo(
    file: File,
    options: CompressionOptions,
    signal: AbortSignal,
    onProgress: ProgressCallback,
): Promise<File> {
    const probe = new Input({
        formats: VIDEO_INPUT_FORMATS,
        source: new BlobSource(file),
    });

    let duration: number;
    let hasAudio: boolean;
    let sourceAudioChannels = 1;
    try {
        duration = await probe.getDurationFromMetadata() ?? await probe.computeDuration();
        const audioTrack = await probe.getPrimaryAudioTrack();
        hasAudio = Boolean(audioTrack);
        if (audioTrack) sourceAudioChannels = await audioTrack.getNumberOfChannels();
    } finally {
        probe.dispose();
    }

    if (!Number.isFinite(duration) || duration <= 0) throw new Error("The video duration could not be determined");

    let totalBitrate = Math.floor(options.targetBytes * 8 * 0.9 / duration);
    let budget = chooseEncodingBudget(totalBitrate, hasAudio, sourceAudioChannels, options.minimumVideoBitrate);
    if (budget.videoBitrate < options.minimumVideoBitrate) {
        throw new CompressionError(
            CompressionErrorCode.VideoTooLong,
            "This video is too long to fit even at the emergency quality floor",
        );
    }

    let lastSize = 0;
    for (let attempt = 0; attempt < 3; attempt++) {
        throwIfAborted(signal);
        const attemptOffset = attempt / 3;
        const output = await renderVideoWithCodecFallback(
            file,
            options.targetBytes,
            budget,
            options.maximumVideoHeight,
            signal,
            progress => onProgress(attemptOffset + progress / 3),
        );
        lastSize = output.size;

        if (lastSize <= options.targetBytes) {
            onProgress(1);
            return output;
        }

        await output[TEMP_OUTPUT_CLEANUP]?.();

        const correction = options.targetBytes / lastSize;
        totalBitrate = Math.floor(totalBitrate * Math.min(0.9, correction * 0.92));
        budget = chooseEncodingBudget(totalBitrate, hasAudio, sourceAudioChannels, options.minimumVideoBitrate);
        if (budget.videoBitrate < options.minimumVideoBitrate) break;
    }

    throw new CompressionError(
        CompressionErrorCode.OutputTooLarge,
        `The encoded video remained too large (${(lastSize / 1_048_576).toFixed(1)} MB)`,
    );
}
