/**
 * narrative-hooks.js — Fatbody D&D Framework
 * RNG engine, dice tools, chat interceptor, and narrative collector.
 * This file is the primary hook into the SillyTavern chat pipeline:
 * it intercepts outgoing messages to inject context (RNG queue, state memo,
 * quests) and collects incoming AI narrative for the state model pass.
 *
 * Imports: state-manager.js
 * Imported by: index.js (registration)
 *
 * NOTE: runStateModelPass is resolved at call-time via globalThis to avoid a
 * circular import. This will be cleaned up when index.js is split.
 */

import { getSettings } from './state-manager.js';
import { parseQuestsFromMemo, extractCurrentTimeStr } from './memo-processor.js';
import { runRouterPass, saveSceneToLorebook, scanAssistantOutputForKeywords, parseInWorldMinutes, runWorldProgressionPass } from './router.js';
import { logTransaction } from './debug-viewer.js';

// ── Dice naming helpers ────────────────────────────────────────────────────────

export function getDiceToolName() {
    return 'RollTheDice';
}

export function getDiceCommandName() {
    return 'roll';
}

export function getDiceCommandAliases() {
    return ['r'];
}

// ── RNG Engine ─────────────────────────────────────────────────────────────────

export const RNG_QUEUE_LEN = 12;

export function rollDie(sides) {
    const buf = new Uint32Array(1);
    const limit = Math.floor(4294967296 / sides) * sides;
    let roll;
    do { crypto.getRandomValues(buf); roll = buf[0]; } while (roll >= limit);
    return (roll % sides) + 1;
}

export function makeRngQueue(n = RNG_QUEUE_LEN) {
    const out = [];
    for (let i = 0; i < n; i++) {
        out.push({
            d20: rollDie(20),
            d4:  rollDie(4),
            d6:  rollDie(6),
            d8:  rollDie(8),
            d10: rollDie(10),
            d12: rollDie(12),
        });
    }
    return out;
}

export function buildRngBlock(queue) {
    const turnId = Date.now();
    const formattedQueue = queue.map(dice =>
        `${dice.d20}(d4:${dice.d4},d6:${dice.d6},d8:${dice.d8},d10:${dice.d10},d12:${dice.d12})`
    ).join(", ");
    return `[RNG_QUEUE v6.0_PROPER]\nturn_id=${turnId}\nscope=this_response\nqueue=[${formattedQueue}]\n[/RNG_QUEUE]\n\n`;
}

// ── Dice rolling ───────────────────────────────────────────────────────────────

function parseAndRoll(formula) {
    const cleanFormula = formula.replace(/\s+/g, '');
    // Regex matches e.g. "2d20k1+5+2", "1d20+7", "d20-1", "2d20kh1", "2d20dl1"
    const regex = /^([1-9]\d*)?d([1-9]\d*)(?:([kd][hl]?)([1-9]\d*))?((?:[+-]\d+)*)$/i;
    const match = cleanFormula.match(regex);
    if (!match) return null;

    const numDice = match[1] ? parseInt(match[1], 10) : 1;
    const numSides = parseInt(match[2], 10);
    const opType = match[3] ? match[3].toLowerCase() : null;
    const opCount = match[4] ? parseInt(match[4], 10) : 0;
    const modifierStr = match[5] || '';

    // Safety limit to prevent locking the execution thread
    if (numDice > 100) return null;

    const rolls = [];
    for (let i = 0; i < numDice; i++) {
        rolls.push(rollDie(numSides));
    }

    let keptRolls = [...rolls];
    if (opType && opCount > 0) {
        keptRolls.sort((a, b) => a - b);
        if (opType.startsWith('k')) {
            if (opType === 'kl') {
                keptRolls = keptRolls.slice(0, opCount);
            } else {
                keptRolls = keptRolls.slice(-opCount);
            }
        } else if (opType.startsWith('d')) {
            if (opType === 'dh') {
                keptRolls = keptRolls.slice(0, Math.max(0, numDice - opCount));
            } else {
                keptRolls = keptRolls.slice(opCount);
            }
        }
    }

    let modifier = 0;
    if (modifierStr) {
        const modMatches = modifierStr.match(/[+-]\d+/g);
        if (modMatches) {
            for (const m of modMatches) {
                modifier += parseInt(m, 10);
            }
        }
    }

    const diceSum = keptRolls.reduce((sum, val) => sum + val, 0);
    const total = diceSum + modifier;

    return {
        total: String(total),
        rolls: rolls.map(String)
    };
}

export async function doDiceRoll(customDiceFormula, quiet = false) {
    const nullValue = { total: '', rolls: [] };
    let value = typeof customDiceFormula === 'string' ? customDiceFormula.trim() : '1d20';

    if (value === 'custom') {
        const { Popup } = SillyTavern.getContext();
        value = await Popup.show.input('Enter the dice formula:<br><i>(for example, <tt>2d6</tt>)</i>', '', 'Roll', { cancelButton: 'Cancel' });
    }

    if (!value) return nullValue;

    // Try custom/advanced parser first
    const customResult = parseAndRoll(value);
    if (customResult) {
        if (!quiet) {
            const context = SillyTavern.getContext();
            context.sendSystemMessage('generic', `${context.name1} rolls a ${value}. The result is: ${customResult.total} (${customResult.rolls.join(', ')})`, { isSmallSys: true });
        }
        return customResult;
    }

    // Fall back to standard droll library
    const droll = SillyTavern.libs.droll;
    if (!droll) {
        toastr['error']('Dice library (droll) not found.');
        return nullValue;
    }

    const isValid = droll.validate(value);
    if (isValid) {
        const result = droll.roll(value);
        if (!result) return nullValue;
        if (!quiet) {
            const context = SillyTavern.getContext();
            context.sendSystemMessage('generic', `${context.name1} rolls a ${value}. The result is: ${result.total} (${result.rolls.join(', ')})`, { isSmallSys: true });
        }
        return { total: String(result.total), rolls: result.rolls.map(String) };
    } else {
        toastr['warning']('Invalid dice formula');
        return nullValue;
    }
}

// ── Tool & slash command registration ─────────────────────────────────────────

export function registerDiceFunctionTool() {
    try {
        const ctx = SillyTavern.getContext();
        const { registerFunctionTool, unregisterFunctionTool } = ctx;
        if (!registerFunctionTool || !unregisterFunctionTool) return;

        unregisterFunctionTool('RollTheDice');
        unregisterFunctionTool('FatbodyRollTheDice');

        const settings = getSettings();
        if (!settings.rngEnabled || !settings.diceFunctionTool) return;

        const toolName = getDiceToolName();
        const isLegacy = settings.legacyDiceNaming;

        const rollDiceSchema = isLegacy ? {
            type: 'object',
            properties: {
                who: { type: 'string', description: 'The name of the persona rolling the dice' },
                formula: { type: 'string', description: 'A dice formula to roll, e.g. 1d6' },
            },
            required: ['who', 'formula'],
        } : {
            type: 'object',
            properties: {
                who: { type: 'string', description: 'The name of the persona rolling the dice' },
                formula: { type: 'string', description: 'A dice formula to roll, e.g. 1d20' },
                dc: { type: 'number', description: 'The Difficulty Class (DC) for this roll. Anchors the difficulty before the roll is made.' },
            },
            required: ['who', 'formula', 'dc'],
        };

        registerFunctionTool({
            name: toolName,
            displayName: isLegacy ? 'Dice Roll' : 'Dice Roll (with DC)',
            description: 'Rolls the dice using the provided formula and returns the numeric result. Use when it is necessary to roll the dice to determine the outcome of an action or when the user requests it.',
            parameters: rollDiceSchema,
            action: async (args) => {
                const formula = args?.formula || (isLegacy ? '1d6' : '1d20');
                const roll = await doDiceRoll(formula, true);
                const total = parseInt(roll.total) || 0;

                if (isLegacy) {
                    return args.who
                        ? `${args.who} rolls a ${formula}. The result is: ${total}. Individual rolls: ${roll.rolls.join(', ')}`
                        : `The result of a ${formula} roll is: ${total}. Individual rolls: ${roll.rolls.join(', ')}`;
                }

                const dc = Number(args?.dc) || 0;
                let result = args.who
                    ? `${args.who} rolls a ${formula} against DC ${dc}. The result is: ${total}. Individual rolls: ${roll.rolls.join(', ')}`
                    : `The result of a ${formula} roll against DC ${dc} is: ${total}. Individual rolls: ${roll.rolls.join(', ')}`;

                if (dc > 0) {
                    result += ` (Result: ${total >= dc ? 'SUCCESS' : 'FAILURE'})`;
                }
                return result;
            },
            formatMessage: () => '',
        });
    } catch (error) {
        console.error('[RPG Tracker] Error registering dice function tool', error);
    }
}

export function registerDiceSlashCommand() {
    const { SlashCommand, SlashCommandParser, ARGUMENT_TYPE, SlashCommandArgument, SlashCommandNamedArgument } = SillyTavern.getContext();
    if (!SlashCommand || !SlashCommandParser) return;

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: getDiceCommandName(),
        aliases: getDiceCommandAliases(),
        callback: async (args, value) => {
            const quiet = String(args.quiet) === 'true';
            const result = await doDiceRoll(String(value || (getSettings().legacyDiceNaming ? '1d6' : '1d20')), quiet);
            return result.total;
        },
        helpString: 'Roll the dice.',
        returns: 'roll result',
        namedArgumentList: [
            SlashCommandNamedArgument.fromProps({
                name: 'quiet',
                description: 'Do not display the result in chat',
                isRequired: false,
                typeList: [ARGUMENT_TYPE.BOOLEAN],
                defaultValue: 'false',
            }),
        ],
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({
                description: 'dice formula, e.g. 2d6',
                isRequired: true,
                typeList: [ARGUMENT_TYPE.STRING],
            }),
        ],
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'router',
        callback: async (args, value) => {
            const val = String(value || '').trim().toLowerCase();
            if (val.startsWith('save')) {
                const hint = val.substring(4).trim();
                await saveSceneToLorebook(hint);
                return 'Scene save requested.';
            }
            if (val === 'run' || val === 'research') {
                const { chat } = SillyTavern.getContext();
                const s = getSettings();
                const combinedNarrative = getNarrativeBlocks(chat, -1, !!s.routerIncludeHidden);
                await runRouterPass(combinedNarrative, null, null, true);
                return 'Research pass started.';
            }
            return 'Usage: /router run | /router save [hint]';
        },
        helpString: 'Interact with the Router Agent (e.g. /router save)',
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({
                description: 'command (e.g. save)',
                isRequired: true,
                typeList: [ARGUMENT_TYPE.STRING],
            }),
        ],
    }));
}

// ── stripMemoHtml (local copy — canonical version moves to renderer.js in Phase 6) ──
function stripMemoHtml(text) {
    if (!text) return text;
    let stripped = text.replace(/<br\s*\/?>/gi, '\n');
    stripped = stripped.replace(/<[^>]+>/g, '');
    return stripped;
}

// ── Chat interceptor (registered on globalThis for ST manifest hook) ───────────

/**
 * Extracts the text content from a chat message regardless of format.
 * Chat Completion messages may store content as a string or as an array of
 * content parts (e.g. [{type:'text', text:'...'}] for multimodal presets).
 * Text Completion (legacy) messages use `mes` instead of `content`.
 */
function extractTextContent(msg) {
    const raw = msg['content'] ?? msg.mes ?? '';
    if (typeof raw === 'string') return raw;
    if (Array.isArray(raw)) {
        return raw.filter(p => p && p.type === 'text').map(p => p.text || '').join('\n');
    }
    return String(raw);
}

export function installInterceptor() {
    globalThis.rpgTrackerInterceptor = async function (chat, contextSize, abort, type) {
        const settings = getSettings();

        // When addPromptManagerInterceptor (Path 1) is active, we do NOT inject anything
        // into the user message — that would break prefix-cache protection.
        // However, we MUST still run the keyword pre-scan so that newly triggered entries
        // are added to activeRouterKeys before Path 1 reads it to build the API payload.
        // Path 1 fires after this interceptor in the ST pipeline, so a scan here = same-turn lore.
        const skipInjection = !!globalThis._rpgPromptManagerInterceptorActive;

        if (settings.debugMode) {
            console.group("[RPG Tracker] Interceptor Triggered");
            console.log("Settings Enabled:", settings.enabled);
            console.log("RNG Enabled:", settings.rngEnabled);
            console.log("Payload Chat Type:", Array.isArray(chat) ? 'Array' : typeof chat);
            console.log("Chat Length:", Array.isArray(chat) ? chat.length : 'N/A');
        }

        if (!settings.enabled) {
            if (settings.debugMode) console.groupEnd();
            return;
        }

        if (!Array.isArray(chat)) {
            if (settings.debugMode) {
                console.log("Chat is not an array. Interceptor bailing out.");
                console.groupEnd();
            }
            return;
        }

        // Strip RT_CUSTOM_LIBRARY comment markers from all messages before sending to AI.
        // These markers exist in the textarea for idempotent re-injection management,
        // but should be invisible to the model to avoid skewing attention weights.
        const rtCommentRe = /^[ \t]*<!--\s*RT_CUSTOM_LIBRARY_(START|END)\s*-->[ \t]*\r?\n?/gm;
        for (const m of chat) {
            if (typeof m.content === 'string') {
                m.content = m.content.replace(rtCommentRe, '');
            } else if (Array.isArray(m.content)) {
                for (const part of m.content) {
                    if (part && typeof part.text === 'string') {
                        part.text = part.text.replace(rtCommentRe, '');
                    }
                }
            }
            if (typeof m.mes === 'string') {
                m.mes = m.mes.replace(rtCommentRe, '');
            }
        }

        let idx = -1;
        
        // 1. Check for explicit user roles (case insensitive) or ST internal flag
        for (let i = chat.length - 1; i >= 0; i--) {
            if (settings.debugMode) console.log(`Checking message ${i}: role=${chat[i]?.role}, is_user=${chat[i]?.is_user}`);
            const role = String(chat[i]?.role || chat[i]?.Role || '').toLowerCase().trim();
            if (chat[i]?.is_user || role === 'user' || role === 'human' || role === 'player') {
                idx = i;
                break;
            }
        }
        
        // 2. Fallback: Find the last message that isn't from the system or assistant
        if (idx === -1) {
            for (let i = chat.length - 1; i >= 0; i--) {
                const role = String(chat[i]?.role || chat[i]?.Role || '').toLowerCase().trim();
                if (role && role !== 'system' && role !== 'assistant' && role !== 'ai' && role !== 'model') {
                    idx = i;
                    break;
                }
            }
        }
        
        // 3. Absolute desperation fallback: grab the very last message in the array
        if (idx === -1 && chat.length > 0) {
            idx = chat.length - 1;
        }
        
        if (idx === -1) {
            if (settings.debugMode) {
                console.log("No user message found in chat array. Interceptor bailing out.");
                console.groupEnd();
            }
            return;
        }

        const msg = chat[idx];
        const content = extractTextContent(msg);
        let injections = "";     // core: RNG Queue + State Memo + Quests (always → user msg)
        let loreInjections = ""; // lore: keyword/agent entries (configurable depth)
        let wpInjections = "";   // world progression reports (configurable depth)
        
        if (settings.debugMode) {
            console.log(`Found user message at index ${idx}.`);
            console.log(`Extracted Text Content Length: ${content.length}`);
            console.log(`Content includes RNG tag? ${content.includes("[RNG_QUEUE v6.0_PROPER]")}`);
            if (skipInjection) console.log("[RPG Tracker] Path 1 active: skipping user-message injection; keyword scan will still run.");
        }

        // RNG, State Memo, and Quests are only injected into the user message in Path 2.
        // In Path 1 (addPromptManagerInterceptor), these are built and injected by that interceptor
        // into a dedicated system message at the configured depth, protecting the prefix cache.
        if (!skipInjection) {
            if (settings.rngEnabled && !content.includes("[RNG_QUEUE v6.0_PROPER]")) {
                const queue = makeRngQueue(RNG_QUEUE_LEN);
                injections += buildRngBlock(queue);
                if (settings.debugMode) console.log("RNG Queue generated for injection.");
            }

            if (settings.currentMemo && !content.includes("### STATE MEMO (DO NOT REPEAT)")) {
                // Strip the JSON [QUESTS] block from the narrative context to save tokens and avoid redundancy
                const memoText = stripMemoHtml(settings.currentMemo).replace(/\[QUESTS\][\s\S]*?\[\/QUESTS\]/gi, '').trim();
                injections += `### STATE MEMO (DO NOT REPEAT)\n${memoText}\n\n`;
            }

            // Quest deadline check — fires before state model pass, deterministically
            if (settings.modules?.quests) {
                const memoQuests = parseQuestsFromMemo(settings.currentMemo);
                if (memoQuests.length) {
                    const { checkQuestDeadlines, renderQuestsAsPlainText } = await import('./quests.js');
                    checkQuestDeadlines();

                    // Inject active quests as plain text into narrative context
                    const timeMatch = (settings.currentMemo || '').match(/\[TIME\]([\s\S]*?)\[\/TIME\]/i);
                    const currentTime = timeMatch ? extractCurrentTimeStr(timeMatch[1]) : '';
                    // Re-parse after checkQuestDeadlines may have mutated the memo
                    const freshQuests = parseQuestsFromMemo(settings.currentMemo);
                    const questText = renderQuestsAsPlainText(freshQuests, currentTime);
                    if (questText) injections += questText;
                }
            }
        }



        // Pre-generation keyword scan.
        // This interceptor (manifest generate_interceptor) fires BEFORE addPromptManagerInterceptor
        // in the ST pipeline. Running the keyword scan here ensures that any entries activated by
        // the current user message land in activeRouterKeys before Path 1 reads it.
        //
        // In Path 1 (skipInjection=true): scan runs, activeRouterKeys is updated, text building
        //   is skipped. Path 1 will pick up all activeRouterKeys (including newly triggered ones)
        //   and inject them as a single system message at the configured depth.
        //
        // In Path 2 (skipInjection=false): scan runs and we also build lore text and inject it
        //   directly into the user message (legacy path for old ST builds).
        //
        // Skipped entirely when routerNativeKeywordActivation is enabled (ST handles keywords).
        if (settings.routerEnabled && !settings.routerNativeKeywordActivation) {
            if (content) {
                const t0 = performance.now().toFixed(1);
                console.group(`[RPG|INTERCEPT] rpgTrackerInterceptor keyword pre-scan @ ${t0}ms`);
                console.log('skipInjection (Path 1 active):', skipInjection);
                console.log('activeRouterKeys BEFORE scan:', JSON.stringify(settings.activeRouterKeys || []));
                const triggered = await scanAssistantOutputForKeywords(content, { sweepEnabled: false }).catch(() => []);
                console.log('activeRouterKeys AFTER scan:', JSON.stringify(settings.activeRouterKeys || []));
                console.log('newly triggered this scan:', triggered);
                console.log(`scan finished @ ${performance.now().toFixed(1)}ms`);

                // Trigger UI refresh so the Agent Panel updates immediately with yellow pills
                if (triggered.length > 0 && typeof globalThis._rpgRenderRouterUI === 'function') {
                    globalThis._rpgRenderRouterUI();
                }

                // In Path 1, the scan above already updated activeRouterKeys.
                // Path 1's addPromptManagerInterceptor will read activeRouterKeys and inject
                // all entries (including the newly triggered ones) at the configured depth.
                // No text building or user-message mutation needed here.
                if (!skipInjection) {
                    // Path 2: build lore text to inject directly into the user message.
                    if (triggered.length > 0) {
                        try {
                            const ctx = SillyTavern.getContext();
                            let loreBlock = '';
                            const bookCache = {};
                            for (const id of triggered) {
                                const [bookName, uid] = id.split('::');
                                if (!bookCache[bookName]) bookCache[bookName] = await ctx.loadWorldInfo(bookName);
                                const entry = bookCache[bookName]?.entries?.[uid];
                                if (entry?.content) {
                                    loreBlock += `### [${entry.key?.[0] || entry.comment || uid}]\n${entry.content}\n\n`;
                                }
                            }
                            if (loreBlock) {
                                loreInjections += `\n<font color="#d4a028">## NEWLY ACTIVATED LORE (KEYWORD MATCH)</font>\n${loreBlock.trim()}\n`;
                                console.log(`[RPG|INTERCEPT] Same-turn lore injected for ${triggered.length} entries.`);
                            }
                        } catch (e) {
                            console.warn('[RPG Tracker] Same-turn lore injection failed:', e);
                        }
                    }

                    // Persistent keyword-activated entries
                    const triggeredSet = new Set(triggered);
                    const persistent = (settings.keywordActivatedKeys || []).filter(id => !triggeredSet.has(id));
                    if (persistent.length > 0) {
                        try {
                            const ctx = SillyTavern.getContext();
                            let persistBlock = '';
                            const bookCache = {};
                            for (const id of persistent) {
                                const [bookName, uid] = id.split('::');
                                if (!bookCache[bookName]) bookCache[bookName] = await ctx.loadWorldInfo(bookName);
                                const entry = bookCache[bookName]?.entries?.[uid];
                                if (entry?.content) {
                                    persistBlock += `### [${entry.key?.[0] || entry.comment || uid}]\n${entry.content}\n\n`;
                                }
                            }
                            if (persistBlock) {
                                loreInjections += `\n<font color="#d4a028">## ACTIVE LORE (KEYWORD)</font>\n${persistBlock.trim()}\n`;
                            }
                        } catch (e) {
                            console.warn('[RPG Tracker] Persistent keyword lore re-injection failed:', e);
                        }
                    }

                    // Agent-owned entries (not keyword-triggered)
                    const alreadyInjected = new Set([...triggered, ...(settings.keywordActivatedKeys || [])]);
                    const agentOwned = (settings.activeRouterKeys || [])
                        .filter(id => !alreadyInjected.has(id))
                        .filter(id => {
                            const [bookName] = id.split('::');
                            const isWorld = bookName.toLowerCase().endsWith('_world') || bookName.toLowerCase() === 'world';
                            return !isWorld;
                        });
                    if (agentOwned.length > 0) {
                        try {
                            const ctx = SillyTavern.getContext();
                            let agentBlock = '';
                            const bookCache = {};
                            for (const id of agentOwned) {
                                const [bookName, uid] = id.split('::');
                                if (!bookCache[bookName]) bookCache[bookName] = await ctx.loadWorldInfo(bookName);
                                const entry = bookCache[bookName]?.entries?.[uid];
                                if (entry?.content) {
                                    agentBlock += `### [${entry.key?.[0] || entry.comment || uid}]\n${entry.content}\n\n`;
                                }
                            }
                            if (agentBlock) {
                                loreInjections += `\n## ACTIVE LORE (AGENT)\n${agentBlock.trim()}\n`;
                            }
                        } catch (e) {
                            console.warn('[RPG Tracker] Agent-owned lore injection failed:', e);
                        }
                    }

                // World Progression reports injection
                if (settings.worldProgressionEnabled && (settings.activeWorldKeys || []).length > 0) {
                    try {
                        const ctx = SillyTavern.getContext();
                        let worldBlock = '';
                        const bookCache = {};
                        const sortedKeys = [...settings.activeWorldKeys].sort((a, b) => {
                            const [, uidA] = a.split('::');
                            const [, uidB] = b.split('::');
                            return Number(uidA) - Number(uidB);
                        });
                        for (const id of sortedKeys) {
                            const [bookName, uid] = id.split('::');
                            if (!bookCache[bookName]) bookCache[bookName] = await ctx.loadWorldInfo(bookName);
                            const entry = bookCache[bookName]?.entries?.[uid];
                            if (entry?.content) {
                                worldBlock += `### [${entry.key?.[0] || entry.comment || 'World Report'}]\n${entry.content}\n\n`;
                            }
                        }
                        if (worldBlock) {
                            wpInjections = `\n## WORLD PROGRESSION REPORTS\n${worldBlock.trim()}\n`;
                        }
                    } catch (e) {
                        console.warn('[RPG Tracker] World progression injection failed:', e);
                    }
                }
            }

            console.groupEnd();
        }
    }

        if (settings.debugMode) console.groupEnd();

        if (skipInjection || (!injections && !loreInjections && !wpInjections)) return;

        // ── Injection dispatch ───────────────────────────────────────────────────
        //
        // Two independent streams:
        //
        //  1. CORE (injections): RNG Queue + State Memo + Quests
        //     Always prepended directly into the last user message.
        //     These are turn-critical operative data the model must act on NOW.
        //     Maximum salience — the model's attention is highest on its most
        //     recent input tokens.
        //
        //  2. LORE (loreInjections): Keyword Lore + Agent Lore
        //     Depth-configurable via routerDefaultPosition / routerDefaultDepth.
        //     When position === 4 ("at Depth"): spliced as a dedicated system
        //     message at the configured depth before the user message.
        //     Otherwise: folded into the user message with the core block
        //     (original legacy behaviour, equivalent salience).
        //
        // Cache note: both streams land in the dynamic tail of the context
        // (message[N-1] or adjacent). The prefix cache break point is identical
        // regardless of which stream carries which content.

        const useDepthInjection = settings.loreInjectionPosition === 4;
        const useWpDepthInjection = settings.worldProgressionInjectionPosition === 4;

        // When not using depth injection, fold lore/world progression into the core block so that
        // the user message receives one cohesive injection (original behaviour).
        let coreBlock = injections;
        if (!useDepthInjection && loreInjections) {
            coreBlock += loreInjections;
        }
        if (!useWpDepthInjection && wpInjections) {
            coreBlock += wpInjections;
        }

        // ── 1. Core injection → always into user message ─────────────────────────
        if (coreBlock) {
            const originalContent = extractTextContent(msg).trim();
            const displayContent = originalContent ? originalContent : "[Continue the narrative]";
            const userHeader = `\n### CURRENT USER INPUT\n${displayContent}\n`;

            if (typeof msg.content === 'string') {
                msg.content = coreBlock + userHeader;
                if (settings.debugMode) console.log("[Fatbody Framework] Core injection prepended to string msg.content");
            } else if (Array.isArray(msg.content)) {
                const nonTextParts = msg.content.filter(p => p && p.type !== 'text');
                msg.content = [
                    { type: 'text', text: coreBlock + userHeader },
                    ...nonTextParts
                ];
                if (settings.debugMode) console.log("[Fatbody Framework] Core injection prepended to array msg.content");
            } else if (typeof msg.mes === 'string') {
                msg.mes = coreBlock + userHeader;
                if (settings.debugMode) console.log("[Fatbody Framework] Core injection prepended to msg.mes");
            } else {
                if (settings.debugMode) console.log("[Fatbody Framework] Core injection failed — unknown msg structure:", Object.keys(msg));
            }

            if (settings.debugMode) {
                const label = (!useDepthInjection && loreInjections) ? 'Core+Lore (User Msg)' : 'Core (User Msg)';
                logTransaction(label, [{ role: 'user', content: coreBlock }]);
            }
        }

        // ── 2. Lore injection → configurable depth ───────────────────────────────
        // The `chat` array here is SillyTavern's internal format (.mes / .is_user /
        // .name / .extra). Setting extra.type = 'narrator' maps to role:'system'
        // when setOpenAIMessages() converts it to API format.
        if (useDepthInjection && loreInjections) {
            const depth = settings.loreInjectionDepth ?? 4;
            const insertIdx = Math.max(0, chat.length - depth);
            const roleVal = settings.loreInjectionRole ?? 0;
            const loreMessage = {
                name: 'RPG Framework',
                mes: loreInjections,
                is_user: roleVal === 1,
                extra: roleVal === 0 ? { type: 'narrator' } : {},
            };
            chat.splice(insertIdx, 0, loreMessage);
            if (settings.debugMode) {
                console.log(`[Fatbody Framework] Lore depth injection: spliced at index ${insertIdx} (depth ${depth}), chat now ${chat.length} messages.`);
                const roleName = roleVal === 1 ? 'user' : roleVal === 2 ? 'assistant' : 'system';
                logTransaction('Lore (Depth Splice)', [{ role: roleName, content: loreInjections }]);
            }
        }

        // ── 3. World Progression injection → configurable depth ──────────────────
        if (useWpDepthInjection && wpInjections) {
            const wpDepth = settings.worldProgressionInjectionDepth ?? 4;
            const insertIdx = Math.max(0, chat.length - wpDepth);
            const wpRoleVal = settings.worldProgressionInjectionRole ?? 0;
            const wpMessage = {
                name: 'World Progression',
                mes: wpInjections,
                is_user: wpRoleVal === 1,
                extra: wpRoleVal === 0 ? { type: 'narrator' } : {},
            };
            chat.splice(insertIdx, 0, wpMessage);
            if (settings.debugMode) {
                console.log(`[Fatbody Framework] World Progression depth injection: spliced at index ${insertIdx} (depth ${wpDepth}), chat now ${chat.length} messages.`);
                const roleName = wpRoleVal === 1 ? 'user' : wpRoleVal === 2 ? 'assistant' : 'system';
                logTransaction('World Progression (Depth Splice)', [{ role: roleName, content: wpInjections }]);
            }
        }
    };
}


// ── Narrative collector ────────────────────────────────────────────────────────

/**
 * Collects AI narrative blocks from the chat array.
 * @param {any[]} chat
 * @param {number} limit  -1 = all since last user message; N = collect N blocks
 */
export function getNarrativeBlocks(chat, limit = -1, includeHidden = false) {
    if (!chat || chat.length === 0) return "";
    let narrativeBlocks = [];
    let foundCount = 0;

    for (let i = chat.length - 1; i >= 0; i--) {
        const msg = chat[i];
        if (limit === -1 && msg.is_user) break;
        if (limit !== -1 && foundCount >= limit) break;
        if (msg.is_system) continue;
        if (!includeHidden && /** @type {any} */ (msg).is_hidden) continue;

        let mes = (msg.mes || '').trim();
        if (!mes) continue;
        if (mes.startsWith('[Summary') || mes.startsWith('(Summary') || mes.includes('Summary of past events:')) continue;
        if (msg.extra?.['summary'] || msg.extra?.['is_summary'] || msg.extra?.['summary_data']) continue;

        // Strip tool call & thinking UI (XML-tag variants)
        mes = mes.replace(/<details\b[^>]*>([\s\S]*?)<\/details>/gi, '');
        mes = mes.replace(/<pre\b[^>]*>([\s\S]*?)<\/pre>/gi, '');
        mes = mes.replace(/<thought\b[^>]*>([\s\S]*?)<\/thought>/gi, '');
        mes = mes.replace(/<thinking\b[^>]*>([\s\S]*?)<\/thinking>/gi, '');
        mes = mes.replace(/<reasoning\b[^>]*>([\s\S]*?)<\/reasoning>/gi, '');
        // <think> tags used by DeepSeek, Qwen, etc.
        mes = mes.replace(/<think\b[^>]*>([\s\S]*?)<\/think>/gi, '');

        // If ST stored reasoning in extra.reasoning and it bled into mes, strip it
        const extraReasoning = /** @type {any} */ (msg).extra?.reasoning;
        if (extraReasoning && typeof extraReasoning === 'string' && mes.includes(extraReasoning)) {
            mes = mes.replace(extraReasoning, '');
        }

        mes = mes.trim();

        if (mes) { narrativeBlocks.unshift(mes); foundCount++; }
    }
    return narrativeBlocks.join('\n\n');
}

// ── Generation-ended handler ───────────────────────────────────────────────────

/** Tracks the type of the last started generation. */
let _lastGenerationType = null;

/**
 * Fires on GENERATION_STARTED. Stores the type of generation.
 * @param {string} type
 */
export function onGenerationStarted(type) {
    _lastGenerationType = type;
}

/** In-memory counter: how many generations have fired since the agent last ran. Resets on chat change. */
let _routerAutoTick = 0;

/** In-memory counter: how many generations have fired since the state tracker last ran. */
let _stateTrackerAutoTick = 0;

/**
 * Accumulates keyword-triggered entry IDs across throttled generations so the
 * agent receives the full set (not just the current turn) when it finally fires.
 * Reset whenever the agent runs or the chat changes.
 */
let _pendingKeywordTriggered = [];

/** Call this whenever the active chat changes so the interval counter and accumulator restart.
 * @param {boolean} [clearKeywordPool] - Pass true only when actually switching to a different chat.
 */
export function resetRouterTick(clearKeywordPool = false) {
    _routerAutoTick = 0;
    _stateTrackerAutoTick = 0;
    _pendingKeywordTriggered = [];
    // Keyword-activated entries are transient (they expire when the keyword leaves the scan window).
    // Only clear on a real chat change, not on same-chat reloads (swipe, regenerate).
    if (clearKeywordPool) {
        const s = getSettings();
        if (s.keywordActivatedKeys?.length) {
            s.keywordActivatedKeys = [];
        }
    }
}

/**
 * Fires on GENERATION_ENDED. Triggers the state model pass.
 * runStateModelPass is resolved via the module import below to avoid
 * a hard circular dep — it will be a direct import once memo-processor.js exists.
 */
export async function onGenerationEnded() {
    const settings = getSettings();
    const isStateRunning = typeof globalThis._rpgStateModelRunning === 'function' && globalThis._rpgStateModelRunning();
    if (!settings.enabled || settings.paused || isStateRunning) return;

    // Check if the generation was for Impersonation or Quiet tasks.
    // In these cases, the chat history did not actually change.
    const currentType = _lastGenerationType;
    // Reset the tracker after a timeout (next tick) to handle synchronous multi-event triggers (e.g. ENDED + STOPPED)
    setTimeout(() => {
        _lastGenerationType = null;
    }, 0);

    if (currentType === 'impersonate' || currentType === 'quiet') {
        if (settings.debugMode) {
            console.log(`[RPG Tracker] Skipping State Tracker and Researcher passes for generation type: ${currentType}`);
        }
        return;
    }

    const { chat } = SillyTavern.getContext();
    const combinedNarrative = getNarrativeBlocks(chat, -1, !!settings.routerIncludeHidden);
    if (!combinedNarrative) return;

    if (settings.debugMode) console.log("[RPG Tracker] Assistant generation ended. Running keyword scanner...");

    // Step 1: Scan assistant output for entry keywords and activate matches immediately.
    // Must run before the state model pass and on EVERY generation, regardless of throttle,
    // so entries are never one turn behind the narrator even when the agent is skipped.
    // Skipped when routerNativeKeywordActivation is enabled (native ST system handles keywords).
    if (settings.routerEnabled && !settings.routerNativeKeywordActivation) {
        const thisGenTriggered = await scanAssistantOutputForKeywords(combinedNarrative);
        if (thisGenTriggered.length > 0) {
            // Accumulate across throttled turns — deduplicate so IDs are not repeated.
            const accumulated = new Set([..._pendingKeywordTriggered, ...thisGenTriggered]);
            _pendingKeywordTriggered = [...accumulated];
            if (settings.debugMode) {
                console.log("[RPG Tracker] Keyword scanner activated entries:", thisGenTriggered, "| Pending total:", _pendingKeywordTriggered.length);
            }

            // Trigger UI refresh
            if (typeof globalThis._rpgRenderRouterUI === 'function') {
                globalThis._rpgRenderRouterUI();
            }
        }
    }

    // Step 2: State Tracker pass — throttled by stateTrackerRunEvery.
    const stateRunEvery = settings.stateTrackerRunEvery || 1;
    _stateTrackerAutoTick++;
    if (_stateTrackerAutoTick >= stateRunEvery) {
        _stateTrackerAutoTick = 0;
        if (settings.debugMode) console.log("[RPG Tracker] Triggering State Model pass...", combinedNarrative);
        if (typeof globalThis._rpgRunStateModelPass === 'function') {
            await globalThis._rpgRunStateModelPass(combinedNarrative);
        }
    } else {
        if (settings.debugMode) console.log(`[RPG Tracker] State Tracker skipped (tick ${_stateTrackerAutoTick}/${stateRunEvery}).`);
    }

    // Step 3: World Progression deterministic check — runs AFTER the State Tracker has updated
    // currentMemo, so the [TIME] block reflects the current in-world clock.
    await maybeRunWorldProgression();

    // Step 4: Run-every throttle — only fire the Lorebook Agent every N auto-generations.
    _routerAutoTick++;
    const runEvery = settings.routerRunEvery || 1;
    if (_routerAutoTick < runEvery) return;
    _routerAutoTick = 0;

    // Step 5: Lorebook Agent pass — passes the full accumulated set of keyword-triggered IDs
    // from all throttled turns since the last agent run (not just the current generation).
    const triggeredForAgent = [..._pendingKeywordTriggered];
    _pendingKeywordTriggered = []; // reset accumulator now that the agent is about to process them
    await runRouterPass(combinedNarrative, null, null, false, triggeredForAgent);
}

// ── World Progression deterministic trigger ─────────────────────────────────────────

/**
 * Checks whether the World Progression system should fire based on the in-world clock
 * stored in settings.currentMemo. Fires at most once per interval, never twice for the
 * same period. Called after every State Tracker pass.
 */
async function maybeRunWorldProgression() {
    const settings = getSettings();
    if (!settings.worldProgressionEnabled || !settings.routerEnabled) return;
    if (!settings.currentMemo) return;

    // Extract time string from the [TIME] block
    const timeMatch = settings.currentMemo.match(/\[TIME\]([\s\S]*?)\[\/TIME\]/i);
    const timeStr = timeMatch ? extractCurrentTimeStr(timeMatch[1]) : '';
    const currentMinutes = parseInWorldMinutes(timeStr);
    if (currentMinutes < 0) return; // can't parse time → skip

    const lastFired = settings.worldProgressionLastFiredAtMinutes ?? -1;
    const intervalMinutes = (settings.worldProgressionIntervalHours || 24) * 60;

    // On first-ever firing: don't fire unless we've actually passed at least one full interval.
    // This prevents a spurious Day 0 report on the very first turn of a brand-new campaign.
    if (lastFired < 0 && currentMinutes < intervalMinutes) return;

    const elapsed = lastFired < 0 ? intervalMinutes : currentMinutes - lastFired;
    if (elapsed < intervalMinutes) return;

    // Guard: don't start a World Progression pass while the Lorebook Agent is already running
    const { isRouterRunning } = await import('./router.js');
    if (isRouterRunning()) return;

    await runWorldProgressionPass(timeStr, currentMinutes);
}
