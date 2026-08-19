/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 kolehoenicke
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Tooltip } from "@webpack/common";
import type { ReactElement } from "react";

interface UploadProgressFile {
    autoCompressUploads?: boolean;
    compressionProgress?: number;
    progress: number;
    uploadProgress?: number;
}

interface NativeProgressProps {
    "aria-label": string;
    className?: string;
    value: number;
}

type NativeProgress = (props: NativeProgressProps) => ReactElement;

function clampProgress(value: number | undefined): number {
    return Math.max(0, Math.min(100, value ?? 0));
}

export function SegmentedUploadProgress(
    file: UploadProgressFile,
    label: string,
    Progress: NativeProgress,
) {
    if (!file.autoCompressUploads) {
        return <Progress value={file.progress} aria-label={label} />;
    }

    const compressionProgress = clampProgress(file.compressionProgress);
    const uploadProgress = clampProgress(file.uploadProgress);

    return (
        <div className="vc-acu-segmented-progress">
            <Tooltip text={`Compression: ${compressionProgress}%`} position="top">
                {tooltipProps => (
                    <div {...tooltipProps} className="vc-acu-progress-stage">
                        <Progress
                            value={compressionProgress}
                            aria-label={`Compression for ${label}: ${compressionProgress}%`}
                            className="vc-acu-progress-track"
                        />
                    </div>
                )}
            </Tooltip>
            <Tooltip text={`Upload: ${uploadProgress}%`} position="top">
                {tooltipProps => (
                    <div {...tooltipProps} className="vc-acu-progress-stage">
                        <Progress
                            value={uploadProgress}
                            aria-label={`Upload for ${label}: ${uploadProgress}%`}
                            className="vc-acu-progress-track"
                        />
                    </div>
                )}
            </Tooltip>
        </div>
    );
}
