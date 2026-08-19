/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 kolehoenicke
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings } from "@api/Settings";
import { Margins } from "@utils/margins";
import { OptionType } from "@utils/types";
import { Button, Forms, showToast, Toasts } from "@webpack/common";

import { serializeLastDiagnostics } from "./diagnostics";

function DiagnosticsButton() {
    async function copyDiagnostics() {
        const diagnostics = serializeLastDiagnostics();
        if (!diagnostics) {
            showToast("No compression diagnostics have been recorded yet", Toasts.Type.MESSAGE);
            return;
        }

        try {
            await navigator.clipboard.writeText(diagnostics);
            showToast("Compression diagnostics copied", Toasts.Type.SUCCESS);
        } catch {
            showToast("Could not copy compression diagnostics", Toasts.Type.FAILURE);
        }
    }

    return (
        <section>
            <Forms.FormTitle tag="h3">Troubleshooting</Forms.FormTitle>
            <Forms.FormText className={Margins.bottom8}>
                Diagnostics contain file type and size information, but never the file contents or full filename.
            </Forms.FormText>
            <Button onClick={copyDiagnostics}>Copy last diagnostics</Button>
        </section>
    );
}

export const settings = definePluginSettings({
    diagnostics: {
        type: OptionType.COMPONENT,
        component: DiagnosticsButton,
    },
});
