import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";

const source = readFileSync(new URL("../index.ts", import.meta.url), "utf8");
const patches = vm.runInNewContext(source.match(/patches: (\[[\s\S]*?\n    \]),/)[1]);
function applyPatch(source, replacement) {
    const match = new RegExp(replacement.match.source.replaceAll("\\i", "(?:[A-Za-z_$][\\w$]*)"));
    assert.equal([...source.matchAll(new RegExp(match, "g"))].length, 1);
    return source.replace(match, replacement.replace.replaceAll("$self", "plugin"));
}

// Recorded from Discord desktop stable 627798, modules 518960 and 688438.
const draftCheck = "if((0,y.fJ)({files:L,guildId:I}))return void P(t,L);";
const sendCheck = "if((0,nN.fJ)({files:e,guildId:d?.id}))return(0,ej.V)(h,e),{shouldClear:!1,shouldRefocus:!1};";

for (const [label, check, replacement, declarations, blockedResult] of [
    ["paste", draftCheck, patches[0].replacement, "let L=files,I=guildId,t=channel;", undefined],
    ["Send", sendCheck, patches[1].replacement, "let e=files,d=guildId==null?null:{id:guildId},h=channel;", { shouldClear: false, shouldRefocus: false }]
]) {
    for (const [description, oversized, supported] of [
        ["oversized MOV", true, true],
        ["oversized archive", true, false],
        ["file under the limit", false, false]
    ]) {
        test(`${label}: ${description}`, () => {
            const files = [{ size: oversized ? 760 * 1024 * 1024 : 1 }];
            const channel = {};
            let errorCalls = 0;
            let preprocessingCalls = 0;
            const context = {
                y: { fJ: sizeCheck }, nN: { fJ: sizeCheck },
                P: showError, ej: { V: showError },
                plugin: { canPreprocessFiles(actualFiles, actualGuild) {
                    preprocessingCalls++;
                    assert.equal(actualFiles, files);
                    assert.equal(actualGuild, label === "Send" ? undefined : null);
                    return supported;
                } }
            };
            function sizeCheck(options) {
                assert.equal(options.files, files);
                assert.equal(options.guildId, label === "Send" ? undefined : null);
                return oversized;
            }
            function showError(actualChannel, actualFiles) {
                assert.equal(actualChannel, channel);
                assert.equal(actualFiles, files);
                errorCalls++;
            }
            const fn = vm.runInNewContext(`(function(files,guildId,channel){${declarations}${applyPatch(check, replacement)}return "accepted";})`, context);
            const result = fn(files, null, channel);
            if (oversized && !supported) assert.deepEqual(result == null ? result : { ...result }, blockedResult);
            else assert.equal(result, "accepted");
            assert.equal(errorCalls, Number(oversized && !supported));
            assert.equal(preprocessingCalls, Number(oversized));
        });
    }
}

for (const separator of [";", ","]) {
    test(`uploader: compression precedes validation with ${separator === ";" ? "statements" : "a comma expression"}`, async () => {
        const calls = [];
        const setup = separator === ";"
            ? "this._handleStart(()=>n.abort());let i=true;if(!await this.compressAndCheckFileSize({deferTotalSizeCheckUntilAfterCompression:i}))return false;"
            : "if(this._handleStart(()=>n.abort()),!await this.compressAndCheckFileSize())return false;";
        const fn = vm.runInNewContext(`(async function(){let n=new AbortController;${applyPatch(setup, patches[2].replacement[0])}return true;})`, {
            AbortController,
            plugin: { async compressUploads(uploader, signal) {
                calls.push("compression");
                assert.equal(signal.aborted, false);
                uploader.compressed = true;
            } }
        });
        const uploader = {
            _handleStart(cancel) { calls.push("start"); assert.equal(typeof cancel, "function"); },
            async compressAndCheckFileSize() { calls.push("validation"); assert.equal(this.compressed, true); return true; }
        };
        assert.equal(await fn.call(uploader), true);
        assert.deepEqual(calls, ["start", "compression", "validation"]);
    });
}

test("unrelated file count rejection stays unchanged", () => {
    const countCheck = "if(h.A.getUploadCount(t.id,i)+z.length>S.XgB)return;";
    const replacement = patches[0].replacement;
    const match = new RegExp(replacement.match.source.replaceAll("\\i", "(?:[A-Za-z_$][\\w$]*)"));
    assert.equal(match.test(countCheck), false);
});
