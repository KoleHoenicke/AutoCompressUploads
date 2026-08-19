/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 kolehoenicke
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./style.css";

import { Logger } from "@utils/Logger";
import definePlugin from "@utils/types";
import type { CloudUpload } from "@vencord/discord-types";
import { ChannelStore, showToast, Toasts } from "@webpack/common";

import { SegmentedUploadProgress } from "./attachmentUI";
import {
    cleanupStaleTemporaryOutputs,
    compressAudio,
    CompressedFile,
    compressGif,
    compressImage,
    CompressionError,
    CompressionErrorCode,
    CompressionOptions,
    compressVideo,
    getExtension,
    isCompressibleAudio,
    isCompressibleGif,
    isCompressibleImage,
    isCompressibleVideo,
    TEMP_OUTPUT_CLEANUP,
} from "./compression";
import { CompressionDiagnostics, setLastDiagnostics } from "./diagnostics";
import { getUploadLimitBytes } from "./limits";
import { settings } from "./settings";

const logger = new Logger("AutoCompressUploads");
const AUTO_COMPRESSED = Symbol("AutoCompressUploads");
const COMPRESSION_TASK = Symbol("AutoCompressUploadsTask");
const TEMP_FILE_CLEANUP = Symbol("AutoCompressUploadsFileCleanup");
const TEMP_FILE_CLEANUP_TIMER = Symbol("AutoCompressUploadsFileCleanupTimer");
const PLUGIN_VERSION = "1.0.0";
const SAFETY_HEADROOM = 0.04;
const MAXIMUM_VIDEO_HEIGHT = 1080;
const MINIMUM_VIDEO_BITRATE = 96_000;
let staleCleanupTask: Promise<void> | null = null;

interface UploadWithFile extends CloudUpload {
    [AUTO_COMPRESSED]?: boolean;
    [TEMP_FILE_CLEANUP]?: () => Promise<void>;
    [TEMP_FILE_CLEANUP_TIMER]?: ReturnType<typeof setInterval>;
    resetState?(): this;
    item: CloudUpload["item"] & {
        compressionMetadata?: {
            originalContentType: string;
            preCompressionSize: number;
        };
    };
}

interface DiscordUploader {
    [AUTO_COMPRESSED]?: boolean;
    [COMPRESSION_TASK]?: Promise<void>;
    _file: Record<string, any>;
    _handleProgress(loaded: number, total: number, progressByFile?: Record<string, number>): void;
    _recomputeProgressByFile(): Record<string, number>;
    _recomputeProgressTotal(): { loaded: number; total: number; };
    emit(event: string, ...args: any[]): void;
    files: UploadWithFile[];
}

function canCompress(file: File): boolean {
    return isCompressibleImage(file)
        || isCompressibleGif(file)
        || isCompressibleAudio(file)
        || isCompressibleVideo(file);
}

function getTargetBytes(limitBytes: number): number {
    return Math.floor(limitBytes * (1 - SAFETY_HEADROOM));
}

function compatibilityError(detail: string): CompressionError {
    return new CompressionError(
        CompressionErrorCode.Compatibility,
        `Discord's uploader changed and this version of AutoCompressUploads needs an update (${detail})`,
    );
}

function validateUploader(uploader: DiscordUploader) {
    if (!Array.isArray(uploader.files)) throw compatibilityError("missing upload list");
    if (typeof uploader._handleProgress !== "function") throw compatibilityError("missing progress handler");
    if (typeof uploader._recomputeProgressByFile !== "function") throw compatibilityError("missing per-file progress");
    if (typeof uploader._recomputeProgressTotal !== "function") throw compatibilityError("missing total progress");
    if (typeof uploader.emit !== "function") throw compatibilityError("missing event emitter");
}

function resetUpload(upload: UploadWithFile) {
    if (typeof upload.resetState !== "function") throw compatibilityError("missing upload reset");
    upload.resetState();
}

async function cleanupUploadTemporaryFile(upload: UploadWithFile) {
    clearInterval(upload[TEMP_FILE_CLEANUP_TIMER]);
    delete upload[TEMP_FILE_CLEANUP_TIMER];
    const cleanup = upload[TEMP_FILE_CLEANUP];
    delete upload[TEMP_FILE_CLEANUP];
    if (cleanup) await cleanup();
}

function watchTemporaryFile(upload: UploadWithFile) {
    if (!upload[TEMP_FILE_CLEANUP]) return;
    clearInterval(upload[TEMP_FILE_CLEANUP_TIMER]);
    upload[TEMP_FILE_CLEANUP_TIMER] = setInterval(() => {
        if (["COMPLETED", "CANCELLED", "REMOVED_FROM_MSG_DRAFT"].includes(upload.status)) {
            void cleanupUploadTemporaryFile(upload);
        }
    }, 5_000);
}

function attachmentWasRemoved(uploader: DiscordUploader, upload: UploadWithFile): boolean {
    return !uploader.files.includes(upload) || upload.status === "REMOVED_FROM_MSG_DRAFT";
}

function updateUploadFile(upload: UploadWithFile, file: File, originalFile: File) {
    // Discord starts preparing uploads while they are still in the draft. An
    // oversized original can therefore already be in ERROR state with a stale
    // signed URL by the time Send triggers our compression. CloudUpload's own
    // reset clears its status, error, URL, abort controller, and retry state.
    resetUpload(upload);

    upload.item.file = file;
    upload.item.compressionMetadata = {
        originalContentType: originalFile.type,
        preCompressionSize: originalFile.size,
    };
    upload.filename = file.name;
    upload.mimeType = file.type;
    upload.currentSize = file.size;
    upload.postCompressionSize = file.size;
    upload.preCompressionSize = originalFile.size;
    upload.isImage = file.type.startsWith("image/");
    upload.isVideo = file.type.startsWith("video/");
    upload.loaded = 0;
    upload[AUTO_COMPRESSED] = true;
    upload[TEMP_FILE_CLEANUP] = (file as CompressedFile)[TEMP_OUTPUT_CLEANUP];
    watchTemporaryFile(upload);
}

function createDiagnostics(file: File, limit: number, target: number): CompressionDiagnostics {
    return {
        channelLimitBytes: limit,
        file: {
            extension: getExtension(file),
            inputBytes: file.size,
            mimeType: file.type,
        },
        runtime: {
            hardwareConcurrency: navigator.hardwareConcurrency || null,
            opfsAvailable: typeof navigator.storage?.getDirectory === "function",
            platform: navigator.platform,
            userAgent: navigator.userAgent,
        },
        targetBytes: target,
        timestamp: new Date().toISOString(),
        version: PLUGIN_VERSION,
    };
}

function describeError(error: unknown): string {
    if (error instanceof CompressionError) return error.message;
    if (error instanceof DOMException && error.name === "AbortError") return "Compression was cancelled";
    return error instanceof Error ? error.message : String(error);
}

export default definePlugin({
    name: "AutoCompressUploads",
    description: "Automatically compresses oversized media on-device",
    authors: [{ name: "kolehoenicke", id: 362365763299966987n }],
    settings,

    start() {
        staleCleanupTask = cleanupStaleTemporaryOutputs();
    },

    patches: [
        {
            // Let supported oversized media enter the normal attachment draft. Unsupported files still use Discord's error.
            find: "web.filesExceedUploadLimits",
            replacement: {
                match: /function (\i)\((\i),(\i)\)\{/,
                replace: "$&if($self.canPreprocessFiles($2,$3))return!1;",
            },
        },
        {
            // Insert local compression into Discord's uploader after Send is pressed and before its size validation.
            find: "async uploadFiles(",
            replacement: [
                {
                    match: /this\._handleStart\(\(\)=>(\i)\.abort\(\)\),(?=!await this\.compressAndCheckFileSize\(\))/,
                    replace: "$&await $self.compressUploads(this,$1.signal),",
                },
                {
                    // Continue from compression progress instead of resetting the native bar when network upload starts.
                    match: /_recomputeProgress\(\)\{let\{loaded:(\i),total:(\i)\}=this\._recomputeProgressTotal\(\),(\i)=this\._recomputeProgressByFile\(\);this\._handleProgress\(\1,\2,\3\)\}/,
                    replace: "_recomputeProgress(){$self.reportUploadProgress(this)}",
                },
            ],
        },
        {
            // Preserve Discord's native progress component, but show compression
            // and upload as two adjacent stages for files handled by this plugin.
            find: ".getMessageForFile(",
            replacement: {
                match: /\(0,(\i)\.jsx\)\((\i)\.(\i),\{value:(\i)\.progress,"aria-label":(\i)\}\)/,
                replace: "$self.SegmentedUploadProgress($4,$5,$2.$3)",
            },
        },
    ],

    SegmentedUploadProgress,

    canPreprocessFiles(files: Iterable<File>, guildId: string | null) {
        const limit = getUploadLimitBytes(guildId);
        const array = Array.from(files);
        return array.some(file => file.size > limit)
            && array.every(file => file.size <= limit || canCompress(file));
    },

    async compressUploads(uploader: DiscordUploader, signal: AbortSignal) {
        if (uploader[COMPRESSION_TASK]) return uploader[COMPRESSION_TASK];

        const task = this.runCompressionJobs(uploader, signal);
        uploader[COMPRESSION_TASK] = task;
        try {
            await task;
        } catch (error) {
            if (error instanceof CompressionError && error.code === CompressionErrorCode.Compatibility) {
                logger.error("Discord uploader compatibility check failed", error);
                showToast(error.message, Toasts.Type.FAILURE);
            }
            throw error;
        } finally {
            delete uploader[COMPRESSION_TASK];
        }
    },

    async runCompressionJobs(uploader: DiscordUploader, signal: AbortSignal) {
        await staleCleanupTask;
        staleCleanupTask = null;
        validateUploader(uploader);

        // A previous send attempt may have left a now-compressed draft in
        // ERROR state. Reset failed items even when no further compression is
        // needed so Discord actually retries their upload.
        for (const upload of uploader.files) {
            if (upload.status === "COMPLETED") await cleanupUploadTemporaryFile(upload);
            if (upload.status === "ERROR") {
                logger.info(`Resetting failed draft upload ${upload.filename}`);
                resetUpload(upload);
            }
        }

        const jobs = uploader.files.filter(upload => {
            const file = upload.item?.file;
            if (!file) return false;
            const guildId = ChannelStore.getChannel(upload.channelId)?.guild_id ?? null;
            return file.size > getUploadLimitBytes(guildId)
                && canCompress(file);
        });
        if (!jobs.length) return;

        uploader[AUTO_COMPRESSED] = true;
        const totalWork = jobs.reduce((total, upload) => total + upload.item.file.size, 0);
        let completedWork = 0;
        uploader._file = {
            ...uploader._file,
            autoCompressUploads: true,
            compressionProgress: 0,
            progress: 0,
            totalPreCompressionSize: totalWork,
            uploadProgress: 0,
        };
        uploader.emit("progress", uploader._file);

        for (const upload of jobs) {
            if (signal.aborted) throw new CompressionError(CompressionErrorCode.Cancelled, "Compression was cancelled");
            if (attachmentWasRemoved(uploader, upload)) continue;

            const originalFile = upload.item.file;
            const guildId = ChannelStore.getChannel(upload.channelId)?.guild_id ?? null;
            const limit = getUploadLimitBytes(guildId);
            const targetBytes = getTargetBytes(limit);
            const diagnostics = createDiagnostics(originalFile, limit, targetBytes);
            const report = (fileProgress: number) => {
                const overall = Math.min(1, (completedWork + originalFile.size * fileProgress) / totalWork);
                const visibleProgress = Math.floor(overall * 50);
                uploader._file = {
                    ...uploader._file,
                    compressionProgress: Math.floor(overall * 100),
                    progress: visibleProgress,
                    uploadProgress: 0,
                };
                uploader.emit("progress", uploader._file);
            };

            let compressed: File | undefined;
            try {
                if (isCompressibleGif(originalFile)) {
                    compressed = await compressGif(originalFile, targetBytes, signal, report);
                } else if (isCompressibleImage(originalFile)) {
                    compressed = await compressImage(originalFile, targetBytes, signal, report);
                } else if (isCompressibleAudio(originalFile)) {
                    compressed = await compressAudio(originalFile, targetBytes, signal, report);
                } else if (isCompressibleVideo(originalFile)) {
                    const options: CompressionOptions = {
                        maximumVideoHeight: MAXIMUM_VIDEO_HEIGHT,
                        minimumVideoBitrate: MINIMUM_VIDEO_BITRATE,
                        targetBytes,
                    };
                    compressed = await compressVideo(originalFile, options, signal, report);
                } else {
                    continue;
                }

                if (compressed.size >= originalFile.size) {
                    throw new Error("Compression did not make the file smaller");
                }
                if (compressed.size > limit) {
                    throw new Error("The compressed result is still above the channel limit");
                }

                if (attachmentWasRemoved(uploader, upload)) {
                    await (compressed as CompressedFile)[TEMP_OUTPUT_CLEANUP]?.();
                    logger.info(`Discarded finished compression for removed attachment ${originalFile.name}`);
                    continue;
                }

                updateUploadFile(upload, compressed, originalFile);
                diagnostics.output = {
                    bytes: compressed.size,
                    extension: getExtension(compressed),
                    mimeType: compressed.type,
                };
                setLastDiagnostics(diagnostics);
                logger.info(
                    `Prepared ${compressed.name}: ${originalFile.size} → ${compressed.size} bytes`,
                );
            } catch (error) {
                await (compressed as CompressedFile | undefined)?.[TEMP_OUTPUT_CLEANUP]?.();
                diagnostics.error = {
                    code: error instanceof CompressionError ? error.code : "unexpected_error",
                    message: describeError(error),
                    name: error instanceof Error ? error.name : typeof error,
                };
                setLastDiagnostics(diagnostics);
                if (signal.aborted || error instanceof CompressionError && error.code === CompressionErrorCode.Cancelled) throw error;
                logger.error(`Failed to compress ${originalFile.name}`, error);
                if (!(error instanceof CompressionError && error.code === CompressionErrorCode.Compatibility)) {
                    showToast(
                        `Could not compress ${originalFile.name}: ${describeError(error)}`,
                        Toasts.Type.FAILURE,
                    );
                }
                throw error;
            } finally {
                completedWork += originalFile.size;
                report(0);
            }
        }
    },

    reportUploadProgress(uploader: DiscordUploader) {
        for (const upload of uploader.files) {
            if (upload.status === "COMPLETED") void cleanupUploadTemporaryFile(upload);
        }

        const { loaded, total } = uploader._recomputeProgressTotal();
        const progressByFile = uploader._recomputeProgressByFile();
        if (!uploader[AUTO_COMPRESSED] || total <= 0) {
            uploader._handleProgress(loaded, total, progressByFile);
            return;
        }

        const uploadProgress = Math.min(1, loaded / total);
        uploader._file = {
            ...uploader._file,
            compressionProgress: 100,
            uploadProgress: Math.floor(uploadProgress * 100),
        };

        // Keep Discord's aggregate progress semantics continuous for any other
        // consumers while the UI presents the two stages independently.
        const combinedLoaded = total * (0.5 + 0.5 * uploadProgress);
        uploader._handleProgress(combinedLoaded, total, progressByFile);
    },
});
