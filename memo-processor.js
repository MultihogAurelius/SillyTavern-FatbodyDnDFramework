/**
 * memo-processor.js — Multihog D&D Framework
 * Pure text/logic utilities for memo management and state model context assembly.
 * Handles [TAG]...[/TAG] block merging, deduplication, delta computation,
 * lorebook assembly, and quest text serialization.
 * No DOM access. No module-level side effects.
 *
 * Imports: state-manager.js, constants.js
 * Imported by: index.js, renderer.js, quests.js
 */

import { getSettings } from './state-manager.js';
import { DEFAULT_STOCK_PROMPTS } from './constants.js';

// ── String utilities ──────────────────────────────────────────────────────────

/**
 * Computes NPC mood from -1.0 (very pleased) to 1.0+ (very frustrated).
 * Duplicated here from quests.js to avoid a circular import.
 * @param {object} quest
 * @param {string} currentTime
 * @returns {number}
 */
function computeFrustrationLocal(quest, currentTime) {
    if (!quest.deadline_time || !quest.accepted_time || quest.deadline_time.toLowerCase() === 'none') return -1;
    const coeff = (quest.frustration_coefficient != null) ? quest.frustration_coefficient : 1.0;
    const acceptedMins  = parseInWorldTime(quest.accepted_time);
    const deadlineMins  = parseInWorldTime(quest.deadline_time);
    const currentMins   = parseInWorldTime(currentTime);
    if (!acceptedMins || !deadlineMins || !currentMins) return 0;
    const total = deadlineMins - acceptedMins;
    if (total <= 0) return 0;
    const ratio = (currentMins - acceptedMins) / total;
    if (ratio <= 1) {
        return ratio - 1; // pre-deadline: -1 → 0
    } else {
        return (ratio - 1) * coeff; // post-deadline: 0 → positive
    }
}

/**
 * Returns the human-readable mood label and color for a quest.
 * @param {object} quest
 * @param {string} currentTime
 * @param {boolean} showFrustration
 * @returns {{ label: string, color: string, value: number }}
 */
export function getQuestMood(quest, currentTime, showFrustration) {
    const frust = computeFrustrationLocal(quest, currentTime);
    let color = '#00cc77';
    let label = 'Pleased';
    if (showFrustration) {
        if (frust <= -0.5)      { color = '#00cc77'; label = 'Very Pleased'; }
        else if (frust <= -0.1) { color = '#44dd88'; label = 'Pleased'; }
        else if (frust <=  0.1) { color = '#aaaaaa'; label = 'Neutral'; }
        else if (frust <=  0.5) { color = '#ffcc00'; label = 'Mildly Frustrated'; }
        else if (frust <=  1.0) { color = '#ff8800'; label = 'Frustrated'; }
        else if (frust <=  1.5) { color = '#ff4400'; label = 'Very Frustrated'; }
        else                    { color = '#ff1111'; label = 'Furious'; }
    } else {
        if (frust <= 0)         { color = '#00cc77'; label = 'Ahead of Schedule'; }
        else if (frust <= 0.5)  { color = '#ffcc00'; label = 'On Time'; }
        else if (frust <= 1.0)  { color = '#ff8800'; label = 'Near Deadline'; }
        else                    { color = '#ff1111'; label = 'Overdue'; }
    }
    return { label, color, value: frust };
}

export function escapeRegex(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function escapeHtml(str) {
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Wraps parenthetical groups in a highlight span. */
export function highlightParens(text) {
    return text.replace(/\(([^)]+)\)/g, '<span class="rt-paren-highlight">($1)</span>');
}

/** Wraps signed numbers or standalone digits in a highlight span, ignoring HTML tags. */
export function highlightNumbers(text) {
    return text.replace(/(<[^>]+>)|([+-]\d+|\b\d+\b)/g, (match, tag, num) => {
        return tag ? tag : `<span class="rt-paren-highlight">${num}</span>`;
    });
}


/**
 * Extracts the current time string from a [TIME] block content.
 * Ignores any 'Last Rest:' lines and strips optional 'Current Time:' prefixes.
 * @param {string} timeBlockContent
 * @returns {string}
 */
export function extractCurrentTimeStr(timeBlockContent) {
    if (!timeBlockContent) return '';
    const lines = timeBlockContent.split('\n').map(l => l.trim()).filter(Boolean);
    const timeLine = lines.find(line => !line.toLowerCase().startsWith('last rest:'));
    if (!timeLine) return '';
    return timeLine.replace(/^(?:current\s+)?time:\s*/i, '').trim();
}

/**
 * Converts in-world time strings to a comparable numeric value (minutes since Day 1, 00:00).
 * Expected formats: "08:00 AM, Day 1", "Day 4", "10:00 PM"
 * @param {string} str 
 * @returns {number}
 */
export function parseInWorldTime(str) {
    if (!str) return 0;
    if (str.includes('\n')) {
        str = extractCurrentTimeStr(str);
    }
    const dayMatch = str.match(/(?:Day|D)\s*(\d+)/i);
    const timeMatch = str.match(/(\d{1,2}):(\d{2})\s*(AM|PM)?/i);
    
    let d = dayMatch ? parseInt(dayMatch[1], 10) : 1;
    let h = 0, m = 0;
    
    if (timeMatch) {
        h = parseInt(timeMatch[1], 10);
        m = parseInt(timeMatch[2], 10);
        if (timeMatch[3]) {
            const mer = timeMatch[3].toUpperCase();
            if (mer === 'AM' && h === 12) h = 0;
            if (mer === 'PM' && h !== 12) h += 12;
        }
    }
    
    if (!dayMatch && !timeMatch) return 0;
    return (d - 1) * 1440 + h * 60 + m;
}


/**
 * Formats a minute difference into a human-readable "X days Y hours Z minutes" string.
 * @param {number} diffMinutes 
 * @param {boolean} isFuture - If true, returns "X left", else "X ago"
 * @returns {string}
 */
export function formatTimeDiff(diffMinutes, isFuture = false) {
    if (diffMinutes === 0) return isFuture ? "due now" : "just now";
    const absDiff = Math.abs(diffMinutes);
    const dDays = Math.floor(absDiff / 1440);
    const dH = Math.floor((absDiff % 1440) / 60);
    const dM = absDiff % 60;
    
    let parts = [];
    if (dDays > 0) parts.push(`${dDays} day${dDays > 1 ? 's' : ''}`);
    if (dH > 0) parts.push(`${dH} hour${dH > 1 ? 's' : ''}`);
    if (dM > 0) parts.push(`${dM} minute${dM > 1 ? 's' : ''}`);
    
    if (parts.length === 0) return isFuture ? "due now" : "just now";
    
    const timeStr = parts.join(' ');
    return isFuture ? `${timeStr} left` : `${timeStr} ago`;
}

// ── Memo deduplication ────────────────────────────────────────────────────────

/**
 * Sanitizes a memo string to ensure no duplicate [TAG] sections exist.
 * If duplicates are found, the last one in the string is preserved.
 */
export function deduplicateMemo(memo) {
    if (!memo) return "";
    const settings = getSettings();

    const tagRegex = /\[([A-Z_]+)\]/gi;
    const tags = new Set();
    let match;
    while ((match = tagRegex.exec(memo)) !== null) {
        tags.add(match[1].toUpperCase());
    }

    let cleanedMemo = memo;
    for (const tag of tags) {
        const escapedTag = escapeRegex(tag);
        const pattern = new RegExp(`\\[${escapedTag}\\][\\s\\S]*?\\[\\/${escapedTag}\\]`, 'gi');
        const blocks = [...memo.matchAll(pattern)];

        if (blocks.length > 1) {
            if (settings.debugMode) console.warn(`[RPG Tracker] Deduplication: Found ${blocks.length} instances of [${tag}]. Keeping the last one.`);
            cleanedMemo = cleanedMemo.replace(pattern, "---DEDUP_MARKER---");
            const lastBlock = blocks[blocks.length - 1][0];
            const split = cleanedMemo.split("---DEDUP_MARKER---");
            cleanedMemo = split.join("").trim() + "\n\n" + lastBlock;
        }
    }

    return cleanedMemo.replace(/\n{3,}/g, '\n\n').trim();
}

// ── Memo merge ────────────────────────────────────────────────────────────────

/**
 * Merge partial AI output into the existing memo.
 * Finds all [TAG]...[/TAG] blocks in the AI output and replaces the
 * matching section in the current memo. New sections are appended.
 * If the AI output contains no bracket tags at all, the current memo is preserved.
 */
export function mergeMemo(currentMemo, aiOutput) {
    const settings = getSettings();

    const tagPattern = /\[([^\]\/][^\]]*)\]([\s\S]*?)\[\/\1\]/gi;
    const matches = [...aiOutput.matchAll(tagPattern)];

    if (matches.length === 0) {
        console.warn("[RPG Tracker] No valid [TAG]...[/TAG] blocks found in model output — treating as no-change. Output was:", aiOutput);
        return currentMemo;
    }

    if (settings.debugMode) console.log(`[RPG Tracker] mergeMemo: found ${matches.length} tag(s):`, matches.map(m => m[1]));

    let memo = currentMemo;

    for (const match of matches) {
        const tag = match[1].trim();
        const newContent = match[2].trim();

        // [QUESTS] block — route to appropriate handler based on mode
        if (tag.toUpperCase() === 'QUESTS') {
            const s = getSettings();
            if (s.questLegacyMode) {
                // Legacy: state model wrote the full text block.
                // Let the standard replacement logic below integrate it into the memo string.
                // The memo text is the single source of truth — no separate settings.quests needed.
            } else {
                // Tool mode: state model emits a diff JSON.
                // Apply the diff to our local 'memo' string being built
                memo = mergeQuestUpdates(newContent, memo);
                continue;
            }
        }

        const isRemoval = /^(?:REMOVED|EXPIRED|CLEARED|NONE|END_COMBAT)$/i.test(newContent);

        const escapedTag = escapeRegex(tag);
        const existingPattern = new RegExp(
            `\\s*\\[${escapedTag}\\][\\s\\S]*?\\[\\/${escapedTag}\\]`,
            'i'
        );

        if (settings.debugMode) {
            console.log(`[RPG Tracker] mergeMemo: processing [${tag}], pattern: ${existingPattern}`);
        }

        if (isRemoval) {
            memo = memo.replace(existingPattern, "").trim();
            if (settings.debugMode) console.log(`[RPG Tracker] mergeMemo: [${tag}] REMOVED`);
        } else {
            const fullBlock = `[${tag}]\n${newContent}\n[/${tag}]`;
            const before = memo;
            memo = memo.replace(existingPattern, () => '\n\n' + fullBlock);
            if (memo !== before) {
                if (settings.debugMode) console.log(`[RPG Tracker] mergeMemo: [${tag}] REPLACED`);
            } else {
                memo = memo.trimEnd() + '\n\n' + fullBlock;
                if (settings.debugMode) console.log(`[RPG Tracker] mergeMemo: [${tag}] APPENDED (new section)`);
            }
        }
    }

    const cleaned = memo.replace(/\n{3,}/g, '\n\n').trim();
    return deduplicateMemo(cleaned);
}

/**
 * Applies a constrained {"updates":[...]} diff from the state model.
 * Parses quests from memoText, applies mutations, and returns the updated string.
 * @param {string} jsonText
 * @param {string} [memoText]
 * @returns {string}
 */
export function mergeQuestUpdates(jsonText, memoText = null) {
    const settings = getSettings();
    const target = (memoText !== null) ? memoText : settings.currentMemo;
    const quests = parseQuestsFromMemo(target);
    
    if (!quests.length) return target;

    let parsed;
    try {
        parsed = JSON.parse(jsonText);
    } catch (e) {
        console.warn('[RPG Tracker] mergeQuestUpdates: invalid JSON in [QUESTS] diff block:', jsonText);
        return target;
    }

    const updates = Array.isArray(parsed?.updates) ? parsed.updates : [];
    if (!updates.length) return target;

    const mods = settings.syspromptModules || {};
    const isDeadlines = !!mods.questsDeadlines;
    const isFrustration = !!mods.questsFrustration;

    let changed = false;
    for (const update of updates) {
        let quest = quests.find(q => q.id === update.id);
        let objectiveDirectUpdate = null;
        if (!quest) {
            // Check if update.id is an objective ID belonging to some quest
            for (const q of quests) {
                const foundObj = q.objectives?.find(o => o.id === update.id);
                if (foundObj) {
                    quest = q;
                    objectiveDirectUpdate = foundObj;
                    break;
                }
            }
        }

        if (!quest) continue;
        if (quest.status === 'failed') continue;

        if (objectiveDirectUpdate) {
            if (update.status && ['active', 'completed', 'failed'].includes(update.status)) {
                objectiveDirectUpdate.status = update.status;
                changed = true;
            }
            if (typeof update.progress === 'number') {
                objectiveDirectUpdate.progress = update.progress;
                changed = true;
            }
            continue;
        }

        if (update.status && ['active', 'completed', 'past deadline', 'failed'].includes(update.status)) {
            let resolvedStatus = update.status;

            // Frustration ON: deadline expiry → 'past deadline', not 'failed' (AI may get this wrong)
            if (isFrustration && resolvedStatus === 'failed' && quest.deadline_time && quest.status === 'active') {
                resolvedStatus = 'past deadline';
            }
            // Deadlines ON, Frustration OFF: 'past deadline' is invalid → promote to 'failed'
            if (isDeadlines && !isFrustration && resolvedStatus === 'past deadline') {
                resolvedStatus = 'failed';
            }

            quest.status = resolvedStatus;
            changed = true;
        }

        if (Array.isArray(update.objectives)) {
            for (const objUpdate of update.objectives) {
                const obj = objUpdate.id ? quest.objectives.find(o => o.id === objUpdate.id) : null;
                if (obj) {
                    if (objUpdate.status && ['active', 'completed', 'failed'].includes(objUpdate.status)) {
                        obj.status = objUpdate.status;
                        changed = true;
                    }
                    if (typeof objUpdate.progress === 'number') {
                        obj.progress = objUpdate.progress;
                        changed = true;
                    }
                } else if (objUpdate.text) {
                    // Add new objective
                    const maxIdx = quest.objectives.reduce((max, o) => {
                        const m = o.id.match(/^obj_(\d+)$/);
                        if (m) {
                            const val = parseInt(m[1], 10);
                            return val > max ? val : max;
                        }
                        return max;
                    }, -1);
                    const newId = `obj_${maxIdx + 1}`;
                    const newObj = {
                        id: newId,
                        text: objUpdate.text,
                        required: objUpdate.required !== false,
                        status: objUpdate.status && ['active', 'completed', 'failed'].includes(objUpdate.status) ? objUpdate.status : 'active'
                    };
                    if (typeof objUpdate.total === 'number') {
                        newObj.total = objUpdate.total;
                    }
                    if (typeof objUpdate.progress === 'number') {
                        newObj.progress = objUpdate.progress;
                    }
                    quest.objectives.push(newObj);
                    changed = true;
                }
            }
        }
    }

    if (changed) {
        if (settings.debugMode) console.log('[RPG Tracker] mergeQuestUpdates: applied quest state changes.');
        const result = writeQuestsToMemo(quests, target);
        if (memoText === null) {
            SillyTavern.getContext().saveSettingsDebounced();
        }
        return /** @type {string} */ (result);
    }

    return target;
}

/**
 * Writes a quest array into a [QUESTS] block.
 * If memoText is provided, returns the updated string.
 * Otherwise, updates settings.currentMemo directly.
 * @param {any[]} quests
 * @param {string} [memoText]
 * @returns {string|void}
 */
export function writeQuestsToMemo(quests, memoText = null) {
    const settings = getSettings();
    let target = (memoText !== null) ? memoText : settings.currentMemo;

    const tag = 'QUESTS';
    const escapedTag = escapeRegex(tag);
    const pattern = new RegExp(`\\s*\\[${escapedTag}\\][\\s\\S]*?\\[\\/${escapedTag}\\]`, 'i');
    const blockExists = pattern.test(target);

    // Filter out completed quests to save AI context space
    const activeQuests = quests.filter(q => q.status !== 'completed');

    // If no active quests, remove the block if present — never insert an empty one
    if (!activeQuests || !activeQuests.length) {
        const result = blockExists ? target.replace(pattern, '').trim() : target;
        if (memoText !== null) return result;
        settings.currentMemo = result;
        return;
    }

    const content = settings.questLegacyMode
        ? serializeQuestsToText(activeQuests)
        : JSON.stringify(activeQuests, null, 2);

    const block = `\n\n[${tag}]\n${content}\n[/${tag}]`;

    let result;
    if (blockExists) {
        result = target.replace(pattern, block);
    } else {
        result = (target + block).trim();
    }

    if (memoText !== null) return result;
    settings.currentMemo = result;
}

/**
 * @deprecated Use writeQuestsToMemo(quests) instead. Kept for backward compat.
 */
export function syncQuestsToMemo() {
    const settings = getSettings();
    writeQuestsToMemo(settings.quests || []);
}

/**
 * Strips completed quests from the [QUESTS] block inside a raw memo string.
 * Completed quests are kept in settings.quests for UI display but must NEVER
 * appear in the Prior Memo sent to the AI — they are read-only history.
 * Works for both legacy plain-text and JSON quest formats.
 * Pure function — no side effects.
 * @param {string} memoText
 * @returns {string}
 */
export function stripCompletedQuestsFromMemo(memoText) {
    if (!memoText) return memoText;
    const questBlockRe = /\[QUESTS\]([\s\S]*?)\[\/QUESTS\]/i;
    const match = memoText.match(questBlockRe);
    if (!match) return memoText;

    const content = match[1].trim();

    // ── Legacy plain-text format ──────────────────────────────────────────────
    // The AI writes the full [QUESTS] text block directly (questLegacyMode=true).
    // mergeMemo pastes it into currentMemo verbatim — no filter runs at write time.
    // We split on QUEST: boundaries and drop any block with STATUS: completed.
    if (/^QUEST:/m.test(content)) {
        // Split on the start of each "QUEST:" line, keeping the delimiter.
        // content already starts with "QUEST:", so no prepend needed.
        const questBlocks = content.split(/^(?=QUEST:)/m).filter(Boolean);
        const active = questBlocks.filter(block => !/^\s*STATUS:\s*completed\s*$/im.test(block));
        if (active.length === questBlocks.length) return memoText; // nothing to strip
        const newContent = active.map(b => b.trim()).join('\n\n').trim();
        if (!newContent) return memoText.replace(questBlockRe, '').replace(/\n{3,}/g, '\n\n').trim();
        return memoText.replace(questBlockRe, `[QUESTS]\n${newContent}\n[/QUESTS]`);
    }

    // ── JSON / Tool-call format ───────────────────────────────────────────────
    // writeQuestsToMemo already filters completed at write time, so this branch
    // is a safety net for any edge case that bypasses that path.
    try {
        const parsed = JSON.parse(content);
        const quests = Array.isArray(parsed) ? parsed : (parsed.quests || []);
        const active = quests.filter(q => q.status !== 'completed');
        if (active.length === quests.length) return memoText; // nothing to strip
        if (!active.length) return memoText.replace(questBlockRe, '').replace(/\n{3,}/g, '\n\n').trim();
        return memoText.replace(questBlockRe, `[QUESTS]\n${JSON.stringify(active, null, 2)}\n[/QUESTS]`);
    } catch {
        return memoText; // unparseable — leave it alone
    }
}

// ── Legacy quest text format ───────────────────────────────────────────────────

/**
 * Parses the state model's plain-text quest format into settings.quests[].
 * Each quest block starts with "QUEST: <title>" and contains labeled key: value lines.
 * @param {string} text - Content inside [QUESTS]...[/QUESTS]
 * @returns {object[]|null} Array of quest objects, or null on complete parse failure.
 */
export function parseQuestsFromText(text) {
    if (!text || !text.trim()) return [];

    const questBlocks = text.trim().split(/^QUEST:/m);
    const quests = [];

    for (const block of questBlocks) {
        if (!block.trim()) continue;

        const lines = block.split('\n');
        const title = lines[0].trim();
        if (!title) continue;

        /** @param {string} key */
        const getField = (key) => {
            const re = new RegExp(`^\\s*${key}:\\s*(.+)$`, 'mi');
            const m = block.match(re);
            return m ? m[1].trim() : null;
        };

        const rawGiver  = getField('GIVER') || '';
        const giverParts = rawGiver.split(' @ ');
        const giverName = giverParts[0]?.trim() || 'Unknown';
        const giverLoc  = giverParts[1]?.trim() || 'Unknown';

        const rawCoeff = getField('FRUSTRATION_COEFF');
        const coeff = rawCoeff ? parseFloat(rawCoeff) : null;

        // Objectives: OBJ_ACTIVE, OBJ_COMPLETED/OBJ_DONE, or OBJ_FAILED lines
        // Robust: handles both one-per-line and comma-separated objectives on a single line
        const objectives = [];
        const objRe = /^\s*(OBJ_ACTIVE|OBJ_DONE|OBJ_COMPLETED|OBJ_FAILED):\s*(.+)$/gmi;
        // Read OBJ_TOTAL lines into a map keyed by order index for assignment below
        const objTotals = [];
        const objTotalRe = /^\s*OBJ_TOTAL:\s*(\d+)$/gmi;
        let objTotalMatch;
        while ((objTotalMatch = objTotalRe.exec(block)) !== null) {
            objTotals.push(parseInt(objTotalMatch[1], 10));
        }
        let objMatch;
        let objIdx = 0;
        while ((objMatch = objRe.exec(block)) !== null) {
            const tag = objMatch[1].toUpperCase();
            const isDone = (tag === 'OBJ_DONE' || tag === 'OBJ_COMPLETED');
            const isFailed = (tag === 'OBJ_FAILED');
            const rawContent = objMatch[2].trim();

            // Detect comma-separated objectives: "Obj one (required), Obj two (optional)"
            // A comma-separated list will have "(required)" or "(optional)" mid-string
            const hasInlineMarkers = /\)\s*,/.test(rawContent);

            const parts = hasInlineMarkers
                ? rawContent.split(/,\s*(?=\S)/)   // split on ", " boundaries
                : [rawContent];

            for (const part of parts) {
                const p = part.trim();
                if (!p) continue;
                const isOptional = /\(optional\)$/i.test(p);
                // Strip (required)/(optional) suffix
                let objText = p.replace(/\s*\((required|optional)\)\s*$/i, '').trim();
                // Extract inline [progress/total] counter, e.g. "Collect mushrooms [4/6]"
                let progress = undefined;
                let total = objTotals[objIdx] ?? undefined;
                const progressMatch = objText.match(/\[(\d+)\/(\d+)\]\s*$/);
                if (progressMatch) {
                    progress = parseInt(progressMatch[1], 10);
                    total    = parseInt(progressMatch[2], 10);
                    objText  = objText.replace(/\s*\[\d+\/\d+\]\s*$/, '').trim();
                }
                if (!objText) continue;
                const entry = {
                    id:       `obj_${objIdx++}`,
                    text:     objText,
                    required: !isOptional,
                    status:   isDone ? 'completed' : (isFailed ? 'failed' : 'active'),
                };
                if (total != null)    entry.total    = total;
                if (progress != null) entry.progress = progress;
                objectives.push(entry);
            }
        }

        // Rewards: REWARD lines
        const rewards = [];
        const rewardRe = /^\s*REWARD:\s*(.+)$/gmi;
        let rewardMatch;
        while ((rewardMatch = rewardRe.exec(block)) !== null) {
            rewards.push(rewardMatch[1].trim());
        }

        quests.push({
            id:                     getField('ID') || `quest_${Date.now()}_${quests.length}`,
            title,
            status:                 getField('STATUS') || 'active',
            giver_name:             giverName,
            giver_location:         giverLoc,
            accepted_time:          getField('ACCEPTED'),
            deadline_time:          getField('DEADLINE'),
            difficulty:             getField('DIFFICULTY'),
            frustration_coefficient: coeff !== null && !isNaN(coeff) ? coeff : undefined,
            objectives,
            rewards,
        });
    }

    return quests;
}

/**
 * Converts settings.quests[] back to the plain-text format for the Raw View.
 * @param {object[]} quests
 * @returns {string}
 */
export function serializeQuestsToText(quests) {
    if (!quests || !quests.length) return '';

    return quests.map(q => {
        const lines = [`QUEST: ${q.title}`];
        lines.push(`  ID: ${q.id}`);
        lines.push(`  STATUS: ${q.status || 'active'}`);
        lines.push(`  GIVER: ${q.giver_name} @ ${q.giver_location}`);
        if (q.accepted_time)          lines.push(`  ACCEPTED: ${q.accepted_time}`);
        if (q.deadline_time)          lines.push(`  DEADLINE: ${q.deadline_time}`);
        if (q.difficulty)             lines.push(`  DIFFICULTY: ${q.difficulty}`);
        if (q.frustration_coefficient != null)
                                      lines.push(`  FRUSTRATION_COEFF: ${q.frustration_coefficient}`);

        // Inject human-readable mood for the AI narrator
        if (q.status === 'active' || q.status === 'past deadline') {
            const settings = getSettings();
            const showFrustration = !!settings.syspromptModules?.questsFrustration;
            const currentTime = settings.currentMemo?.match(/\[TIME\]([\s\S]*?)\[\/TIME\]/i)?.[1]?.trim() || "";
            const { label } = getQuestMood(q, currentTime, showFrustration);
            lines.push(`  MOOD: ${label}`);
        }
        for (const obj of (q.objectives || [])) {
            let tag = 'OBJ_ACTIVE';
            if (obj.status === 'completed') tag = 'OBJ_COMPLETED';
            else if (obj.status === 'failed') tag = 'OBJ_FAILED';
            
            const suffix = obj.required ? '(required)' : '(optional)';
            const progressStr = (typeof obj.progress === 'number' && typeof obj.total === 'number')
                ? ` [${obj.progress}/${obj.total}]` : '';
            lines.push(`  ${tag}: ${obj.text}${progressStr} ${suffix}`);
            if (obj.total != null) lines.push(`  OBJ_TOTAL: ${obj.total}`);
        }
        for (const r of (q.rewards || [])) {
            lines.push(`  REWARD: ${r}`);
        }
        return lines.join('\n');
    }).join('\n\n');
}

/**
 * Parses the [QUESTS] block from a text string and returns a quest array.
 * Pure function — no side effects.
 * @param {string} memoText
 * @returns {any[]}
 */
export function parseQuestsFromMemo(memoText) {
    const match = (memoText || '').match(/\[QUESTS\]([\s\S]*?)\[\/QUESTS\]/i);
    if (!match) return [];

    const content = match[1].trim();

    // Auto-detect format: plain-text starts with QUEST:
    if (content.startsWith('QUEST:')) {
        return parseQuestsFromText(content);
    } else {
        try {
            const parsed = JSON.parse(content);
            const quests = Array.isArray(parsed) ? parsed : (parsed.quests || []);
            return quests;
        } catch (e) {
            console.warn('[RPG Tracker] parseQuestsFromMemo: Failed to parse [QUESTS] as JSON:', e);
            return [];
        }
    }
}

/**
 * Parses the [QUESTS] block from a text string and updates settings.quests.
 * Used when the user manually edits the Raw View.
 * @param {string} memoText
 */
export function syncQuestsFromMemo(memoText) {
    const settings = getSettings();

    // Safety check: if memoText contains delta updates instead of full quests, do NOT clear active quests.
    const match = (memoText || '').match(/\[QUESTS\]([\s\S]*?)\[\/QUESTS\]/i);
    if (match) {
        const content = match[1].trim();
        if (!content.startsWith('QUEST:')) {
            try {
                const parsed = JSON.parse(content);
                if (parsed && parsed.updates) {
                    return; // delta updates block, ignore syncing to preserve existing state
                }
            } catch (e) {
                // Ignore parse errors here, let parseQuestsFromMemo handle it
            }
        }
    }

    const quests = parseQuestsFromMemo(memoText);
    const existingCompleted = (settings.quests || []).filter(q => q.status === 'completed');
    
    if (quests.length === 0) {
        const match = (memoText || '').match(/\[QUESTS\]([\s\S]*?)\[\/QUESTS\]/i);
        if (!match && settings.quests && settings.quests.length > 0) {
            if (settings.quests.length !== existingCompleted.length && settings.debugMode) {
                console.log('[RPG Tracker] syncQuestsFromMemo: active quests cleared because [QUESTS] block was removed.');
            }
            settings.quests = existingCompleted;
        } else if (settings.quests && settings.quests.length > 0) {
            settings.quests = existingCompleted;
        }
        return;
    }

    // Merge newly parsed quests (which are active/failed) with existing completed ones
    const newIds = new Set(quests.map(q => q.id));
    const merged = [...quests];
    for (const eq of existingCompleted) {
        if (!newIds.has(eq.id)) {
            merged.push(eq);
        }
    }

    settings.quests = merged;
    if (settings.debugMode) console.log(`[RPG Tracker] syncQuestsFromMemo: updated internal state with ${merged.length} quest(s).`);
}

// ── Delta display ─────────────────────────────────────────────────────────────

/**
 * Produces an HTML diff string for display in the delta panel.
 */
export function computeDelta(oldMemo, newMemo) {
    if (!oldMemo && !newMemo) return '<span class="delta-empty">No memo yet.</span>';
    if (!oldMemo) return '<span class="delta-added">+ (initial memo created)</span>';

    const oldLines = new Set(oldMemo.split('\n').map(l => l.trim()).filter(Boolean));
    const newLines = new Set(newMemo.split('\n').map(l => l.trim()).filter(Boolean));

    const added   = [...newLines].filter(l => !oldLines.has(l));
    const removed = [...oldLines].filter(l => !newLines.has(l));

    if (added.length === 0 && removed.length === 0) {
        return '<span class="delta-empty">No changes detected.</span>';
    }

    const html = [
        ...removed.map(l => `<div class="delta-removed">- ${escapeHtml(l)}</div>`),
        ...added.map(l   => `<div class="delta-added">+ ${escapeHtml(l)}</div>`),
    ];
    return html.join('');
}

// ── Tool-call message detection ───────────────────────────────────────────────

/**
 * Returns null if the message is a tool-call payload (discard it from context).
 * Returns the original text if it is regular narrative.
 * @param {string} text
 * @returns {string|null}
 */
export function cleanToolCallMessage(text) {
    if (!text) return text;
    const trimmed = text.trim();

    if (trimmed.includes('<code') && trimmed.includes('</code>')) {
        const codeStart   = trimmed.indexOf('<code');
        const contentStart = trimmed.indexOf('>', codeStart);
        const codeEnd     = trimmed.indexOf('</code>', contentStart);
        if (contentStart !== -1 && codeEnd !== -1) {
            const jsonText = trimmed.slice(contentStart + 1, codeEnd).trim();
            try {
                const parsed  = JSON.parse(jsonText);
                const entries = Array.isArray(parsed) ? parsed : [parsed];
                if (entries.some(e => e && (e.name || e.result !== undefined))) {
                    return null;
                }
            } catch { /* not valid JSON inside the code block */ }
        }
    }

    if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
        try {
            const parsed  = JSON.parse(trimmed);
            const entries = Array.isArray(parsed) ? parsed : [parsed];
            if (entries.some(e => e && (e.name || e.result !== undefined))) {
                return null;
            }
        } catch { /* not valid JSON */ }
    }

    return text;
}

// ── User action extraction ────────────────────────────────────────────────────

/**
 * Extracts the last user message from the chat, stripping injected blocks
 * (STATE MEMO, RNG_QUEUE) so only the player's actual typed input remains.
 */
export function getLastUserAction() {
    const { chat } = SillyTavern.getContext();
    if (!chat || chat.length === 0) return '';

    let raw = '';
    for (let i = chat.length - 1; i >= 0; i--) {
        if (chat[i].is_user || chat[i]['role'] === 'user') {
            raw = chat[i].mes || chat[i]['content'] || '';
            break;
        }
    }

    if (!raw) return '';

    if (Array.isArray(raw)) {
        raw = raw.filter(p => p && p.type === 'text').map(p => p.text || '').join('\n');
    } else if (typeof raw !== 'string') {
        raw = String(raw);
    }

    raw = raw.replace(/###\s*STATE MEMO[^]*?(?=\n\[RNG_QUEUE|\n###|\n\[(?!RNG_QUEUE)[A-Z]|$)/i, '');
    raw = raw.replace(/\[RNG_QUEUE\s[^\]]*\][\s\S]*?\[\/RNG_QUEUE\][ \t]*\n?/gi, '');
    raw = raw.replace(/\[[A-Z_]+\][\s\S]*?\[\/[A-Z_]+\]/g, '');
    raw = raw.replace(/###\s*CURRENT USER INPUT[^\n]*\n?/gi, '');
    raw = raw.replace(/\[Continue the narrative\]/gi, '');

    return raw.trim();
}

// ── Lorebook context builder ──────────────────────────────────────────────────

/**
 * Reads active Lorebooks from user settings and assembles them into
 * a context string prepended to the state model user prompt.
 */
export async function buildLorebookContext() {
    const settings = getSettings();
    const stCtx = SillyTavern.getContext();
    const parts = [];

    if (settings.ctxWorldInfo) {
        try {
            const allowedBooks = settings.lorebookFilter || [];
            let booksToLoad = [];

            if (allowedBooks.length > 0) {
                booksToLoad = allowedBooks;
            } else {
                // Try the in-memory list first
                booksToLoad = stCtx.getWorldInfoNames?.() ?? [];

                // If empty, force-refresh from backend and retry
                if (!booksToLoad.length && stCtx.updateWorldInfoList) {
                    await stCtx.updateWorldInfoList();
                    booksToLoad = stCtx.getWorldInfoNames?.() ?? [];
                }

                // Final fallback: direct backend fetch
                if (!booksToLoad.length) {
                    try {
                        const resp = await fetch('/api/settings/get', {
                            method: 'POST',
                            headers: stCtx.getRequestHeaders(),
                            body: JSON.stringify({}),
                        });
                        if (resp.ok) {
                            const data = await resp.json();
                            booksToLoad = data.world_names ?? [];
                        }
                    } catch (fetchErr) {
                        console.warn('[RPG Tracker] Direct world_names fetch failed:', fetchErr);
                    }
                }
            }

            const entries = [];
            for (const bookName of booksToLoad) {
                try {
                    const bookData = await stCtx.loadWorldInfo(bookName);
                    if (!bookData?.entries) continue;
                    for (const entry of Object.values(/** @type {any} */(bookData).entries)) {
                        const e = /** @type {any} */ (entry);
                        if (!e.disable && e.content) entries.push(e.content);
                    }
                } catch (bookErr) {
                    console.warn(`[RPG Tracker] Failed to load lorebook "${bookName}":`, bookErr);
                }
            }

            if (entries.length > 0) {
                const label = allowedBooks.length > 0 ? `Filtered: ${allowedBooks.join(', ')}` : 'All Books';
                parts.push(`## WORLD LORE (${label})\n${entries.join('\n---\n')}`);
            }
        } catch (e) {
            console.warn('[RPG Tracker] Could not inject World Info:', e);
        }
    }

    return parts.join('\n\n');
}

// ── Module instruction builders ───────────────────────────────────────────────

/**
 * Builds the complete modules instruction block for the system prompt.
 */
export function buildModulesInstructionText(settings) {
    let modulesText = "";
    const promptsMap = settings.stockPrompts || DEFAULT_STOCK_PROMPTS;

    modulesText += "### CORE MODULES\n";
    for (const [key, prompt] of Object.entries(promptsMap)) {
        // Never emit the quests_legacy key as its own module — it's a data slot only
        if (key === 'quests_legacy') continue;

        if (settings.modules[key]) {
            let p = prompt;

            // ── Dynamic prompt swap for Legacy Quests ──────────────────────
            if (key === 'quests') {
                const useLegacy = !!settings.questLegacyMode;
                if (useLegacy) {
                    const isDeadlines = !!settings.syspromptModules?.questsDeadlines;
                    const isFrustration = !!settings.syspromptModules?.questsFrustration;
                    const isDifficulty = !!settings.syspromptModules?.questsDifficulty;
                    // Use the dedicated legacy format prompt
                    p = (promptsMap['quests_legacy'] || DEFAULT_STOCK_PROMPTS.quests_legacy);
                    if (!isDeadlines) p = p.replace(/\n\s*DEADLINE:.*?\n/g, '\n');
                    if (!isFrustration) p = p.replace(/\n\s*FRUSTRATION_COEFF:.*?\n/g, '\n');
                    if (!isDifficulty) {
                        p = p.replace(/\n\s*DIFFICULTY:.*?\n/g, '\n');
                        p = p.replace(/\n- For difficulty, use the DIFFICULTY marker.*\n/g, '\n');
                    }
                    console.log('[RPG Tracker] Quest prompt: using LEGACY format (questLegacyMode=true)');
                } else {
                    console.log('[RPG Tracker] Quest prompt: using MODERN/JSON format (questLegacyMode=false)');
                }
            }

            modulesText += `- [${key.toUpperCase()}]: ${p}\n`;
        }
    }

    const enabledCustomFields = (settings.customFields || []).filter(f => f.enabled && f.tag);
    if (enabledCustomFields.length > 0) {
        modulesText += "\n### CUSTOM MODULES\n";
        enabledCustomFields.forEach(f => {
            const instruction = buildModuleFormatInstruction(f);
            if (instruction) {
                modulesText += `- [${f.tag.toUpperCase()}]: ${instruction}\n`;
            }
        });
    }
    return modulesText.trim();
}

export function buildModuleFormatInstruction(field) {
    return field.prompt || '';
}
