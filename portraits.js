import { getSettings } from './state-manager.js';
import { saveSettings } from './index.js';
import { sendStateRequest } from './llm-client.js';
import { parseMemoBlocks } from './renderer.js';
import { escapeHtml } from './memo-processor.js';
import { getLorebookManifest } from './router.js';

// Read an image File as a full-resolution Base64 data URL
export function fileToDataUrl(file) {
    return new Promise((resolve, reject) => {
        if (!file || !file.type.startsWith('image/')) return reject(new Error('Not an image'));
        const reader = new FileReader();
        reader.onload = (ev) => resolve(ev.target.result);
        reader.onerror = reject;
        reader.readAsDataURL(file);
    });
}

// Compress and scale a cropped image to a 512x512 square JPEG Base64 data URL
export function scaleImageTo512Square(dataUrl) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => {
            const canvas = document.createElement('canvas');
            canvas.width  = 512;
            canvas.height = 512;
            canvas.getContext('2d').drawImage(img, 0, 0, 512, 512);
            resolve(canvas.toDataURL('image/jpeg', 0.85));
        };
        img.onerror = reject;
        img.src = dataUrl;
    });
}

export function applyPortraitData(entityName, src) {
    const s = getSettings();
    if (!s.customPortraits) s.customPortraits = {};
    if (src) {
        s.customPortraits[entityName] = src;
    } else {
        delete s.customPortraits[entityName];
    }
    saveSettings();
}

// ── Pollinations.ai model list (image-only, sorted cheapest → most expensive) ──
export const POLLINATIONS_IMAGE_MODELS = [
    // Budget
    { id: 'flux',                  label: 'Flux',                       tier: 'Budget' },
    { id: 'zimage',                label: 'ZImage',                     tier: 'Budget' },
    { id: 'qwen-image',            label: 'Qwen Image',                 tier: 'Budget' },
    { id: 'kontext',               label: 'Kontext',                    tier: 'Budget' },
    { id: 'wan-image',             label: 'Wan Image',                  tier: 'Budget' },
    // Standard
    { id: 'wan-image-pro',         label: 'Wan Image Pro',              tier: 'Standard' },
    { id: 'seedream',              label: 'Seedream',                   tier: 'Standard' },
    { id: 'seedream5',             label: 'Seedream 5',                 tier: 'Standard' },
    { id: 'seedream-pro',          label: 'Seedream Pro',               tier: 'Standard' },
    { id: 'klein',                 label: 'Klein',                      tier: 'Standard' },
    { id: 'p-image',               label: 'P-Image',                    tier: 'Standard' },
    { id: 'nova-canvas',           label: 'Nova Canvas',                tier: 'Standard' },
    { id: 'grok-imagine',          label: 'Grok Imagine',               tier: 'Standard' },
    // Premium
    { id: 'nanobanana',            label: 'NanoBanana',                 tier: 'Premium' },
    { id: 'nanobanana-2',          label: 'NanoBanana 2',               tier: 'Premium' },
    { id: 'nanobanana-pro',        label: 'NanoBanana Pro',             tier: 'Premium' },
    { id: 'ideogram-v4-turbo',     label: 'Ideogram v4 Turbo',          tier: 'Premium' },
    { id: 'ideogram-v4-balanced',  label: 'Ideogram v4 Balanced',       tier: 'Premium' },
    { id: 'ideogram-v4-quality',   label: 'Ideogram v4 Quality',        tier: 'Premium' },
    { id: 'gptimage',              label: 'GPT Image',                  tier: 'Premium' },
    { id: 'gptimage-large',        label: 'GPT Image Large',            tier: 'Premium' },
    { id: 'gpt-image-2',           label: 'GPT Image 2',                tier: 'Premium' },
    { id: 'grok-imagine-pro',      label: 'Grok Imagine Pro',           tier: 'Premium' },
];

// ── AI Portrait Prompt Generation ──────────────────────────────────────────────

/**
 * Gathers context and calls the LLM to generate an image prompt for a character.
 * @param {string} entityName
 * @returns {Promise<string>} The generated image prompt text
 */
export async function generatePortraitPrompt(entityName) {
    const s = getSettings();
    const ctx = SillyTavern.getContext();

    // 1. Entity name
    let contextParts = [`Character Name: ${entityName}`];

    // 2. Current memo — find the entity in CHARACTER, PARTY, COMBAT blocks
    if (s.currentMemo) {
        const blocks = parseMemoBlocks(s.currentMemo);
        const relevantTags = ['CHARACTER', 'PARTY', 'COMBAT'];
        for (const tag of relevantTags) {
            const block = blocks[tag];
            if (!block) continue;
            // Check if the entity name appears in this block
            if (block.toUpperCase().includes(entityName.toUpperCase())) {
                contextParts.push(`[${tag}] block (from State Memo):\n${block.trim()}`);
            }
        }
    }

    // 3. Persona — always included, LLM decides if relevant
    try {
        const persona = ctx.substituteParams?.('{{persona}}') || '';
        if (persona.trim()) {
            contextParts.push(`User Persona:\n${persona.trim()}`);
        }
    } catch { /* substituteParams may not exist */ }

    // 4. Character card description
    try {
        const charId = ctx.characterId;
        const charData = ctx.characters?.[charId];
        if (charData?.description) {
            contextParts.push(`Character Card Description:\n${charData.description.substring(0, 2000)}`);
        }
    } catch { /* ignore */ }

    // 5. Active lorebook entries — scan for keyword matches with entityName
    try {
        const worldInfo = ctx.chat_metadata?.world_info;
        if (worldInfo) {
            // Try to get entries from context
            const entries = typeof ctx.getWorldInfoEntries === 'function'
                ? await ctx.getWorldInfoEntries()
                : null;
            if (entries && Array.isArray(entries)) {
                const matchingEntries = entries.filter(entry => {
                    const keys = entry.key || [];
                    const keysArr = Array.isArray(keys) ? keys : [keys];
                    return keysArr.some(k => k && (
                        entityName.toLowerCase().includes(k.toLowerCase()) ||
                        k.toLowerCase().includes(entityName.toLowerCase())
                    ));
                });
                if (matchingEntries.length > 0) {
                    const loreText = matchingEntries.map(e =>
                        `[Lorebook: ${e.comment || e.key?.[0] || 'Entry'}]\n${(e.content || '').substring(0, 800)}`
                    ).join('\n\n');
                    contextParts.push(`Matching Lorebook Entries:\n${loreText}`);
                }
            }
        }
    } catch { /* lorebook access may vary */ }

    // Also check active router keys for lorebook context
    try {
        if (s.activeRouterKeys?.length > 0) {
            const manifest = typeof getLorebookManifest === 'function' ? await getLorebookManifest() : null;
            if (manifest) {
                const matchingActive = manifest.filter(entry => {
                    const keys = entry.keys || [];
                    return keys.some(k => k && (
                        entityName.toLowerCase().includes(k.toLowerCase()) ||
                        k.toLowerCase().includes(entityName.toLowerCase())
                    ));
                });
                if (matchingActive.length > 0) {
                    const activeText = matchingActive.map(e =>
                        `[Active Lore: ${e.label || e.category || 'Entry'}]\n${(e.content || '').substring(0, 800)}`
                    ).join('\n\n');
                    contextParts.push(`Active Lorebook Context:\n${activeText}`);
                }
            }
        }
    } catch { /* lorebook manifest may not be available */ }

    // 6. Full Lorebook Agent context — ALL active keys with keywords and content
    try {
        if (s.activeRouterKeys?.length > 0) {
            const agentBooks = {};
            for (const k of s.activeRouterKeys) {
                const [bookName] = k.split('::');
                if (!agentBooks[bookName]) agentBooks[bookName] = await ctx.loadWorldInfo(bookName);
            }
            const agentEntries = [];
            for (const k of s.activeRouterKeys) {
                const [bookName, uid] = k.split('::');
                const entry = agentBooks[bookName]?.entries?.[uid];
                if (entry && entry.content) {
                    const keywords = (entry.key || []).filter(Boolean).join(', ');
                    const label = entry.comment || entry.key?.[0] || uid;
                    agentEntries.push(`[Agent Entry: "${label}" | Keywords: ${keywords || 'none'}]\n${(entry.content || '').substring(0, 600)}`);
                }
            }
            if (agentEntries.length > 0) {
                contextParts.push(`Current Lorebook Agent (All Active Entries):\n${agentEntries.join('\n\n')}`);
            }
        }
    } catch { /* lorebook agent entries may not be loadable */ }

    // 7. Current game state (memo) — full state for rich context
    try {
        if (s.currentMemo) {
            contextParts.push(`Current Game State:\n${s.currentMemo.substring(0, 2000)}`);
        }
    } catch { /* ignore */ }

    // 8. Last 5 messages from chat
    try {
        if (ctx.chat && Array.isArray(ctx.chat)) {
            const filteredMsgs = ctx.chat.filter(m => !m.is_system && m.mes && m.mes.trim());
            const lastMsgs = filteredMsgs.slice(-5);
            if (lastMsgs.length > 0) {
                const msgText = lastMsgs.map(m => `${m.name || (m.is_user ? 'User' : 'Character')}: ${m.mes}`).join('\n\n');
                contextParts.push(`Recent Chat Context (Last 5 Messages):\n${msgText.substring(0, 3000)}`);
            }
        }
    } catch { /* ignore */ }

    const systemPrompt = `You are a portrait prompt generator for AI image models. Given character context from an RPG game, output a single detailed image generation prompt suitable for an AI image model.

You are provided with the full Lorebook Agent context — all currently active lore entries with their keywords and content — as well as the current game state. Use these to infer accurate visual details about the character, their world, and their situation.

Focus on:
- Physical appearance (race, build, facial features, skin color, hair)
- Clothing, armor, equipment visible on the character
- Pose and expression appropriate to the character's personality
- Art style: high-quality fantasy portrait, dramatic lighting, detailed

Rules:
- Output ONLY the prompt text, nothing else. No preamble, no explanation.
- Keep it under 200 words.
- A user persona is provided for reference. If it does NOT describe the character "${entityName}", ignore it entirely and do not use any of its details in the portrait prompt.
- Focus on visual details. Do not include game stats, abilities, or non-visual information.`;

    const userPrompt = contextParts.join('\n\n---\n\n');

    const portraitSettings = {
        connectionSource: s.portraitConnectionSource ?? 'default',
        connectionProfileId: s.portraitConnectionProfileId || '',
        completionPresetId: s.portraitCompletionPresetId || '',
        ollamaUrl: s.portraitOllamaUrl || 'http://localhost:11434',
        ollamaModel: s.portraitOllamaModel || '',
        openaiUrl: s.portraitOpenaiUrl || '',
        openaiKey: s.portraitOpenaiKey || '',
        openaiModel: s.portraitOpenaiModel || '',
        maxTokens: s.maxTokens,
        debugMode: s.debugMode,
    };

    const result = await sendStateRequest(portraitSettings, systemPrompt, userPrompt);
    return (result || '').trim();
}

/**
 * Shows the generated prompt in an editable popup with Copy + Generate options.
 * @param {string} prompt
 * @param {string} entityName
 * @param {function} localApply - callback to apply a portrait URL
 * @param {function} refresh - callback to refresh the view
 */
export async function showPortraitPromptPopup(prompt, entityName, localApply, refresh) {
    const ctx = SillyTavern.getContext();
    const s = getSettings();
    if (!ctx.callGenericPopup) return;

    const isNative = s.portraitGeneratorSource === 'native';
    const subText = isNative
        ? 'Edit the prompt below, then copy it or generate directly with the ST Image Generation extension'
        : 'Edit the prompt below, then copy it or generate directly with Pollinations.ai';

    const textareaId = `rt-ai-prompt-${Date.now()}`;
    const skipCheckboxId = `rt-skip-prompt-${Date.now()}`;
    const popupContent = `<div style="padding:10px;min-width:320px;max-width:500px;">
        <b style="display:block;margin-bottom:8px;">🤖 AI Portrait Prompt — ${escapeHtml(entityName)}</b>
        <div style="font-size:0.8em;opacity:0.6;margin-bottom:8px;">${escapeHtml(subText)}</div>
        <textarea id="${textareaId}" style="width:100%;min-height:120px;resize:vertical;font-size:0.9em;padding:8px;border-radius:6px;border:1px solid rgba(255,255,255,0.2);background:rgba(0,0,0,0.3);color:inherit;box-sizing:border-box;">${escapeHtml(prompt)}</textarea>
        <label style="display:flex;align-items:center;gap:6px;font-size:0.8em;margin-top:8px;cursor:pointer;user-select:none;opacity:0.8;">
            <input id="${skipCheckboxId}" type="checkbox" style="margin:0;cursor:pointer;"/>
            Don't show this dialog again (Auto-Generate & Auto-Apply)
        </label>
    </div>`;

    const popupOpts = {
        okButton: isNative ? '🎨 Generate with ST Image Gen' : '🎨 Generate with Pollinations',
        cancelButton: 'Cancel',
        wide: false,
        customButtons: [
            { text: '📋 Copy Prompt', result: 3, classes: ['menu_button'] },
        ],
    };

    let finalPrompt = prompt;
    let skipChecked = false;
    setTimeout(() => {
        const ta = /** @type {HTMLTextAreaElement|null} */ (document.getElementById(textareaId));
        if (ta) {
            ta.addEventListener('input', () => { finalPrompt = ta.value; });
            ta.focus();
            ta.setSelectionRange(ta.value.length, ta.value.length);
        }
        const chk = /** @type {HTMLInputElement|null} */ (document.getElementById(skipCheckboxId));
        if (chk) {
            chk.addEventListener('change', () => { skipChecked = chk.checked; });
        }
    }, 0);

    const result = await ctx.callGenericPopup(popupContent, ctx.POPUP_TYPE?.CONFIRM ?? 1, '', popupOpts);

    if (result === 3) {
        // Copy to clipboard
        try {
            await navigator.clipboard.writeText(finalPrompt);
            toastr['success']('Portrait prompt copied to clipboard.', 'RPG Tracker');
        } catch {
            toastr['warning']('Could not copy to clipboard.', 'RPG Tracker');
        }
    } else if (result) {
        if (skipChecked) {
            s.portraitSkipPromptDialog = true;
            $('#rpg_tracker_portrait_skip_prompt').prop('checked', true);
            saveSettings();
        }
        if (isNative) {
            await generateWithNativeExtension(finalPrompt, entityName, localApply, refresh);
        } else {
            // Generate with Pollinations
            await generateWithPollinations(finalPrompt, entityName, localApply, refresh);
        }
    }
}

/**
 * Direct image generation backend helper. Generates the image based on settings source.
 * @param {string} prompt
 * @param {string} entityName
 * @returns {Promise<string>} data URL or image relative URL
 */
export async function generatePortraitDirect(prompt, entityName) {
    const s = getSettings();
    const isNative = s.portraitGeneratorSource === 'native';

    if (isNative) {
        const { SlashCommandParser } = SillyTavern.getContext();
        const hasImagine = SlashCommandParser && SlashCommandParser.commands && SlashCommandParser.commands['imagine'];
        if (!hasImagine) {
            throw new Error('ST Image Generation extension is not enabled. Please enable it in SillyTavern settings.');
        }
        const parser = new SlashCommandParser();
        const escapedPrompt = prompt.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
        const command = `/imagine quiet=true gallery=false "${escapedPrompt}"`;
        const closure = parser.parse(command);
        const result = await closure.execute();
        if (result && result.isError) {
            throw new Error(result.errorMessage || 'ST Image Generation execution failed');
        }
        const imageUrl = result && result.pipe;
        if (!imageUrl) {
            throw new Error('No image URL returned from the ST Image Generation extension');
        }
        return imageUrl;
    } else {
        const apiKey = await ensurePollinationsKey();
        if (!apiKey) throw new Error('Pollinations API key is required');

        const currentModel = s.pollinationsModel || 'flux';
 
        const doRequest = async (modelName) => {
            const url = `https://gen.pollinations.ai/image/${encodeURIComponent(prompt)}?key=${apiKey}&model=${modelName}&width=512&height=512`;
            
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 20000); // 20-second timeout
            
            let resp;
            try {
                resp = await fetch(url, { signal: controller.signal });
                clearTimeout(timeoutId);
            } catch (err) {
                clearTimeout(timeoutId);
                if (err.name === 'AbortError') {
                    throw new Error('Pollinations request timed out after 20 seconds');
                }
                throw err;
            }

            if (!resp.ok) {
                const errText = await resp.text().catch(() => 'Unknown error');
                throw new Error(`Pollinations ${resp.status}: ${errText.substring(0, 300)}`);
            }
            
            const blob = await resp.blob();
            if (!blob || blob.size === 0) {
                throw new Error('Received empty image blob from Pollinations API');
            }
            
            return new Promise((resolve, reject) => {
                const reader = new FileReader();
                reader.onloadend = () => {
                    if (typeof reader.result === 'string') {
                        resolve(reader.result);
                    } else {
                        reject(new Error('Failed to read image as Base64 string'));
                    }
                };
                reader.onerror = () => reject(new Error('FileReader error while converting image blob'));
                reader.readAsDataURL(blob);
            });
        };

        try {
            return await doRequest(currentModel);
        } catch (err) {
            console.warn(`[RPG Tracker] Generation failed for model "${currentModel}": ${err.message}. Trying fallback models...`);
            
            // If the custom model failed and it wasn't 'flux', try 'flux'
            if (currentModel !== 'flux') {
                try {
                    return await doRequest('flux');
                } catch (fallbackErr) {
                    console.warn(`[RPG Tracker] Fallback to "flux" failed: ${fallbackErr.message}. Trying "turbo"...`);
                }
            }
            
            // Try 'turbo' (highly available SDXL model on Pollinations.ai)
            try {
                return await doRequest('turbo');
            } catch (turboErr) {
                throw new Error(`All model options failed. Original error: ${err.message}`);
            }
        }
    }
}

/**
 * Ensures the user has a Pollinations API key set. If not, shows an entry popup.
 * @returns {Promise<string|null>} The API key, or null if the user cancels
 */
export async function ensurePollinationsKey() {
    const s = getSettings();
    if (s.pollinationsApiKey) return s.pollinationsApiKey;

    const ctx = SillyTavern.getContext();
    if (!ctx.callGenericPopup) return null;

    const inputId = `rt-pollinations-key-${Date.now()}`;
    const popupContent = `<div style="padding:10px;min-width:300px;">
        <b style="display:block;margin-bottom:8px;">🔑 Pollinations API Key Required</b>
        <div style="font-size:0.85em;opacity:0.75;margin-bottom:10px;line-height:1.5;">
            <b>Why Pollinations?</b> Pollinations.ai was created to preserve free AI access. It is a <b>non-profit</b> project committed to remaining <b>free forever</b>, with generous hourly rate limits that reset every hour.
            <br><br>
            All you need is a <b>GitHub account</b> to get a permanent API key. Using budget models like ZImage, you can generate approximately <b>10–20 portraits per hour</b> at no cost.
            <br><br>
            Get your free key at:<br>
            <a href="https://enter.pollinations.ai/#keys" target="_blank" style="color:#7ec8e3;font-weight:bold;">🔗 enter.pollinations.ai/#keys</a>
        </div>
        <input id="${inputId}" type="password" class="text_pole" placeholder="Paste your API key here (sk_… or pk_…)" style="width:100%;box-sizing:border-box;"/>
    </div>`;

    let keyValue = '';
    setTimeout(() => {
        const inp = /** @type {HTMLInputElement|null} */ (document.getElementById(inputId));
        if (inp) {
            inp.addEventListener('input', () => { keyValue = inp.value.trim(); });
            inp.focus();
        }
    }, 0);

    const result = await ctx.callGenericPopup(popupContent, ctx.POPUP_TYPE?.CONFIRM ?? 1, '', {
        okButton: 'Save & Continue',
        cancelButton: 'Cancel',
        wide: false,
    });

    if (result && keyValue) {
        s.pollinationsApiKey = keyValue;
        // Also update the settings panel input if visible
        $('#rpg_tracker_pollinations_key').val(keyValue);
        saveSettings();
        return keyValue;
    }
    return null;
}

/**
 * Generates an image via Pollinations.ai and shows the preview/approve popup.
 * @param {string} prompt
 * @param {string} entityName
 * @param {function} localApply
 * @param {function} refresh
 */
export async function generateWithPollinations(prompt, entityName, localApply, refresh) {
    const s = getSettings();
    const ctx = SillyTavern.getContext();
    if (!ctx.callGenericPopup) return;

    let currentModel = s.pollinationsModel || 'flux';

    const showPreview = async () => {
        const modelOptions = POLLINATIONS_IMAGE_MODELS.map(m => {
            const sel = m.id === currentModel ? 'selected' : '';
            return `<option value="${m.id}" ${sel}>${m.label} (${m.tier})</option>`;
        }).join('');

        const selectId = `rt-poll-model-${Date.now()}`;
        const imgId = `rt-poll-img-${Date.now()}`;
        const spinnerId = `rt-poll-spinner-${Date.now()}`;
        const errorId = `rt-poll-error-${Date.now()}`;

        // Fire generation immediately
        const genPromise = generatePortraitDirect(prompt, entityName);
        genPromise.then(dataUrl => {
            const img = document.getElementById(imgId);
            const spinner = document.getElementById(spinnerId);
            if (img) { img.src = dataUrl; img.style.display = 'block'; }
            if (spinner) spinner.style.display = 'none';
        }).catch(err => {
            const spinner = document.getElementById(spinnerId);
            const errEl = document.getElementById(errorId);
            if (spinner) spinner.style.display = 'none';
            if (errEl) { errEl.textContent = `⚠ ${err.message}`; errEl.style.display = 'block'; }
        });

        const popupContent = `<div style="padding:10px;min-width:320px;max-width:460px;">
            <b style="display:block;margin-bottom:8px;">🖼️ Generated Portrait — ${escapeHtml(entityName)}</b>
            <div style="position:relative;text-align:center;margin-bottom:10px;min-height:200px;">
                <div id="${spinnerId}" style="position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);font-size:0.9em;opacity:0.6;">
                    <i class="fa-solid fa-spinner fa-spin" style="margin-right:6px;"></i>Generating image…
                </div>
                <img id="${imgId}" style="max-width:100%;max-height:400px;border-radius:8px;display:none;margin:0 auto;" />
                <div id="${errorId}" style="display:none;color:#ff6b6b;font-size:0.9em;margin-top:10px;"></div>
            </div>
            <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;">
                <label style="font-size:0.82em;opacity:0.8;white-space:nowrap;">Model:</label>
                <select id="${selectId}" class="text_pole" style="flex:1;font-size:0.85em;">${modelOptions}</select>
            </div>
            <div style="font-size:0.72em;opacity:0.45;margin-top:2px;">Prompt: ${escapeHtml(prompt.substring(0, 100))}${prompt.length > 100 ? '…' : ''}</div>
        </div>`;

        const popupOpts = {
            okButton: '✅ Apply Portrait', cancelButton: 'Cancel', wide: false,
            customButtons: [{ text: '🔄 Regenerate', result: 3, classes: ['menu_button'] }],
        };

        setTimeout(() => {
            const sel = /** @type {HTMLSelectElement|null} */ (document.getElementById(selectId));
            if (sel) sel.addEventListener('change', () => { currentModel = sel.value; s.pollinationsModel = currentModel; saveSettings(); });
        }, 0);

        const result = await ctx.callGenericPopup(popupContent, ctx.POPUP_TYPE?.CONFIRM ?? 1, '', popupOpts);

        if (result === 3) {
            await showPreview(); // Regenerate
        } else if (result) {
            // Wait for generation to finish, then scale and apply
            try {
                const dataUrl = await genPromise;
                const scaled = await scaleImageTo512Square(dataUrl);
                localApply(scaled);
                toastr['success'](`Portrait applied for ${entityName}!`, 'RPG Tracker');
            } catch (err) {
                toastr['error']('Cannot apply — generation failed: ' + err.message, 'RPG Tracker');
            }
        }
    };

    await showPreview();
}

/**
 * Generates an image via the native SillyTavern Image Generation extension and shows a preview/approve popup.
 * @param {string} prompt
 * @param {string} entityName
 * @param {function} localApply
 * @param {function} refresh
 */
export async function generateWithNativeExtension(prompt, entityName, localApply, refresh) {
    const ctx = SillyTavern.getContext();
    if (!ctx.callGenericPopup) return;

    const showPreview = async () => {
        const imgId = `rt-native-img-${Date.now()}`;
        const spinnerId = `rt-native-spinner-${Date.now()}`;
        const errorId = `rt-native-error-${Date.now()}`;

        // Fire generation immediately
        const genPromise = generatePortraitDirect(prompt, entityName);
        genPromise.then(imageUrl => {
            const img = document.getElementById(imgId);
            const spinner = document.getElementById(spinnerId);
            if (img) { img.src = imageUrl; img.style.display = 'block'; }
            if (spinner) spinner.style.display = 'none';
        }).catch(err => {
            const spinner = document.getElementById(spinnerId);
            const errEl = document.getElementById(errorId);
            if (spinner) spinner.style.display = 'none';
            if (errEl) { errEl.textContent = `⚠ ${err.message}`; errEl.style.display = 'block'; }
        });

        const popupContent = `<div style="padding:10px;min-width:320px;max-width:460px;">
            <b style="display:block;margin-bottom:8px;">🖼️ Generated Portrait — ${escapeHtml(entityName)}</b>
            <div style="position:relative;text-align:center;margin-bottom:10px;min-height:200px;">
                <div id="${spinnerId}" style="position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);font-size:0.9em;opacity:0.6;">
                    <i class="fa-solid fa-spinner fa-spin" style="margin-right:6px;"></i>Generating image with native extension…
                </div>
                <img id="${imgId}" style="max-width:100%;max-height:400px;border-radius:8px;display:none;margin:0 auto;" />
                <div id="${errorId}" style="display:none;color:#ff6b6b;font-size:0.9em;margin-top:10px;"></div>
            </div>
            <div style="font-size:0.72em;opacity:0.45;margin-top:2px;">Prompt: ${escapeHtml(prompt.substring(0, 100))}${prompt.length > 100 ? '…' : ''}</div>
        </div>`;

        const popupOpts = {
            okButton: '✅ Apply Portrait', cancelButton: 'Cancel', wide: false,
            customButtons: [{ text: '🔄 Regenerate', result: 3, classes: ['menu_button'] }],
        };

        const result = await ctx.callGenericPopup(popupContent, ctx.POPUP_TYPE?.CONFIRM ?? 1, '', popupOpts);

        if (result === 3) {
            await showPreview(); // Regenerate
        } else if (result) {
            // Wait for generation to finish, then scale and apply
            try {
                const imageUrl = await genPromise;
                const scaled = await scaleImageTo512Square(imageUrl);
                localApply(scaled);
                toastr['success'](`Portrait applied for ${entityName}!`, 'RPG Tracker');
            } catch (err) {
                toastr['error']('Cannot apply — generation failed: ' + err.message, 'RPG Tracker');
            }
        }
    };

    await showPreview();
}

/**
 * Scans the current PARTY block in state memo for member names.
 * @returns {string[]} list of party member names
 */
export function getPartyMembers() {
    const s = getSettings();
    if (!s.currentMemo) return [];
    const blocks = parseMemoBlocks(s.currentMemo);
    const partyBlock = blocks['PARTY'];
    if (!partyBlock) return [];

    const lines = partyBlock.split('\n').map(l => l.trim()).filter(Boolean);
    const partyMembers = [];
    for (const line of lines) {
        // Match "Name: X/Y HP"
        const hpMatch = line.match(/^(.+?):\s*([\d,]+)(?:\/([\d,]+))?\s*HP/i);
        if (hpMatch) {
            partyMembers.push(hpMatch[1].trim());
        }
    }
    return partyMembers;
}

/**
 * Sequentially auto-generates and auto-applies portraits for all party members and the player character.
 * Skips those who already have portraits.
 * @param {function} refresh - callback to refresh the UI
 */
export async function autoGeneratePartyPortraits(refresh) {
    const s = getSettings();
    if (!s.currentMemo) {
        toastr['warning']('No live state memo found.', 'RPG Tracker');
        return;
    }

    const blocks = parseMemoBlocks(s.currentMemo);
    const namesSet = new Set();
    
    // Include player character (from CHARACTER block)
    const charBlock = blocks['CHARACTER'] || '';
    for (const line of charBlock.split('\n')) {
        const hpMatch = line.match(/^(.+?):\s*([\d,]+)(?:\/([\d,]+))?\s*HP/i);
        if (hpMatch) namesSet.add(hpMatch[1].trim());
    }

    // Include party members
    const partyBlock = blocks['PARTY'] || '';
    for (const line of partyBlock.split('\n')) {
        const hpMatch = line.match(/^(.+?):\s*([\d,]+)(?:\/([\d,]+))?\s*HP/i);
        if (hpMatch) namesSet.add(hpMatch[1].trim());
    }

    const partyMembers = Array.from(namesSet);
    if (partyMembers.length === 0) {
        toastr['warning']('No party members or characters found in the current state memo.', 'RPG Tracker');
        return;
    }

    // Filter out those who already have a portrait
    const toGenerate = partyMembers.filter(name => !hasPortrait(name));
    if (toGenerate.length === 0) {
        toastr['info']('All party members and characters already have portraits.', 'RPG Tracker');
        return;
    }

    toastr['info'](`Starting auto-generation for ${toGenerate.length} party members...`, 'RPG Tracker');
    let successCount = 0;

    for (const name of toGenerate) {
        toastr['info'](`Generating for ${name}...`, 'RPG Tracker');
        try {
            const prompt = await generatePortraitPrompt(name);
            const dataUrl = await generatePortraitDirect(prompt, name);
            const scaled = await scaleImageTo512Square(dataUrl);
            applyPortraitData(name, scaled);
            successCount++;
            if (typeof refresh === 'function') refresh();
        } catch (err) {
            toastr['error'](`Failed for ${name}: ${err.message}`, 'RPG Tracker');
        }
    }

    if (successCount > 0) {
        toastr['success'](`Finished! Applied ${successCount} party portraits.`, 'RPG Tracker');
    }
}

/**
 * Sequentially auto-generates and auto-applies portraits for all enemies (COMBAT block).
 * Skips enemies who already have portraits.
 * @param {function} refresh - callback to refresh the UI
 */
export async function autoGenerateEnemyPortraits(refresh) {
    const enemies = getEnemyEntities();
    if (enemies.length === 0) {
        toastr['warning']('No enemies found in the current COMBAT block.', 'RPG Tracker');
        return;
    }

    // Filter out those who already have a portrait
    const toGenerate = enemies.filter(name => !hasPortrait(name));
    if (toGenerate.length === 0) {
        toastr['info']('All enemies already have portraits.', 'RPG Tracker');
        return;
    }

    toastr['info'](`Starting auto-generation for ${toGenerate.length} enemies...`, 'RPG Tracker');
    let successCount = 0;

    for (const name of toGenerate) {
        toastr['info'](`Generating for enemy ${name}...`, 'RPG Tracker');
        try {
            const prompt = await generatePortraitPrompt(name);
            const dataUrl = await generatePortraitDirect(prompt, name);
            const scaled = await scaleImageTo512Square(dataUrl);
            applyPortraitData(name, scaled);
            successCount++;
            if (typeof refresh === 'function') refresh();
        } catch (err) {
            toastr['error'](`Failed for enemy ${name}: ${err.message}`, 'RPG Tracker');
        }
    }

    if (successCount > 0) {
        toastr['success'](`Finished! Applied ${successCount} enemy portraits.`, 'RPG Tracker');
    }
}

/**
 * Removes all custom portraits from the settings.
 * @param {function} refresh - callback to refresh the UI
 */
export function removeAllPortraits(refresh) {
    const s = getSettings();
    s.customPortraits = {};
    saveSettings();
    toastr['success']('All custom portraits removed.', 'RPG Tracker');
    if (typeof refresh === 'function') refresh();
}

// Keep track of names currently generating to avoid duplicate requests
const activeGenerations = new Set();

/**
 * Checks if a custom portrait already exists for the given entity name.
 * @param {string} name
 * @returns {boolean}
 */
export function hasPortrait(name) {
    const s = getSettings();
    return !!(s.customPortraits && s.customPortraits[name]);
}

/**
 * Scans the current COMBAT block in state memo for combatants who are not party members or characters.
 * @returns {string[]} list of enemy names
 */
export function getEnemyEntities() {
    const s = getSettings();
    if (!s.currentMemo) return [];
    const blocks = parseMemoBlocks(s.currentMemo);
    
    // Gather all party/character names to exclude
    const excludeNames = new Set();
    const partyMembers = getPartyMembers();
    for (const name of partyMembers) {
        excludeNames.add(name.toUpperCase());
    }
    
    const charBlock = blocks['CHARACTER'] || '';
    for (const line of charBlock.split('\n')) {
        const hpMatch = line.match(/^(.+?):\s*([\d,]+)(?:\/([\d,]+))?\s*HP/i);
        if (hpMatch) excludeNames.add(hpMatch[1].trim().toUpperCase());
    }

    const combatBlock = blocks['COMBAT'] || '';
    const lines = combatBlock.split('\n').map(l => l.trim()).filter(Boolean);
    const enemies = [];
    for (const line of lines) {
        if (/Combat Round\s*\d+/i.test(line)) continue;
        const hpMatch = line.match(/^(.+?):\s*([\d,]+)(?:\/([\d,]+))?\s*HP/i);
        if (hpMatch) {
            const name = hpMatch[1].trim();
            if (!excludeNames.has(name.toUpperCase())) {
                enemies.push(name);
            }
        }
    }
    return enemies;
}

/**
 * Triggers background portrait generation for a name asynchronously.
 * Does not block the main execution flow.
 * @param {string} name
 * @param {function} refresh - callback to refresh the UI on success
 */
export function triggerBackgroundPortraitGeneration(name, refresh) {
    if (hasPortrait(name)) return;
    if (activeGenerations.has(name)) return;

    activeGenerations.add(name);
    toastr['info'](`Auto-generating portrait for ${name} in background...`, 'RPG Tracker');

    (async () => {
        try {
            const prompt = await generatePortraitPrompt(name);
            if (!prompt) {
                console.warn(`[RPG Tracker] Could not generate prompt for ${name} - no context found.`);
                activeGenerations.delete(name);
                return;
            }
            const dataUrl = await generatePortraitDirect(prompt, name);
            const scaled = await scaleImageTo512Square(dataUrl);
            applyPortraitData(name, scaled);
            toastr['success'](`Portrait auto-generated and applied for ${name}!`, 'RPG Tracker');
            if (typeof refresh === 'function') refresh();
        } catch (err) {
            console.error(`[RPG Tracker] Background portrait generation failed for ${name}:`, err);
            const errMsg = String(err.message || err);
            const is524 = errMsg.includes('524') || errMsg.includes('timeout') || errMsg.includes('Upstream');
            if (is524) {
                toastr['warning'](
                    `Portrait generation for "${name}" failed: LLM connection timed out (524). The portrait prompt is written by your main LLM model — check your State Tracker connection settings and ensure it is online.`,
                    'RPG Tracker',
                    { timeOut: 8000 }
                );
            } else {
                toastr['error'](`Portrait generation failed for "${name}": ${errMsg.substring(0, 120)}`, 'RPG Tracker');
            }
        } finally {
            activeGenerations.delete(name);
        }
    })();
}

// Track entities already in the party/combat to avoid auto-generating on page refresh (F5)
const knownEntities = new Set();
let isFirstCheck = true;

/**
 * Resets the session-known tracking state.
 * Called when switching chats or starting a new session.
 */
export function resetAutoGenerationTracking() {
    knownEntities.clear();
    isFirstCheck = true;
}

/**
 * Force checks auto-generation for all active party members or enemies, bypassing the newly-added check.
 * Used when the user explicitly enables auto-generation options in the settings panel.
 * @param {function} refresh - callback to refresh the UI
 */
export function forceCheckAutoGenerations(refresh) {
    const s = getSettings();
    if (s.enablePortraits === false) return;

    if (s.portraitAutoGenerateParty) {
        const party = getPartyMembers();
        for (const name of party) {
            knownEntities.add(name.toUpperCase());
            triggerBackgroundPortraitGeneration(name, refresh);
        }
    }

    if (s.portraitAutoGenerateEnemies) {
        const enemies = getEnemyEntities();
        for (const name of enemies) {
            knownEntities.add(name.toUpperCase());
            triggerBackgroundPortraitGeneration(name, refresh);
        }
    }
}

/**
 * Checks if auto-generation is enabled and triggers it ONLY for newly added entities (not in knownEntities).
 * @param {function} refresh - callback to refresh the UI when done
 */
export function checkAndTriggerAutoGenerations(refresh) {
    const s = getSettings();
    if (s.enablePortraits === false) return;

    const currentParty = getPartyMembers();
    const currentEnemies = getEnemyEntities();

    // On initial startup/F5, record all existing entities as already known without generating anything
    if (isFirstCheck) {
        isFirstCheck = false;
        for (const name of currentParty) {
            knownEntities.add(name.toUpperCase());
        }
        for (const name of currentEnemies) {
            knownEntities.add(name.toUpperCase());
        }
        return;
    }

    if (s.portraitAutoGenerateParty) {
        for (const name of currentParty) {
            const key = name.toUpperCase();
            if (!knownEntities.has(key)) {
                knownEntities.add(key);
                triggerBackgroundPortraitGeneration(name, refresh);
            }
        }
    } else {
        // Even if auto-generate is disabled, keep track of current members so that
        // if enabled later, they aren't incorrectly flagged as "newly added"
        for (const name of currentParty) {
            knownEntities.add(name.toUpperCase());
        }
    }

    if (s.portraitAutoGenerateEnemies) {
        for (const name of currentEnemies) {
            const key = name.toUpperCase();
            if (!knownEntities.has(key)) {
                knownEntities.add(key);
                triggerBackgroundPortraitGeneration(name, refresh);
            }
        }
    } else {
        for (const name of currentEnemies) {
            knownEntities.add(name.toUpperCase());
        }
    }
}
