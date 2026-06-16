import { getSettings, getEffectiveRouterCampaignPrefix } from './state-manager.js';
import { sendStateRequest, sendAgentTurn } from './llm-client.js';
import { getRequestHeaders } from '../../../../script.js';
import { extractCurrentTimeStr } from './memo-processor.js';

let _routerRunning = false;
let _routerNormalRunCount = 0; // tracks completed normal (non-cleanup) passes for auto-cleanup interval
let _routerController = null; // AbortController for the active router pass

/** Returns true while a router pass is actively running. */
export function isRouterRunning() { return _routerRunning; }

/**
 * Aborts the currently-running Lorebook Agent pass, if any.
 * Equivalent to the State Tracker's stop button: kills the in-flight LLM request.
 */
export function stopRouterPass() {
    if (_routerController) {
        _routerController.abort();
        _routerController = null;
    }
}

/**
 * Returns the current campaign prefix (user override in settings, else chat id).
 * Returns '' only if there is no usable prefix.
 */
function getLivePrefix() {
    const ctx = SillyTavern.getContext();
    return getEffectiveRouterCampaignPrefix(ctx.chatId || '');
}

/**
 * Returns true if `bookName` belongs to the given `prefix`.
 * Exact match: bookName === prefix, OR bookName === prefix + '_' + <single-word suffix>
 * (suffix must contain no underscores to prevent "Assistant" from matching
 * "Assistant_2026_05_13_NPCs" which belongs to a different longer prefix).
 * @param {string} bookName
 * @param {string} prefix
 */
function bookBelongsToPrefix(bookName, prefix) {
    if (!prefix) return false;
    const lowerBook = String(bookName).toLowerCase();
    const lowerPref = String(prefix).toLowerCase();
    if (lowerBook === lowerPref) return true;
    const rest = lowerBook.startsWith(lowerPref + '_') ? lowerBook.slice(lowerPref.length + 1) : null;
    return rest !== null && !rest.includes('_');
}

/**
 * Parses a single Action: toolname({...}) call from a text response.
 * Used as a fallback for profile/default connections that don't support native tool calling.
 * Safe because the caller always passes a single-turn response (multi-turn messages mean
 * the model never echoes prior turns, so only one action appears in the text).
 *
 * @param {string} text
 * @returns {{name: string, args: object, id: string} | null}
 */
function parseTextAction(text) {
    // Find the last "Action:" line to be safe, then extract the balanced JSON argument.
    const parts = ('\n' + text).split(/\nAction:\s*/i);
    if (parts.length < 2) return null;
    const lastPart = parts[parts.length - 1].trim();

    // Extract the tool name
    const nameMatch = lastPart.match(/^(\w+)\s*\(/);
    if (!nameMatch) return null;
    const name = nameMatch[1].toLowerCase();

    // Extract balanced-paren args starting after the tool name
    const parenStart = lastPart.indexOf('(');
    if (parenStart === -1) return null;
    let depth = 0, end = -1;
    for (let i = parenStart; i < lastPart.length; i++) {
        if (lastPart[i] === '(') depth++;
        else if (lastPart[i] === ')') { depth--; if (depth === 0) { end = i; break; } }
    }
    const rawArgs = end !== -1 ? lastPart.slice(parenStart + 1, end) : lastPart.slice(parenStart + 1);

    // For tools that take a bare string (grep_lore, inspect_book, read_entry), wrap in object
    let args;
    try {
        // Try JSON first
        let cleaned = rawArgs.trim();
        if (!cleaned.startsWith('{') && !cleaned.startsWith('[')) {
            // Bare string argument like grep_lore("Iron Syndicate")
            cleaned = cleaned.replace(/^['"]|['"]$/g, '');
            const argNames = { grep_lore: 'query', inspect_book: 'book_name', read_entry: 'uid' };
            args = { [argNames[name] || 'value']: cleaned };
        } else {
            cleaned = cleaned.replace(/,\s*\}/g, '}').replace(/,\s*\]/g, ']');
            args = JSON.parse(cleaned);
        }
    } catch (_) {
        return null;
    }

    return { name, args, id: `text_${Date.now()}` };
}

/**
 * Broadcasts an agent step to the UI for the Terminal view.
 */
function broadcastStep(type, content, metadata = {}) {
    document.dispatchEvent(new CustomEvent('rt_lore_agent_step', {
        detail: { type, content, metadata, timestamp: Date.now() }
    }));
}

/**
 * Compatibility helper for older SillyTavern versions.
 * Probes both the frontend cache AND the backend API for ground truth,
 * so that cloned/renamed lorebooks are always discovered.
 */
async function getWorldInfoNamesSafe() {
    const ctx = SillyTavern.getContext();
    const namesSet = new Set();
    
    // 1. Check frontend registry (may be stale or incomplete if books aren't linked yet)
    if (typeof ctx.getWorldInfoNames === 'function') {
        const res = await ctx.getWorldInfoNames();
        if (Array.isArray(res)) res.forEach(n => namesSet.add(n));
    } else if (typeof ctx.getLorebookList === 'function') {
        const res = await ctx.getLorebookList();
        if (Array.isArray(res)) res.forEach(n => namesSet.add(n));
    }

    // 2. Unconditionally probe the backend API (ground truth of what exists on disk).
    // This prevents the agent from missing newly cloned books if the frontend hasn't refreshed.
    try {
        const r = await fetch('/api/settings/get', { 
            method: 'POST', 
            headers: getRequestHeaders(),
            body: JSON.stringify({})
        });
        if (r.ok) {
            const j = await r.json();
            if (Array.isArray(j?.world_names)) {
                j.world_names.forEach(n => namesSet.add(n));
            }
        }
    } catch (_) {}

    // 3. Fallback: enumerate all lorebooks from the backend list endpoint
    try {
        const r = await fetch('/api/worldinfo/list', { method: 'POST', headers: getRequestHeaders() });
        if (r.ok) {
            const j = await r.json();
            if (Array.isArray(j)) {
                j.forEach(entry => { if (entry?.file_id) namesSet.add(entry.file_id); });
            }
        }
    } catch (_) {}

    return [...namesSet];
}

/**
 * Builds the summary "Keyring" text for archive (inactive) entries only.
 * Active entries are excluded to avoid double-listing them in the agent context.
 * @param {object} allBooks
 * @param {string[]} activeKeys - IDs currently in activeRouterKeys (Book::uid format).
 */
function buildKeyringText(allBooks, activeKeys = []) {
    const activeSet = new Set(activeKeys);
    let lines = [];
    for (const [bookName, bookData] of Object.entries(allBooks)) {
        if (!bookData || !bookData.entries) continue;
        for (const [uid, entry] of Object.entries(bookData.entries)) {
            if (activeSet.has(`${bookName}::${uid}`)) continue; // shown in ACTIVE MEMORY
            const keys = (entry.key || []).join(', ');
            lines.push(`[ARCHIVE] Label: ${entry.comment || entry.key?.[0] || 'Unnamed'} | Keys: [${keys}]`);
        }
    }
    return lines.join('\n');
}

/**
 * The core Researcher Agent loop.
 */
export async function runRouterPass(narrativeOutput, manualPrompt = null, customLookback = null, isManual = false, newlyTriggeredIds = [], overrideChatLog = null) {
    const settings = getSettings();
    if (!settings.routerEnabled || _routerRunning) return;
    // routerPaused blocks auto-runs only; manual UI runs always go through
    if (settings.routerPaused && !isManual) return;

    const ctx = SillyTavern.getContext();
    if (!ctx.generateRaw) return;

    try {
        _routerRunning = true;
        if (_routerController) _routerController.abort();
        _routerController = new AbortController();
        const _routerSignal = _routerController.signal;
        broadcastStep('start', 'Initializing Lorebook Agent...');

        const startTime = Date.now();
        const prefix = getLivePrefix();
        if (!prefix) {
            broadcastStep('error', 'Cannot run: no campaign prefix available. The chat name may not have loaded yet ? try again in a moment.');
            _routerRunning = false;
            return;
        }
        let basicSummary = '';
        
        async function fetchArchiveBooks() {
            // Flush ST's in-memory registry so books written via HTTP API in prior passes are visible
            if (typeof ctx.updateWorldInfoList === 'function') {
                try { await ctx.updateWorldInfoList(); } catch (_) {}
            }
            const allBookNames = await getWorldInfoNamesSafe();
            const inScope = (n) => !prefix || bookBelongsToPrefix(n, prefix);
            const scoped = new Set(prefix ? allBookNames.filter(inScope) : allBookNames);

            // Also sweep books referenced in routerLog (catches books not yet formally indexed)
            const logBookNames = (settings.routerLog || [])
                .flatMap(e => [...(e.record || []), ...(e.activate || [])].map(id => id.split('::')[0]))
                .filter(Boolean);
            for (const n of logBookNames) {
                if (inScope(n)) scoped.add(n);
            }

            const books = {};
            for (const n of scoped) {
                const b = await ctx.loadWorldInfo(n);
                if (b?.entries) books[n] = b;
            }
            return books;
        }

        let archiveBooks = await fetchArchiveBooks();

        // ?? Snapshot state BEFORE this pass (for rollback) ??????????????????
        {
            const snapshot = {
                timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
                activeRouterKeys: JSON.parse(JSON.stringify(settings.activeRouterKeys || [])),
                activeWorldKeys: JSON.parse(JSON.stringify(settings.activeWorldKeys || [])),
                bookSnapshots: {}
            };
            for (const [name, book] of Object.entries(archiveBooks)) {
                snapshot.bookSnapshots[name] = JSON.parse(JSON.stringify(book));
            }
            if (!settings.routerHistory) settings.routerHistory = [];
            settings.routerHistory.unshift(snapshot);
            if (settings.routerHistory.length > 5) settings.routerHistory.length = 5;
            ctx.saveSettingsDebounced();
        }
        let activeEntriesFull = [];
        let newlyTriggeredFull = [];

        const triggeredSet = new Set(newlyTriggeredIds);

        function updateActiveEntries() {
            activeEntriesFull = [];
            newlyTriggeredFull = [];
            for (const [name, book] of Object.entries(archiveBooks)) {
                for (const [uid, entry] of Object.entries(book.entries)) {
                    const fullId = `${name}::${uid}`;
                    if (settings.activeRouterKeys?.includes(fullId)) {
                        const label = entry.comment || entry.key?.[0] || fullId;
                        const block = `### [ACTIVE] ${label}\nID: ${fullId}\nContent: ${entry.content}`;
                        if (triggeredSet.has(fullId)) {
                            newlyTriggeredFull.push(block);
                        } else {
                            activeEntriesFull.push(block);
                        }
                    }
                }
            }
        }
        updateActiveEntries();

        let keyringText = buildKeyringText(archiveBooks, settings.activeRouterKeys);
        const { chat } = ctx;
        
        let recentChatString = "";
        if (overrideChatLog) {
            recentChatString = overrideChatLog;
        } else {
            const N = customLookback !== null ? customLookback : (settings.routerLookback || 4);
            recentChatString = chat.slice(-N).map(m => {
                const name = (/** @type {any} */ (m)).is_user ? 'Player' : ((/** @type {any} */ (m)).name || 'Narrator');
                const content = (/** @type {any} */ (m)).mes || (/** @type {any} */ (m)).content || '';
                return `${name}: ${content.replace(/<[^>]+>/g, '')}`;
            }).join('\n\n');
        }

        // Extract Current Context (Time & Location)
        const timeRegex = /([0-9]{1,2}:[0-9]{2}\s*[AP]M,\s*Day\s*[0-9]+)/i;
        const narrativeTimeMatch = recentChatString.match(timeRegex);
        const memoTimeMatch = settings.currentMemo?.match(/\[TIME\]([\s\S]*?)\[\/TIME\]/i);
        const cleanMemoTime = memoTimeMatch ? extractCurrentTimeStr(memoTimeMatch[1]) : '';
        const currentTime = narrativeTimeMatch ? narrativeTimeMatch[1] : cleanMemoTime;

        const locationRegex = /\(Location:\s*([^)]+)\)/i;
        const locMatch = recentChatString.match(locationRegex);
        const currentHierarchy = locMatch ? locMatch[1].trim() : '';
        const breadcrumb = currentHierarchy ? currentHierarchy.replace(/,\s*/g, ' :: ') : '';

        // 2. The Loop
        let turns = 0;
        const maxTurns = settings.routerMaxTurns || 5;
        let basicSummaryText = '';

        const routerSettings = {
            ...settings,
            connectionSource: settings.routerConnectionSource || 'default',
            connectionProfileId: settings.routerConnectionProfileId,
            completionPresetId: settings.routerCompletionPresetId,
            ollamaUrl: settings.routerOllamaUrl,
            ollamaModel: settings.routerOllamaModel,
            openaiUrl: settings.routerOpenaiUrl,
            openaiKey: settings.routerOpenaiKey,
            openaiModel: settings.routerOpenaiModel,
            maxTokens: (settings.routerMaxTokens !== undefined && settings.routerMaxTokens !== null && settings.routerMaxTokens !== '') ? Number(settings.routerMaxTokens) : 1000,
        };

        // Budget status — computed once and reused in both basic and agent context
        const activeCount = settings.activeRouterKeys?.length || 0;
        const maxActive = settings.routerMaxActivations || 8;
        const overflow = activeCount - maxActive;
        const budgetLine = `Active entries: ${activeCount} / ${maxActive}`;
        const overflowInstruction = overflow > 0
            ? `\nBUDGET VIOLATION: ${activeCount} entr${activeCount !== 1 ? 'ies' : 'y'} active, limit is ${maxActive}. ` +
              `You MUST deactivate at least ${overflow} entr${overflow > 1 ? 'ies' : 'y'} ` +
              `before this pass ends. Eliminate the narratively least relevant entries first. ` +
              `Justify each deactivation.`
            : '';

        const basePrompt = (settings.routerSystemPromptTemplate || 'You are the Lorebook Agent. Maintain narrative consistency and manage lorebooks.')
            .replace(/\{\{campaignRoot\}\}/g, prefix || 'World Chronicle')
            .replace(/\{\{user\}\}/g, ctx.name1 || 'User');

        // ── Cleanup Mode ─────────────────────────────────────────────────────
        // Triggered by the UI broom button via runRouterPass(null, '__CLEANUP__', null, true).
        // ── Cleanup Mode ─────────────────────────────────────────────────────
        // Triggered by the UI broom button or Clean per-entry buttons.
        // Bypasses all normal research logic; uses stripped prompts and rewrite/consolidate only.
        const isCleanupPass = isManual && (manualPrompt || '').startsWith('__CLEANUP__');
        const CLEANUP_TOKEN_THRESHOLD = settings.routerCleanupTokenThreshold || 300; // ~1200 chars — entries larger than this are flagged

        if (isCleanupPass) {
            let targetEntryId = null;
            let customInstructions = null;

            // Format parser:
            // __CLEANUP__::[BookName]::[UID]::[Instructions]
            // Or: __CLEANUP__::::[Instructions]
            const cleanupParts = manualPrompt.split('::');
            if (cleanupParts.length > 1) {
                const b = cleanupParts[1]?.trim();
                const u = cleanupParts[2]?.trim();
                if (b && u) {
                    targetEntryId = `${b}::${u}`;
                }
                // Custom instructions is everything after target, or after double colon
                if (b && u && cleanupParts.length >= 4) {
                    customInstructions = cleanupParts.slice(3).join('::').trim();
                } else if (!b && !u && cleanupParts.length >= 3) {
                    customInstructions = cleanupParts.slice(2).join('::').trim();
                }
            }

            if (targetEntryId) {
                broadcastStep('thought', `Cleanup mode: targeted compression for "${targetEntryId}"...`);
            } else {
                broadcastStep('thought', 'Cleanup mode: scanning for bloated entries...');
            }

            const flagged = [];
            for (const [bookName, book] of Object.entries(archiveBooks)) {
                if (!book?.entries) continue;
                const nameLower = bookName.toLowerCase();
                const isWorldBook = nameLower.endsWith('_world') || nameLower === 'world';
                if (isWorldBook) continue;

                for (const [uid, entry] of Object.entries(book.entries)) {
                    const fullId = `${bookName}::${uid}`;
                    const tokens = estimateTokens(entry.content);
                    const useThreshold = settings.routerCleanupUseThreshold !== false;
                    const isTarget = targetEntryId && fullId === targetEntryId;
                    const overThreshold = !useThreshold || tokens >= CLEANUP_TOKEN_THRESHOLD;

                    if (isTarget || (!targetEntryId && overThreshold)) {
                        const lines = (entry.content || '').split('\n').filter(Boolean).length;
                        const pairs = countRedundantPairs(entry.content);
                        const label = entry.comment || entry.key?.[0] || uid;
                        flagged.push({ id: fullId, tokens, lines, pairs, label, content: entry.content });
                    }
                }
            }

            if (flagged.length === 0) {
                const noFoundMsg = targetEntryId
                    ? `Cleanup: targeted entry "${targetEntryId}" not found.`
                    : settings.routerCleanupUseThreshold !== false
                        ? `Cleanup: no entries exceed the token threshold (${CLEANUP_TOKEN_THRESHOLD}t). Nothing to do.`
                        : `Cleanup: no entries found in the campaign lorebook. Nothing to do.`;
                broadcastStep('finish', noFoundMsg);
                _routerRunning = false;
                return;
            }

            // Sort worst-first so the model prioritises high-impact entries
            flagged.sort((a, b) => b.tokens - a.tokens);
            if (targetEntryId) {
                broadcastStep('thought', `Cleanup: compressing target entry "${flagged[0].label}"...`);
            } else {
                broadcastStep('thought', `Cleanup: ${flagged.length} bloated entr${flagged.length === 1 ? 'y' : 'ies'} found. Requesting compression...`);
            }

            // Build context: metadata list + full content of flagged entries
            const cleanupContext =
                `## ENTRIES FLAGGED FOR CONSOLIDATION\n` +
                flagged.map(e =>
                    `- ${e.id} | "${e.label}" | ~${e.tokens} tokens | ${e.lines} lines` +
                    (e.pairs > 0 ? ` | ⚠ ${e.pairs} redundant line pairs` : ` | ✓ low redundancy`)
                ).join('\n') +
                `\n\n## ENTRY CONTENTS\n` +
                flagged.map(e => `### ${e.id} — "${e.label}"\n${e.content}`).join('\n\n');

            let basicInstructionPrompt = `You are the Lorebook Archivist. Consolidate the bloated entries shown below.

## AVAILABLE TAGS
- [[REWRITE: BookName::UID | new canonical content]]
  Replace a single entry's content with a compressed version.

- [[CONSOLIDATE: TargetID1, TargetID2 | SurvivorID | merged content]]
  Merge two or more duplicate entries into one. All targets are deleted.

## RULES
1. Merge all timestamped updates into a single coherent, present-tense description.
2. Preserve plot-significant changes as brief dated notes (e.g. "Burned down on Day 12").
3. Always retain temporal context. Every rewritten entry MUST include at least one in-world time anchor (e.g. "[Day 2]" or "[Day 2, 11:42]"). You may collapse many timestamps into one, but never remove all temporal markers from an entry.
4. Remove redundant observations — if six updates repeat the same fact, write it once.
5. Preserve every unique fact. When in doubt, keep it. Never replace detailed facts with generic summary text (e.g., writing "Merged details" or "Merged workshop data" is invalid content).
6. Target 30–60% of the original token count.
7. Do NOT activate, deactivate, record, or delete entries except via CONSOLIDATE targets.
8. Do NOT consolidate entries of different categories (e.g., do NOT merge an NPC or Location into a Quest or Event). Consolidation is strictly for true duplicates representing the exact same entity or concept (e.g., two entries for the same NPC).
9. Do NOT merge multiple distinct chronological events into a single entry to "reduce fragmentation". Each distinct event must remain as a separate entry so it triggers on its own keywords.
10. Output your reasoning first, then the tags.`;

            let agentInstructionPrompt = `You are the Lorebook Archivist. Consolidate bloated lorebook entries using the tools provided.

## YOUR TASK
For each flagged entry:
1. Decide whether to rewrite in place (rewrite) or merge with a duplicate (consolidate).
2. You MUST call read_entry to inspect the full content of any entry BEFORE you rewrite or consolidate it. Do NOT modify or merge any entry that you have not loaded and read.
3. When done, call commit once with all rewrite and consolidate operations.

## RULES
1. Merge timestamped updates into a single coherent, present-tense description.
2. Preserve plot-significant changes as brief dated notes (e.g. "Burned down on Day 12").
3. Always retain temporal context. Every rewritten entry MUST include at least one in-world time anchor (e.g. "[Day 2]" or "[Day 2, 11:42]"). You may collapse many timestamps into one, but never remove all temporal markers from an entry.
4. Remove redundant observations. Preserve every unique fact. Never replace detailed facts with generic summary text (e.g., writing "Merged Pumping Station data." is a severe failure). The survivor must compile and retain the detailed facts of all targets.
5. Target 30–60% of the original token count per entry.
6. Do NOT activate, deactivate, record, or create new entries.
7. Do NOT consolidate entries of different categories (e.g., do NOT merge an NPC or Location into a Quest or Event). Consolidation is strictly for true duplicates representing the exact same entity (e.g., two entries for the same NPC).
8. Do NOT merge multiple distinct chronological events into a single entry to "reduce fragmentation". Each distinct historical event must remain as its own entry so it triggers on its specific keywords.
9. Call commit exactly once at the end. Do not call it per-entry.`;

            if (customInstructions) {
                const overrideText = `\n\n## USER CUSTOM REQUIREMENTS\nYou MUST adhere strictly to these custom compression instructions:\n- ${customInstructions}`;
                basicInstructionPrompt += overrideText;
                agentInstructionPrompt += overrideText;
            }

            // Determine routing mode here so we can shape the cleanup system prompt accordingly.
            // Profile/default connections don't support native tool schemas; use text-format actions.
            const usesNativeToolsForCleanup = ['openai', 'ollama'].includes(routerSettings.connectionSource);

            const cleanupSystemPrompt = settings.routerBasicMode
                ? basicInstructionPrompt
                : (usesNativeToolsForCleanup
                    // Native tool-call path — model receives JSON schemas via the API
                    ? agentInstructionPrompt
                    // Text-format path for profile/default — model must output Action: lines
                    : agentInstructionPrompt + `

## ACTIONS
You do NOT have access to native function calling. Output exactly ONE action per turn in plain text:
  Action: toolname({"arg": "value"})

Available actions:
- read_entry({"uid": "Book::0"}) — read the full content of an entry
- commit({"rewrite": [...], "consolidate": [...]}) — write all cleanup changes and finish

commit rewrite items: {"id": "Book::UID", "content": "compressed content"}
commit consolidate items: {"targets": ["Book::UID1"], "survivor": "Book::UID2", "content": "merged content"}

## EXAMPLE
Thought: The entry is verbose. I will rewrite it with the key facts.
Action: commit({"rewrite": [{"id": "Eldoria_Events::3", "content": "Compressed version of the entry."}]})`
                );

            if (settings.routerBasicMode) {
                const cleanupUserPrompt = cleanupContext;
                broadcastStep('thought', 'Thinking...');
                const basicResp = await sendStateRequest(routerSettings, cleanupSystemPrompt, cleanupUserPrompt, _routerSignal);
                const thoughtMatchC = basicResp.match(/(?:Thought|Reasoning):\s*([\s\S]*?)(?=\[\[|$)/i);
                if (thoughtMatchC) broadcastStep('thought', thoughtMatchC[1].trim().substring(0, 300));
                broadcastStep('thought', 'Parsing cleanup tags...');
                const cleanupAction = parseBasicTags(basicResp, archiveBooks);
                cleanupAction.reason = targetEntryId ? `Targeted cleanup: ${targetEntryId}.` : 'Cleanup pass (basic mode).';
                if (cleanupAction.rewrite.length > 0 || cleanupAction.consolidate.length > 0) {
                    await applyAction(cleanupAction, archiveBooks, currentTime, breadcrumb);
                    const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);
                    broadcastStep('finish', `Cleanup done in ${totalTime}s — ${cleanupAction.rewrite.length} rewritten, ${cleanupAction.consolidate.length} consolidated.`);
                } else {
                    broadcastStep('finish', 'Cleanup: agent found nothing to compress.');
                }
                _routerRunning = false;
                return;
            }

            // Agent mode: lean context (metadata only) — agent uses read_entry per-entry
            const agentCleanupContext = `## ENTRIES FLAGGED FOR CLEANUP\n` +
                flagged.map(e =>
                    `- ${e.id} | "${e.label}" | ~${e.tokens} tokens | ${e.lines} lines` +
                    (e.pairs > 0 ? ` | ⚠ ${e.pairs} redundant pairs` : '')
                ).join('\n');

            const usesNativeTools = usesNativeToolsForCleanup;
            // Text-format connections get full entry content upfront (one-shot commit, no read_entry turn needed).
            // Native tool connections get lean metadata and can use read_entry to pull content on demand.
            const cleanupMessages = [
                { role: 'system', content: cleanupSystemPrompt },
                { role: 'user',   content: usesNativeTools ? agentCleanupContext : cleanupContext }
            ];

            /** @type {Array<object>} */
            const cleanupAgentTools = [
                {
                    type: 'function',
                    function: {
                        name: 'grep_lore',
                        description: `Search all lorebooks in scope ("${prefix || 'All'}") for entries whose content or label contains the query.`,
                        parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] }
                    }
                },
                {
                    type: 'function',
                    function: {
                        name: 'inspect_book',
                        description: 'List all entry labels and UIDs in a specific lorebook.',
                        parameters: { type: 'object', properties: { book_name: { type: 'string' } }, required: ['book_name'] }
                    }
                },
                {
                    type: 'function',
                    function: {
                        name: 'read_entry',
                        description: 'Read the full content of a lorebook entry.',
                        parameters: { type: 'object', properties: { uid: { type: 'string', description: 'Entry UID in "BookName::0" format.' } }, required: ['uid'] }
                    }
                },
                {
                    type: 'function',
                    function: {
                        name: 'commit',
                        description: 'Write all cleanup changes and finish. Call exactly once at the end.',
                        parameters: {
                            type: 'object',
                            properties: {
                                rewrite: {
                                    type: 'array',
                                    description: 'Full content replacements for bloated entries. Do NOT rewrite an entry unless you called read_entry to inspect it first.',
                                    items: {
                                        type: 'object',
                                        properties: {
                                            id:      { type: 'string', description: 'Book::UID of the entry to rewrite.' },
                                            content: { type: 'string', description: 'New canonical content. Replaces the entire entry.' }
                                        },
                                        required: ['id', 'content']
                                    }
                                },
                                consolidate: {
                                    type: 'array',
                                    description: 'Merge multiple entries of the SAME category into one (e.g. duplicate NPCs). Targets are deleted. Do NOT merge different categories (e.g. do NOT merge NPC into Quest). Do NOT merge distinct chronological events to reduce fragmentation.',
                                    items: {
                                        type: 'object',
                                        properties: {
                                            targets:  { type: 'array', items: { type: 'string' }, description: 'Book::UID IDs to delete after merging. Must be the same category as survivor.' },
                                            survivor: { type: 'string', description: 'Book::UID to keep.' },
                                            content:  { type: 'string', description: 'Merged content for survivor. You MUST compile and preserve all unique facts/details from the targets. Generic placeholders (e.g. "Merged data") are forbidden.' }
                                        },
                                        required: ['targets', 'survivor', 'content']
                                    }
                                }
                            }
                        }
                    }
                }
            ];

            let cleanupTurns = 0;
            let cleanupRetries = 0;
            const MAX_CLEANUP_RETRIES = 2;
            while (cleanupTurns < maxTurns) {
                cleanupTurns++;
                broadcastStep('thought', `Cleanup thinking (Turn ${cleanupTurns}/${maxTurns})...`);
                const result = await sendAgentTurn(routerSettings, cleanupMessages, usesNativeTools ? cleanupAgentTools : null, _routerSignal);

                if (result.content) {
                    const thoughtLine = result.content.match(/(?:Thought|Reasoning):\s*(.*)/i)?.[1]?.trim()
                        || result.content.trim().split('\n')[0];
                    if (thoughtLine) broadcastStep('thought', thoughtLine.substring(0, 200));
                }

                let resolvedToolCall = result.toolCall;
                if (!resolvedToolCall && result.content) {
                    resolvedToolCall = parseTextAction(result.content);
                }
                if (!resolvedToolCall) {
                    if (cleanupRetries < MAX_CLEANUP_RETRIES) {
                        cleanupRetries++;
                        cleanupTurns--; // don't charge this against the turn budget
                        const isEmpty = !result.content || !result.content.trim();
                        if (isEmpty) {
                            // Empty/null content means the API returned an incomplete response
                            // (e.g. reasoning-model cut-off with finish_reason: null).
                            // Retry with the same message history — no history change needed.
                            broadcastStep('thought', `Incomplete API response (retry ${cleanupRetries}/${MAX_CLEANUP_RETRIES})...`);
                        } else {
                            // Model produced content but no parseable Action: line.
                            // Nudge it to output its action and retry.
                            broadcastStep('thought', `No action in response, nudging model (retry ${cleanupRetries}/${MAX_CLEANUP_RETRIES})...`);
                            cleanupMessages.push({ role: 'assistant', content: result.content });
                            cleanupMessages.push({ role: 'user', content: 'Please output your Action now. Remember: Action: toolname({...})' });
                        }
                        continue;
                    }
                    break;
                }
                cleanupRetries = 0; // reset on a successful action

                const { name: toolName, args } = resolvedToolCall;
                const callId = /** @type {any} */ (resolvedToolCall).id || `call_cleanup_${Date.now()}_${cleanupTurns}`;
                broadcastStep('tool', `${toolName}(...)`);

                cleanupMessages.push({
                    role: 'assistant',
                    content: result.content || null,
                    tool_calls: [{ id: callId, type: 'function', function: { name: toolName, arguments: JSON.stringify(args) } }]
                });

                let observation = '';
                if (toolName === 'commit') {
                    args.reason = targetEntryId ? `Targeted cleanup: ${targetEntryId}.` : 'Cleanup pass (agent mode).';
                    const commitResult = await applyAction(args, archiveBooks, currentTime, breadcrumb);
                    archiveBooks = await fetchArchiveBooks();
                    if (commitResult.errors.length > 0) {
                        observation = `Committed with warnings: ${commitResult.errors.join(', ')}`;
                    } else {
                        const details = [];
                        if (args.rewrite?.length)     details.push(`Rewritten: ${args.rewrite.length}`);
                        if (args.consolidate?.length) details.push(`Consolidated: ${args.consolidate.length}`);
                        observation = `Committed successfully. ${details.join(' | ')}`;
                    }
                } else if (toolName === 'read_entry') {
                    const uid = args.uid || '';
                    const [bookName, id] = uid.split('::');
                    const book = await ctx.loadWorldInfo(bookName);
                    observation = book?.entries?.[id] ? book.entries[id].content : `Entry "${uid}" not found.`;
                } else if (toolName === 'grep_lore') {
                    const query = (args.query || '').toLowerCase();
                    const hits = [];
                    for (const [name, book] of Object.entries(archiveBooks)) {
                        for (const [uid, entry] of Object.entries(book.entries)) {
                            if ((entry.content || '').toLowerCase().includes(query) || (entry.comment || '').toLowerCase().includes(query)) {
                                hits.push(`[${name}::${uid}] "${entry.comment || uid}": ${(entry.content || '').substring(0, 120)}...`);
                            }
                        }
                    }
                    observation = hits.length > 0 ? hits.join('\n') : `No entries found for "${args.query}".`;
                } else if (toolName === 'inspect_book') {
                    const bookName = args.book_name || '';
                    if (archiveBooks[bookName]) {
                        observation = Object.entries(archiveBooks[bookName].entries)
                            .map(([uid, e]) => `${bookName}::${uid} -- ${e.comment || e.key?.[0] || uid}`)
                            .join('\n');
                    } else {
                        observation = `Book "${bookName}" not found.`;
                    }
                } else {
                    observation = `Unknown tool: ${toolName}`;
                }

                broadcastStep('result', observation.substring(0, 200) + (observation.length > 200 ? '...' : ''));
                cleanupMessages.push({
                    role: 'tool',
                    tool_call_id: cleanupMessages[cleanupMessages.length - 1].tool_calls[0].id,
                    content: observation
                });

                if (toolName === 'commit') break;
            }

            const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);
            broadcastStep('finish', `Cleanup done in ${totalTime}s.`);
            _routerRunning = false;
            return;
        }
        // ── End Cleanup Mode ──────────────────────────────────────────────────

        // -- Basic Mode (tag-based, one-shot, no tool calling) -----------------
        if (settings.routerBasicMode) {

            const modules = settings.routerModules || {};
            const customTags = settings.routerCustomTags || [];
            const formatLines = [];
            for (const config of Object.values(modules)) {
                if (config.enabled) formatLines.push(`- [[${config.tag}: ${config.format}]] (${config.instruction})`);
            }
            for (const custom of customTags) {
                formatLines.push(`- [[${custom.tag}: ${custom.format || 'Name | Description | Keywords'}]] (${custom.instruction})`);
            }
            formatLines.push(`- [[ACTIVATE: Name]] (Bring entry to active memory)`);
            formatLines.push(`- [[DEACTIVATE: Name]] (Remove from active memory)`);
            formatLines.push(`- [[DELETE: Name]] (Permanently remove an entry)`);

            const formatLinesStr = formatLines.join('\n');
            let modularPrompt = settings.routerModularPromptTemplate || '';
            modularPrompt = modularPrompt.replace(/\{\{formatLines\}\}/g, formatLinesStr);

            // World Progression is now a standalone deterministic pass — strip any leftover
            // {{#if_world}} blocks from user-edited templates (default no longer contains them).
            modularPrompt = modularPrompt.replace(/\{\{#if_world\}\}[\s\S]*?\{\{\/if_world\}\}/g, '');
            modularPrompt = modularPrompt.replace(/\{\{#if_world\}\}|\{\{\/if_world\}\}|\{\{dayStr\}\}|\{\{prevDay\}\}/g, '');

            const basicSystemPrompt = `You are the Research Assistant. Your task is to identify and record important narrative entities and events.

${modularPrompt}

## ATTENTION & MEMORY
1. **NEWLY ACTIVATED THIS TURN**: Entries whose keywords appeared in the latest narrator output are pre-loaded here with full content. You do not need to activate them again — they are already active.
2. **ACTIVE MEMORY**: Full details of all other currently active entities. You can update them at any time.
3. **ARCHIVE INDEX**: Inactive entries — labels and keywords only. You CANNOT see their full biography.
4. **RECALL**: To read or update an archive entry, use [[ACTIVATE: Name]]. Its full content becomes visible next turn.
5. **LIMIT**: You are limited to **${settings.routerMaxActivations || 8} active entries**. Nothing is archived automatically. If you exceed this limit you will see a **BUDGET VIOLATION** line and you MUST use [[DEACTIVATE: Name]] on the least relevant active entries to return within budget before this pass ends.

## RULES
1. Only record persistent or significant entities/events.
2. Use ACTIVATE to bring an existing entry into the current scene context.
3. Use DEACTIVATE to remove an entry that is no longer relevant to the scene.
4. Use DELETE to permanently remove duplicate or redundant entries.
5. Output your thoughts first, then the tags.

Example:
Thought: I see a new NPC named Barnaby in Khelt's Rust-Lantern District. I will record him and the tavern.
[[NPC: Barnaby | A retired blacksmith with a scar on his cheek. | Barnaby, blacksmith, ally]]
[[LOC: Khelt :: Rust-Lantern District :: Barnaby's Forge | Barnaby's old workshop, still smelling of soot. | forge, Khelt, Rust-Lantern]]
[[FAC: Iron Syndicate | Wary of outsiders after the forge raid; still dominant in the industrial quarter. | Founded by ex-mercenaries forty years ago; controls scrap tariffs and smuggling. Lieutenant Marna Voss handles street enforcement. | Iron Syndicate, Khelt, faction, smuggling]]`;

            const finalBasicSystemPrompt = basicSystemPrompt;

            const questMatchB = settings.currentMemo?.match(/\[QUESTS\]([\s\S]*?)\[\/QUESTS\]/i);
            const questBlockB = questMatchB ? `[QUESTS]${questMatchB[1].trim()}[/QUESTS]` : 'None';
            const basicUserPrompt = `## BUDGET STATUS\n${budgetLine}${overflowInstruction}\n\n## NEWLY ACTIVATED THIS TURN\n${newlyTriggeredFull.join('\n\n') || 'None.'}\n\n## ACTIVE MEMORY (Lore)\n${activeEntriesFull.join('\n\n') || 'None.'}\n\n## ARCHIVE INDEX\n${keyringText || 'Empty.'}\n\n## CURRENT LOCATION\n${currentHierarchy || 'Unknown'}\n\n## ACTIVE QUESTS\n${questBlockB}\n\n## NARRATIVE\n${recentChatString}\n\n${manualPrompt ? `## INSTRUCTION\n${manualPrompt}\n\n` : ''}`;

            broadcastStep('thought', 'Thinking...');
            const basicResp = await sendStateRequest(routerSettings, finalBasicSystemPrompt, basicUserPrompt, _routerSignal);

            const thoughtMatchB = basicResp.match(/Thought:\s*([\s\S]*?)(?=\[\[|$)/i);
            if (thoughtMatchB) broadcastStep('thought', thoughtMatchB[1].trim());
            broadcastStep('thought', 'Parsing tags...');
            const basicAction = parseBasicTags(basicResp, archiveBooks);

            if (basicAction.record.length > 0 || basicAction.update.length > 0 || basicAction.activate.length > 0 || basicAction.delete_ids?.length > 0) {
                const summaries = [];
                if (basicAction.record.length) summaries.push(`New: ${basicAction.record.length}`);
                if (basicAction.update.length) summaries.push(`Updates: ${basicAction.update.length}`);
                if (basicAction.activate.length) summaries.push(`Activations: ${basicAction.activate.length}`);
                basicAction.reason = (thoughtMatchB ? thoughtMatchB[1].trim() : 'Tag-based update.') + ` (${summaries.join(', ')})`;
                await applyAction(basicAction, archiveBooks, currentTime, breadcrumb);
                basicSummaryText = summaries.join(', ');
            } else {
                broadcastStep('finish', 'Basic Mode: No tags found.');
            }

        } else {
            // -- Agent Mode (native tool calling, multi-turn messages) ----------

            // Build the commit tool's category enum from enabled modules + custom tags
            const validCategories = [
                ...Object.values(settings.routerModules || {}).filter(m => m.enabled).map(m => m.tag.toUpperCase()),
                ...(settings.routerCustomTags || []).map(t => t.tag.toUpperCase()),
            ];
            const categoryEnum = validCategories.length ? validCategories : ['NPC', 'LOC', 'QUEST', 'FAC', 'EVENT'];

            /** @type {Array<object>} */
            const agentTools = [
                {
                    type: 'function',
                    function: {
                        name: 'grep_lore',
                        description: `Search all lorebooks in scope ("${prefix || 'All'}") for entries whose content or label contains the query.`,
                        parameters: {
                            type: 'object',
                            properties: { query: { type: 'string', description: 'Keyword or phrase to search for.' } },
                            required: ['query']
                        }
                    }
                },
                {
                    type: 'function',
                    function: {
                        name: 'inspect_book',
                        description: 'List all entry labels and UIDs in a specific lorebook.',
                        parameters: {
                            type: 'object',
                            properties: { book_name: { type: 'string', description: 'Exact lorebook name (e.g. "Eldoria_Factions").' } },
                            required: ['book_name']
                        }
                    }
                },
                {
                    type: 'function',
                    function: {
                        name: 'read_entry',
                        description: 'Read the full content of a lorebook entry.',
                        parameters: {
                            type: 'object',
                            properties: { uid: { type: 'string', description: 'Entry UID in "BookName::0" format.' } },
                            required: ['uid']
                        }
                    }
                },
                {
                    type: 'function',
                    function: {
                        name: 'commit',
                        description: 'Write all changes to the lorebook and finish the research pass. The ONLY way to persist data.',
                        parameters: {
                            type: 'object',
                            properties: {
                                record: {
                                    type: 'array',
                                    description: 'New entries to create. Recording an entry with an existing label automatically updates it.',
                                    items: {
                                        type: 'object',
                                        properties: {
                                            label: { type: 'string', description: 'Entity name only. NO tag prefix (e.g. "Iron Syndicate", NOT "FAC: Iron Syndicate").' },
                                            keys:  { type: 'array', items: { type: 'string' }, description: 'Search keywords. Include the entity name/title itself (without timestamps like "[Day 1]") as a keyword, plus any ancestor location names.' },
                                            content:  { type: 'string', description: 'Full description.' },
                                            category: { type: 'string', enum: categoryEnum, description: 'Determines which lorebook the entry goes into.' }
                                        },
                                        required: ['label', 'keys', 'content', 'category']
                                    }
                                },
                                update: {
                                    type: 'array',
                                    description: 'Append new information to existing entries.',
                                    items: {
                                        type: 'object',
                                        properties: {
                                            id:      { type: 'string', description: 'Book::UID format (e.g. "Eldoria_NPCs::0").' },
                                            content: { type: 'string', description: 'New information to append.' }
                                        },
                                        required: ['id', 'content']
                                    }
                                },
                                activate:   { type: 'array', items: { type: 'string' }, description: 'Book::UID IDs to move into active context.' },
                                deactivate: { type: 'array', items: { type: 'string' }, description: 'Book::UID IDs to remove from active context.' },
                                delete_ids: { type: 'array', items: { type: 'string' }, description: 'Book::UID IDs to permanently delete.' },
                                rewrite: {
                                    type: 'array',
                                    description: 'Replace the entire content of existing entries. Use for compressing bloated entries.',
                                    items: {
                                        type: 'object',
                                        properties: {
                                            id:      { type: 'string', description: 'Book::UID of the entry to rewrite.' },
                                            content: { type: 'string', description: 'New canonical content. Replaces everything.' }
                                        },
                                        required: ['id', 'content']
                                    }
                                },
                                consolidate: {
                                    type: 'array',
                                    description: 'Merge multiple entries into one. All targets are deleted; the survivor gets the new content.',
                                    items: {
                                        type: 'object',
                                        properties: {
                                            targets:  {
                                                type: 'array',
                                                items: { type: 'string' },
                                                description: 'One or more Book::UID IDs to delete after merging.'
                                            },
                                            survivor: { type: 'string', description: 'Book::UID of the entry to keep, with merged content.' },
                                            content:  { type: 'string', description: 'Full merged canonical content for the survivor.' }
                                        },
                                        required: ['targets', 'survivor', 'content']
                                    }
                                }
                            }
                        }
                    }
                }
            ];

            // Native tool calling is only reliable for direct openai/ollama connections.
            // For profile/default the ConnectionManagerRequestService may not forward tools
            // correctly, causing MALFORMED_FUNCTION_CALL errors. Those connections get a
            // text-format (Action:/Observation:) system prompt and text-based parsing instead.
            const usesNativeTools = ['openai', 'ollama'].includes(routerSettings.connectionSource);

            const sharedContext = `
## MEMORY LIMIT
Maximum Active Entities: **${settings.routerMaxActivations || 8}**.
- Entries you record are ACTIVATED AUTOMATICALLY. Do NOT also include them in activate.
- Nothing is archived automatically. If you exceed the limit you will receive a **BUDGET VIOLATION** in the context and you MUST deactivate enough entries in that same commit call to return within budget. Choose the narratively least relevant entries.
- Entries whose keywords appeared in the latest narrator output may already appear under **NEWLY ACTIVATED THIS TURN** with full content — you do not need to activate those again.
- Always use exact Book::UID format (e.g. "Eldoria_NPCs::0") for activate/update/deactivate/delete_ids.

## CAMPAIGN CONTEXT
Campaign Root: "${prefix || 'World Archive'}"
  NPCs -> "${prefix ? prefix + '_NPCs' : 'NPCs'}"
  Locations -> "${prefix ? prefix + '_Locations' : 'Locations'}" (etc.)
Location hierarchy: use " :: " separator in labels (e.g. "Khelt :: Rust-Lantern District :: The Guilded Anvil").
Include the entity name/title itself (without timestamps like "[Day 1]") as a keyword, plus any ancestor location names (e.g. keys: ["The Guilded Anvil", "Khelt", "Rust-Lantern District", "tavern"]).

## FIELD INSTRUCTIONS
${Object.values(settings.routerModules || {}).filter(m => m.enabled).map(m => `- ${m.tag}: ${m.instruction}`).join('\n')}${(settings.routerCustomTags || []).length ? '\n\n### CUSTOM CATEGORIES\n' + (settings.routerCustomTags || []).map(m => `- ${m.tag.toUpperCase()}: ${m.instruction}`).join('\n') : ''}`;

            const agentSystemPrompt = usesNativeTools
                // Clean prompt for native tool calling ? model gets schemas via the API
                ? `${basePrompt}

## YOUR ROLE
You are a lorebook research agent. Maintain the campaign lorebook using the provided tools.
Use grep_lore / inspect_book / read_entry to look up existing data before recording.
When research is complete, call commit once to write all changes. Stop immediately after.
${sharedContext}`
                // Text-format prompt for profile/default ? model outputs Action:/Observation: text
                : `${basePrompt}

## YOUR ROLE
You are a lorebook research agent. Maintain the campaign lorebook using the actions below.
Use grep_lore / inspect_book / read_entry to look up existing data before recording.
When research is complete, output commit once to write all changes, then stop.

## ACTIONS
Output exactly ONE action per turn in this format:
  Action: toolname({"arg": "value"})

Available actions:
- grep_lore({"query": "..."}) ? search lorebooks for entries matching a keyword
- inspect_book({"book_name": "..."}) ? list UIDs in a lorebook
- read_entry({"uid": "Book::0"}) ? read full content of an entry
- commit({"record": [...], "update": [...], "activate": [...], "deactivate": [...], "delete_ids": [...]}) ? write all changes and finish

commit record items: {"label": "Name only (NO tag prefix)", "keys": ["kw1","kw2"], "content": "...", "category": "NPC|LOC|FAC|QUEST|EVENT"}
commit update items: {"id": "Book::UID", "content": "new text to append"}

## EXAMPLE
Thought: I see a new faction called Iron Syndicate. I will record it.
Action: commit({"record": [{"label": "Iron Syndicate", "keys": ["Khelt", "faction"], "content": "The dominant industrial authority.", "category": "FAC"}]})
${sharedContext}`;

            const questMatchA = settings.currentMemo?.match(/\[QUESTS\]([\s\S]*?)\[\/QUESTS\]/i);
            const questBlockA = questMatchA ? `[QUESTS]${questMatchA[1].trim()}[/QUESTS]` : 'None';
            const contextMessage = `## BUDGET STATUS\n${budgetLine}${overflowInstruction}\n\n## NEWLY ACTIVATED THIS TURN\n${newlyTriggeredFull.join('\n\n') || 'None.'}\n\n## ACTIVE MEMORY (Lore)\n${activeEntriesFull.join('\n\n') || 'None yet.'}\n\n## ARCHIVE INDEX\n${keyringText || 'Empty.'}\n\n## CURRENT LOCATION\n${currentHierarchy || 'Unknown'}\n\n## ACTIVE QUESTS\n${questBlockA}\n\n## NARRATIVE\n${recentChatString}${manualPrompt ? `\n\n## INSTRUCTION\n${manualPrompt}` : ''}`;

            /** @type {Array<{role:string, content:string|null, tool_calls?:any[], tool_call_id?:string}>} */
            const messages = [
                { role: 'system', content: agentSystemPrompt },
                { role: 'user',   content: contextMessage }
            ];

            let agentRetries = 0;
            const MAX_AGENT_RETRIES = 2;
            while (turns < maxTurns) {
                turns++;
                broadcastStep('thought', `Thinking (Turn ${turns}/${maxTurns})...`);

                // Only pass tool schemas to connections that support native tool calling.
                // Profile/default connections ignore or mishandle the tools parameter.
                const result = await sendAgentTurn(routerSettings, messages, usesNativeTools ? agentTools : null, _routerSignal);

                // Show any inline thought the model included alongside the tool call
                if (result.content) {
                    const thoughtLine = result.content.match(/Thought:\s*(.*)/i)?.[1]?.trim()
                        || result.content.trim().split('\n')[0];
                    if (thoughtLine) broadcastStep('thought', thoughtLine.substring(0, 200));
                }

                // For profile/default connections the model outputs text. Parse a single
                // Action: call from the current turn response (safe since it's single-turn).
                let resolvedToolCall = result.toolCall;
                if (!resolvedToolCall && result.content) {
                    resolvedToolCall = parseTextAction(result.content);
                }

                if (!resolvedToolCall) {
                    if (agentRetries < MAX_AGENT_RETRIES) {
                        agentRetries++;
                        turns--; // don't charge this against the turn budget
                        const isEmpty = !result.content || !result.content.trim();
                        if (isEmpty) {
                            // Empty/null content — incomplete API response (e.g. reasoning cut-off).
                            // Retry with unchanged history.
                            broadcastStep('thought', `Incomplete API response (retry ${agentRetries}/${MAX_AGENT_RETRIES})...`);
                        } else {
                            // Model produced text but no parseable Action — nudge it.
                            broadcastStep('thought', `No action in response, nudging model (retry ${agentRetries}/${MAX_AGENT_RETRIES})...`);
                            messages.push({ role: 'assistant', content: result.content });
                            messages.push({ role: 'user', content: 'Please output your Action now. Remember: Action: toolname({...})' });
                        }
                        continue;
                    }
                    // No tool call and no parseable action after retries — model is done
                    break;
                }
                agentRetries = 0; // reset on a successful action

                const { name: toolName, args } = resolvedToolCall;
                const callId = /** @type {any} */ (resolvedToolCall).id || `call_${Date.now()}_${turns}`;
                broadcastStep('tool', `${toolName}(...)`);

                // Append the assistant turn (with tool_calls) to the conversation
                messages.push({
                    role: 'assistant',
                    content: result.content || null,
                    tool_calls: [{
                        id:   callId || `call_${Date.now()}_${turns}`,
                        type: 'function',
                        function: { name: toolName, arguments: JSON.stringify(args) }
                    }]
                });

                let observation = '';

                if (toolName === 'commit') {
                    const commitResult = await applyAction(args, archiveBooks, currentTime, breadcrumb);
                    archiveBooks = await fetchArchiveBooks();
                    keyringText = buildKeyringText(archiveBooks, settings.activeRouterKeys);
                    updateActiveEntries();
                    if (commitResult.errors.length > 0) {
                        observation = `Committed with warnings: ${commitResult.errors.join(', ')}`;
                    } else {
                        const details = [];
                        if (commitResult.recordedIds?.length > 0) details.push(`Recorded/Updated: ${commitResult.recordedIds.join(', ')}`);
                        if (args.activate?.length > 0) details.push(`Activated: ${args.activate.join(', ')}`);
                        observation = `Committed successfully. ${details.join(' | ')}`;
                    }
                } else if (toolName === 'grep_lore') {
                    const query = (args.query || '').toLowerCase();
                    const hits = [];
                    for (const [name, book] of Object.entries(archiveBooks)) {
                        for (const [uid, entry] of Object.entries(book.entries)) {
                            if ((entry.content || '').toLowerCase().includes(query) || (entry.comment || '').toLowerCase().includes(query)) {
                                hits.push(`[${name}::${uid}] "${entry.comment || uid}": ${(entry.content || '').substring(0, 120)}...`);
                            }
                        }
                    }
                    observation = hits.length > 0 ? hits.join('\n') : `No entries found for "${args.query}".`;
                } else if (toolName === 'inspect_book') {
                    const bookName = args.book_name || '';
                    if (archiveBooks[bookName]) {
                        observation = Object.entries(archiveBooks[bookName].entries)
                            .map(([uid, e]) => `${bookName}::${uid} -- ${e.comment || e.key?.[0] || uid}`)
                            .join('\n');
                    } else {
                        observation = `Book "${bookName}" not found. Available: ${Object.keys(archiveBooks).join(', ') || 'none'}`;
                    }
                } else if (toolName === 'read_entry') {
                    const uid = args.uid || '';
                    const [bookName, id] = uid.split('::');
                    const book = await ctx.loadWorldInfo(bookName);
                    observation = book?.entries?.[id] ? book.entries[id].content : `Entry "${uid}" not found.`;
                } else {
                    observation = `Unknown tool: ${toolName}`;
                }

                broadcastStep('result', observation.substring(0, 200) + (observation.length > 200 ? '...' : ''));

                // Append the tool result so the model sees it on the next turn
                messages.push({
                    role: 'tool',
                    tool_call_id: messages[messages.length - 1].tool_calls[0].id,
                    content: observation
                });

                // commit always ends the research pass
                if (toolName === 'commit') break;
            }
        } // end agent mode

        const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);
        const finishMsg = basicSummaryText ? `Finished in ${totalTime}s -- ${basicSummaryText}` : `Finished in ${totalTime}s`;
        broadcastStep('finish', finishMsg, { time: totalTime, turns });

        // Non-blocking bloat hint and auto-cleanup check
        {
            const CLEANUP_TOKEN_THRESHOLD = settings.routerCleanupTokenThreshold || 300;
            const bloatedCount = Object.values(archiveBooks)
                .flatMap(b => Object.values(b.entries || {}))
                .filter(e => estimateTokens(e.content) >= CLEANUP_TOKEN_THRESHOLD).length;

            _routerNormalRunCount++;
            const cleanupEvery = settings.routerCleanupEvery || 0;
            const shouldAutoCleanup = cleanupEvery > 0 && (_routerNormalRunCount % cleanupEvery === 0) && bloatedCount > 0;

            if (shouldAutoCleanup) {
                broadcastStep('thought', `🧹 Auto-cleanup: ${bloatedCount} bloated entr${bloatedCount > 1 ? 'ies' : 'y'} found. Scheduling cleanup pass...`);
                // Queue non-blockingly so the current pass finishes cleanly first
                setTimeout(() => runRouterPass(null, '__CLEANUP__', null, true), 200);
            } else if (bloatedCount > 0) {
                broadcastStep('thought', `💡 ${bloatedCount} entr${bloatedCount > 1 ? 'ies' : 'y'} may benefit from cleanup (>${CLEANUP_TOKEN_THRESHOLD} tokens). Use the 🧹 button to compress.`);
            }
        }

        return true;
    } catch (e) {
        if (e?.name === 'AbortError') {
            console.log('[Lorebook Agent] Pass aborted by user.');
            broadcastStep('error', 'Stopped by user.');
        } else {
            console.error("[Lorebook Agent] Run failed:", e);
            broadcastStep('error', e.message);
        }
        return false;
    } finally {
        _routerRunning = false;
        _routerController = null;
    }
}

/**
 * Applies the agent's final decision to settings and lorebooks.
 * @param {object} action - The action to apply.
 * @param {object} allBooks - The cached archive books for verification.
 * @param {string} [currentTime=''] - The current time string for timestamping.
 * @param {string} [breadcrumb=''] - The current location hierarchy string (Main :: Sub).
 * @returns {Promise<{success: boolean, errors: string[], recordedIds: string[]}>}
 */
async function applyAction(action, allBooks = {}, currentTime = '', breadcrumb = '') {
    const settings = getSettings();
    const ctx = SillyTavern.getContext();
    let changed = false;
    const errors = [];
    const allBookNames = Object.keys(allBooks);

    const timePrefix = currentTime ? `[${currentTime}] ` : '';

    // 1. Activate/Deactivate
    const activate = action.activate || [];
    const deactivate = action.deactivate || [];
    let newActive = [...(settings.activeRouterKeys || [])];
    let newWorldActive = [...(settings.activeWorldKeys || [])];
    
    // Remove deactivations
    newActive = newActive.filter(k => !deactivate.includes(k));
    newWorldActive = newWorldActive.filter(k => !deactivate.includes(k));
    
    // Add activations
    for (const k of activate) {
        if (typeof k !== 'string' || !k.includes('::')) {
            errors.push(`Invalid ID format: ${k}`);
            continue;
        }
        const [bookName, uid] = k.split('::');
        const exists = allBooks[bookName]?.entries?.[uid];
        
        if (exists) {
            const isWorld = bookName.toLowerCase().endsWith('_world') || bookName.toLowerCase() === 'world';
            if (isWorld) {
                if (!newWorldActive.includes(k)) {
                    newWorldActive.push(k);
                    changed = true;
                }
            } else {
                if (!newActive.includes(k)) {
                    newActive.push(k);
                    changed = true;
                }
            }
        } else {
            errors.push(`Entity not found: ${k}`);
        }
    }
    if (deactivate.length > 0) changed = true;

    // World books do not use physical activation on disk anymore.

    // Sync keywordActivatedKeys: agent ownership trumps keyword-auto tracking.
    // - Explicitly activated: agent owns it now, no longer auto-expires.
    // - Explicitly deactivated: remove from both pools.
    if ((activate.length > 0 || deactivate.length > 0) && Array.isArray(settings.keywordActivatedKeys)) {
        const activateSet = new Set(activate);
        const deactivateSet = new Set(deactivate);
        settings.keywordActivatedKeys = settings.keywordActivatedKeys.filter(k =>
            !activateSet.has(k) && !deactivateSet.has(k)
        );
    }

    // 2. Update existing
    const updates = action.update || [];
    for (const up of updates) {
        const [bookName, uid] = up.id.split('::');
        const book = await ctx.loadWorldInfo(bookName);
        if (book?.entries?.[uid]) {
            // Strip [ID:] stamp from anywhere in the delta (model sometimes echoes it)
            let delta = (up.content || '').replace(/\[ID:[^\]]+\]\n?/gi, '').trim();
            // Append delta to the existing chronicle
            const existing = (book.entries[uid].content || '').replace(/^\[ID:[^\]]+\]\n?/i, '').trimEnd();
            delta = deduplicateContent(existing, delta);
            if (delta && timePrefix && !delta.includes('[Day')) {
                delta = timePrefix.trim() + ' ' + delta;
            }
            book.entries[uid].content = existing && delta ? `${existing}\n${delta}` : (existing || delta);
            await ctx.saveWorldInfo(bookName, book);
            changed = true;
        }
    }

    // 2b. Rewrite (full content replacement — no append, no dedup)
    const rewriteIds = [];
    for (const rw of (action.rewrite || [])) {
        const [bookName, uid] = rw.id.split('::');
        const book = await ctx.loadWorldInfo(bookName);
        if (book?.entries?.[uid]) {
            book.entries[uid].content = rw.content;
            await ctx.saveWorldInfo(bookName, book);
            rewriteIds.push(rw.id);
            changed = true;
        } else {
            errors.push(`Rewrite target not found: ${rw.id}`);
        }
    }

    // 2c. Consolidate (many-to-one merge with deletion)
    const consolidateIds = [];
    for (const op of (action.consolidate || [])) {
        // Update the survivor with merged content
        const [sBook, sUid] = op.survivor.split('::');
        const sBookData = await ctx.loadWorldInfo(sBook);
        if (sBookData?.entries?.[sUid]) {
            sBookData.entries[sUid].content = op.content;
            await ctx.saveWorldInfo(sBook, sBookData);
            consolidateIds.push(op.survivor);
        } else {
            errors.push(`Consolidate survivor not found: ${op.survivor}`);
            continue;
        }

        // Delete each target and scrub from active/keyword key lists
        for (const targetId of (op.targets || [])) {
            if (targetId === op.survivor) continue; // Do not delete the survivor entry!
            const [tBook, tUid] = targetId.split('::');
            const tBookData = await ctx.loadWorldInfo(tBook);
            if (tBookData?.entries?.[tUid]) {
                delete tBookData.entries[tUid];
                await ctx.saveWorldInfo(tBook, tBookData);
            } else {
                errors.push(`Consolidate target not found: ${targetId}`);
            }
            settings.activeRouterKeys = (settings.activeRouterKeys || [])
                .filter(k => k !== targetId);
            settings.activeWorldKeys = (settings.activeWorldKeys || [])
                .filter(k => k !== targetId);
            newActive = newActive.filter(k => k !== targetId);
            newWorldActive = newWorldActive.filter(k => k !== targetId);
            if (Array.isArray(settings.keywordActivatedKeys)) {
                settings.keywordActivatedKeys = settings.keywordActivatedKeys
                    .filter(k => k !== targetId);
            }
        }
        changed = true;
    }

    // 3. Record new (with Deduplication)
    // Group entries by target book and commit once per book to avoid UID collisions
    const records = action.record || [];
    const prefix = getLivePrefix();
    const baseBook = prefix || 'World Chronicle';
    const recordedIds = [];

    // -- Phase A: Route each record to its target book --
    const catMap = { 'NPC': 'NPCs', 'LOC': 'Locations', 'QUEST': 'Quests', 'FAC': 'Factions', 'EVENT': 'Events', 'WORLD': 'World' };
    // Extend with user-defined custom tags so they get their own books (e.g. WEATHER ? prefix_Weather)
    for (const ct of (settings.routerCustomTags || [])) {
        const t = ct.tag.toUpperCase();
        if (!catMap[t]) catMap[t] = t.charAt(0) + t.slice(1).toLowerCase();
    }
    /** @type {Map<string, Array>} */
    const bookQueue = new Map();

    const knownBookNames = Object.keys(allBooks);
    for (const rec of records) {
        const cat = (rec.category || rec.comment || '').toUpperCase();
        const catName = Object.keys(catMap).find(k => cat.includes(k));
        const idealTargetBook = catName ? (prefix ? `${prefix}_${catMap[catName]}` : catMap[catName]) : baseBook;
        
        let targetBook = idealTargetBook;
        const idealLower = idealTargetBook.toLowerCase();
        for (const known of knownBookNames) {
            if (known.toLowerCase() === idealLower) {
                targetBook = known;
                break;
            }
        }

        // Strip any accidental "TAG: " prefix the model may have included in the label
        // e.g. "FAC: Iron Syndicate" ? "Iron Syndicate", "STATS: Thalric Thorne" ? "Thalric Thorne"
        if (rec.label) {
            rec.label = rec.label.replace(/^[A-Z_]{2,10}:\s+/i, '').trim();
        }

        // Breadcrumb enrichment is intentionally omitted: the model is instructed in the system
        // prompt to include the full hierarchy in the label itself (e.g. "Khelt :: Section 4").
        // Auto-prepending the current breadcrumb causes corruption when recording parent/sibling
        // locations that are not children of the current scene.

        const isWorld = targetBook.toLowerCase().endsWith('_world') || targetBook.toLowerCase() === 'world';

        if (cat.includes('EVENT')) {
            if (currentTime && !rec.label.includes('[Day')) {
                rec.label = `[${currentTime}] ${rec.label}`;
            }
        }

        if (isWorld) {
            if (rec.label && !rec.content.includes('[Day') && !rec.content.startsWith('[')) {
                rec.content = `[${rec.label}] ` + rec.content;
            }
            rec.keys = [];
        } else {
            if (timePrefix && !rec.content.includes('[Day')) {
                rec.content = timePrefix + rec.content;
            }
            // Add location hierarchy keywords (plain fragments, no 'In:' prefix)
            // Matches status footer tokens for native ST keyword triggering.
            {
                const parts = (breadcrumb || '').split(' :: ').filter(Boolean);
                rec.keys = rec.keys || [];
                for (const part of parts) {
                    if (!rec.keys.includes(part)) rec.keys.push(part);
                }
            }
            rec.keys = cleanKeys(rec.keys || []);
        }

        if (!bookQueue.has(targetBook)) bookQueue.set(targetBook, []);
        bookQueue.get(targetBook).push(rec);
    }


    // -- Phase B: For each book, load existing entries, append new ones, save to disk via HTTP API --
    /** @type {Set<string>} books written this pass that need activation */
    const booksWritten = new Set();
    for (const [targetBook, recs] of bookQueue.entries()) {
        if (settings.debugMode) console.log(`[RPG Tracker] Writing ${recs.length} entries to: ${targetBook}`);

        // Attempt to load existing book directly from backend (prevents wiping un-cached books)
        let bookData = null;
        try {
            bookData = await ctx.loadWorldInfo(targetBook);
        } catch (_) { }

        if (!bookData) {
            try {
                const res = await fetch('/api/worldinfo/get', {
                    method: 'POST',
                    headers: getRequestHeaders(),
                    body: JSON.stringify({ name: targetBook })
                });
                if (res.ok) {
                    const data = await res.json();
                    if (data && typeof data === 'object' && data.entries) {
                        bookData = data;
                    }
                }
            } catch (_) {}
        }

        if (!bookData) {
            bookData = { entries: {}, name: targetBook, scan_depth: 4, token_budget: 400, recursive: false, extensions: {} };
        }

        for (const rec of recs) {
            // Deduplication: skip if an entry with this label already exists
            const cleanLabel = (rec.label || '').replace(/^\[.*?\]\s*/i, '').toLowerCase().trim();
            let existingUid = null;
            for (const [uid, entry] of Object.entries(bookData.entries)) {
                const entryLabel = (entry.comment || '').replace(/^\[.*?\]\s*/i, '').toLowerCase().trim();
                if (entryLabel === cleanLabel) { existingUid = uid; break; }
            }

            const isWorldBook = targetBook.toLowerCase().endsWith('_world') || targetBook.toLowerCase() === 'world';
            if (existingUid) {
                const fullId = `${targetBook}::${existingUid}`;
                // Strip [ID:] stamp from anywhere in the delta (model sometimes echoes it)
                let delta = (rec.content || '').replace(/\[ID:[^\]]+\]\n?/gi, '').trim();
                
                if (isWorldBook) {
                    // Overwrite instead of appending for World Progression reports
                    bookData.entries[existingUid].content = delta;
                    bookData.entries[existingUid].key = [];
                    bookData.entries[existingUid].constant = false;
                    bookData.entries[existingUid].disable = true;
                } else {
                    // Append delta to existing chronicle (dedup path)
                    const existing = (bookData.entries[existingUid].content || '').replace(/^\[ID:[^\]]+\]\n?/i, '').trimEnd();
                    delta = deduplicateContent(existing, delta);
                    bookData.entries[existingUid].content = existing && delta ? `${existing}\n${delta}` : (existing || delta);

                    const keys = bookData.entries[existingUid].key || [];
                    (rec.keys || []).forEach(k => { if (!keys.includes(k)) keys.push(k); });
                    bookData.entries[existingUid].key = cleanKeys(keys);
                }

                // Update comment/title to the latest label (keeps event timestamps up-to-date)
                if (rec.label) {
                    bookData.entries[existingUid].comment = rec.label;
                }
                
                if (isWorldBook) {
                    if (!newWorldActive.includes(fullId)) newWorldActive.push(fullId);
                } else {
                    if (!newActive.includes(fullId)) newActive.push(fullId);
                }
                recordedIds.push(`${fullId} (updated)`);
            } else {
                // Append new entry with the next sequential UID
                const uids = Object.keys(bookData.entries).map(Number).filter(n => !isNaN(n));
                const nextUid = uids.length > 0 ? Math.max(...uids) + 1 : 0;
                const fullId = `${targetBook}::${nextUid}`;
                bookData.entries[nextUid] = {
                    uid: nextUid,
                    key: isWorldBook ? [] : (rec.keys || [rec.label]),
                    keysecondary: [],
                    comment: rec.label || 'LORE_GEN',
                    content: rec.content || '',
                    constant: false,
                    selective: false, selectiveLogic: 0, addMemo: true,
                    order: settings.routerDefaultOrder ?? 100,
                    position: settings.routerDefaultPosition ?? 0,
                    disable: isWorldBook ? true : !settings.routerNativeKeywordActivation,
                    probability: 100, useProbability: false,
                    depth: settings.routerDefaultDepth ?? 4,
                    role: (settings.routerDefaultPosition === 4) ? (settings.routerDefaultRole ?? 0) : null,
                    group: '', groupOverride: false, groupWeight: 100,
                };
                if (isWorldBook) {
                    if (!newWorldActive.includes(fullId)) newWorldActive.push(fullId);
                } else {
                    if (!newActive.includes(fullId)) newActive.push(fullId);
                }
                recordedIds.push(fullId);
            }
            changed = true;
        }

        // Always use the raw HTTP API to guarantee disk persistence.
        // ctx.saveWorldInfo only flushes books already in ST's in-memory registry,
        // silently dropping any new (unregistered) books. The /api/worldinfo/edit
        // endpoint writes directly to disk with no registry requirement.
        const saveRes = await fetch('/api/worldinfo/edit', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ name: targetBook, data: bookData })
        });
        if (!saveRes.ok) {
            console.error(`[RPG Tracker] Failed to save ${targetBook}: HTTP ${saveRes.status}`);
        } else {
            if (settings.debugMode) console.log(`[RPG Tracker] Saved ${recs.length} entries to ${targetBook}`);
            // Cache bust: write bookData into ST's in-memory registry so that the
            // subsequent renderRouterUI -> loadWorldInfo call sees fresh entries immediately
            // (the raw HTTP API bypasses the in-memory cache; this syncs them up).
            if (typeof ctx.saveWorldInfo === 'function') {
                try { await ctx.saveWorldInfo(targetBook, bookData); } catch (_) { /* non-fatal */ }
            }
            booksWritten.add(targetBook);
        }
    }

    // Bulk-activate all written books after all disk writes are done.
    // Doing this once at the end avoids race conditions where ST's world info
    // list hasn't re-indexed yet when the first /world command fires.
    if (booksWritten.size > 0 && typeof ctx.executeSlashCommandsWithOptions === 'function') {
        await new Promise(r => setTimeout(r, 400));
        if (typeof ctx.updateWorldInfoList === 'function') await ctx.updateWorldInfoList();
        for (const bookName of booksWritten) {
            await ctx.executeSlashCommandsWithOptions(`/world state=on silent=true "${bookName}"`);
            await new Promise(r => setTimeout(r, 100));
        }
        if (settings.debugMode) console.log(`[RPG Tracker] Activated books: ${[...booksWritten].join(', ')}`);
    }

    // Budget enforcement is handled by the agent via overflow instruction in context.
    // No FIFO pruning here — the agent must explicitly deactivate entries.
    settings.activeRouterKeys = newActive;
    settings.activeWorldKeys = newWorldActive;

    // 4. Delete
    const deleteIds = action.delete_ids || [];
    for (const id of deleteIds) {
        const parts = id.split('::');
        if (parts.length < 2) continue;
        const [bookName, uid] = parts;
        const book = await ctx.loadWorldInfo(bookName);
        if (book?.entries?.[uid]) {
            delete book.entries[uid];
            await ctx.saveWorldInfo(bookName, book);
            // Also remove from active keys if present
            settings.activeRouterKeys = settings.activeRouterKeys.filter(k => k !== id);
            settings.activeWorldKeys = (settings.activeWorldKeys || []).filter(k => k !== id);
            changed = true;
        }
    }

    if (changed) {
        const timestamp = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        settings.routerLog.unshift({
            time: timestamp,
            activate: activate,
            deactivate: deactivate,
            record: recordedIds,
            delete: deleteIds,
            rewrite: rewriteIds,
            consolidate: consolidateIds,
            reason: action.reason || (settings.routerBasicMode ? "Tag-based update." : "Agent tool update.")
        });
        if (settings.routerLog.length > 50) settings.routerLog.length = 50;

        // Track campaign lorebooks per chat_id so they auto-activate on chat switch
        if (booksWritten.size > 0) {
            const chatId = typeof globalThis._rpgCurrentChatId === 'function'
                ? globalThis._rpgCurrentChatId()
                : null;
            if (chatId) {
                if (!settings.chatStates) settings.chatStates = {};
                if (!settings.chatStates[chatId]) settings.chatStates[chatId] = {};
                const existing = new Set(settings.chatStates[chatId].campaignBooks || []);
                for (const b of booksWritten) existing.add(b);
                settings.chatStates[chatId].campaignBooks = [...existing];
            }
        }

        ctx.saveSettingsDebounced();
        document.dispatchEvent(new CustomEvent('rt_lore_agent_updated'));
    }

    return { success: true, errors, recordedIds };
}

/**
 * Restores a past lorebook snapshot from routerHistory.
 * - Deletes any lorebook that was CREATED during the pass (wasn't in snapshot).
 * - Overwrites any lorebook that was MODIFIED during the pass back to its pre-pass content.
 * @param {number} index - 0 = most recent pre-pass snapshot.
 * @returns {Promise<boolean>}
 */
export async function rollbackRouterPass(index = 0) {
    const settings = getSettings();
    const ctx = SillyTavern.getContext();
    const history = settings.routerHistory || [];

    if (index < 0 || index >= history.length) {
        console.warn('[RPG Tracker] Rollback: invalid index', index);
        return false;
    }

    const snapshot = history[index];
    if (!snapshot) return false;

    try {
        const prePassBooks = new Set(Object.keys(snapshot.bookSnapshots || {}));
        const prefix = getLivePrefix();

        // -- Step 1: Delete lorebooks that were CREATED during the pass --------
        // Only consider books under the live campaign prefix. If the prefix is missing,
        // scanning "all" lorebooks would treat every unrelated book as newly created
        // and delete or wipe anything not present in this pass's snapshot.
        const allCurrentNames = await getWorldInfoNamesSafe();
        const scopedCurrent = prefix
            ? allCurrentNames.filter(n => bookBelongsToPrefix(n, prefix))
            : [];
        if (!prefix && allCurrentNames.length) {
            console.warn('[RPG Tracker] Rollback: no campaign prefix — skipping delete-new-books step (would otherwise touch the entire lore library).');
        }

        for (const bookName of scopedCurrent) {
            if (prePassBooks.has(bookName)) continue; // Pre-existed ? restore below, don't delete
            // This book was CREATED during the pass ? permanently delete it
            let deleted = false;
            try {
                const delRes = await fetch('/api/worldinfo/delete', {
                    method: 'POST',
                    headers: getRequestHeaders(),
                    body: JSON.stringify({ name: bookName })
                });
                deleted = delRes.ok;
            } catch (_) { /* endpoint may not exist on older ST builds */ }

            if (!deleted) {
                // Fallback: clear all entries so the book is effectively empty
                const emptyBook = { entries: {}, name: bookName, scan_depth: 4, token_budget: 400, recursive: false, extensions: {} };
                await fetch('/api/worldinfo/edit', {
                    method: 'POST',
                    headers: getRequestHeaders(),
                    body: JSON.stringify({ name: bookName, data: emptyBook })
                });
                if (typeof ctx.saveWorldInfo === 'function') {
                    try { await ctx.saveWorldInfo(bookName, emptyBook); } catch (_) {}
                }
            }
        }

        // Re-index so ST knows about deletions before we start restoring
        if (typeof ctx.updateWorldInfoList === 'function') {
            try { await ctx.updateWorldInfoList(); } catch (_) {}
        }

        // -- Step 2: Restore pre-pass lorebooks to their snapshotted state -----
        for (const [bookName, bookData] of Object.entries(snapshot.bookSnapshots || {})) {
            const saveRes = await fetch('/api/worldinfo/edit', {
                method: 'POST',
                headers: getRequestHeaders(),
                body: JSON.stringify({ name: bookName, data: bookData })
            });
            if (!saveRes.ok) {
                console.error(`[RPG Tracker] Rollback: failed to restore ${bookName}: HTTP ${saveRes.status}`);
                continue;
            }
            // Bust ST in-memory cache so the UI sees the restored data immediately
            if (typeof ctx.saveWorldInfo === 'function') {
                try { await ctx.saveWorldInfo(bookName, bookData); } catch (_) { /* non-fatal */ }
            }
        }

        // -- Step 3: Restore active keys ---------------------------------------
        settings.activeRouterKeys = JSON.parse(JSON.stringify(snapshot.activeRouterKeys || []));
        settings.activeWorldKeys = JSON.parse(JSON.stringify(snapshot.activeWorldKeys || []));

        // -- Step 4: Trim snapshots newer than the restored point --------------
        settings.routerHistory = history.slice(index + 1);

        ctx.saveSettingsDebounced();
        document.dispatchEvent(new CustomEvent('rt_lore_agent_updated'));
        return true;
    } catch (e) {
        console.error('[RPG Tracker] Rollback failed:', e);
        return false;
    }
}

/**
 * Re-applies a previously undone agent pass (redo).
 * Pushes prePassSnapshot back onto routerHistory and restores lorebooks to postPassState.
 * @param {{ timestamp: string, activeRouterKeys: string[], bookSnapshots: Record<string, any> }} prePassSnapshot
 * @param {{ timestamp: string, activeRouterKeys: string[], bookSnapshots: Record<string, any> }} postPassState
 * @returns {Promise<boolean>}
 */
export async function reapplyRouterPass(prePassSnapshot, postPassState) {
    const settings = getSettings();
    const ctx = SillyTavern.getContext();

    try {
        // Step 1: Put the pre-pass snapshot back so the user can undo again
        if (!settings.routerHistory) settings.routerHistory = [];
        settings.routerHistory.unshift(prePassSnapshot);
        if (settings.routerHistory.length > 5) settings.routerHistory.length = 5;

        // Step 2: Restore lorebooks to the post-pass state
        for (const [bookName, bookData] of Object.entries(postPassState.bookSnapshots || {})) {
            const saveRes = await fetch('/api/worldinfo/edit', {
                method: 'POST',
                headers: getRequestHeaders(),
                body: JSON.stringify({ name: bookName, data: bookData })
            });
            if (!saveRes.ok) {
                console.error(`[RPG Tracker] Redo: failed to restore ${bookName}: HTTP ${saveRes.status}`);
                continue;
            }
            if (typeof ctx.saveWorldInfo === 'function') {
                try { await ctx.saveWorldInfo(bookName, bookData); } catch (_) {}
            }
        }

        if (typeof ctx.updateWorldInfoList === 'function') {
            try { await ctx.updateWorldInfoList(); } catch (_) {}
        }

        // Step 3: Restore active keys to the post-pass state
        settings.activeRouterKeys = JSON.parse(JSON.stringify(postPassState.activeRouterKeys || []));
        settings.activeWorldKeys = JSON.parse(JSON.stringify(postPassState.activeWorldKeys || []));

        ctx.saveSettingsDebounced();
        document.dispatchEvent(new CustomEvent('rt_lore_agent_updated'));
        return true;
    } catch (e) {
        console.error('[RPG Tracker] Redo failed:', e);
        return false;
    }
}


/**
 * Parses basic narrative tags [[TAG: ...]]
 */
function parseBasicTags(text, archiveBooks) {
    const action = { record: [], update: [], activate: [], deactivate: [], delete_ids: [], rewrite: [], consolidate: [] };
    const settings = getSettings();

    // REWRITE tag parser
    const rewriteRegex = /\[\[REWRITE:\s*([^|]+)\|([\s\S]*?)\]\]/gi;
    let rw;
    while ((rw = rewriteRegex.exec(text)) !== null) {
        const id      = rw[1].trim();
        const content = rw[2].trim();
        action.rewrite.push({ id, content });
    }

    // CONSOLIDATE tag parser
    const consolidateRegex = /\[\[CONSOLIDATE:\s*([^|]+)\|([^|]+)\|([\s\S]*?)\]\]/gi;
    let cm;
    while ((cm = consolidateRegex.exec(text)) !== null) {
        const targets  = cm[1].split(',').map(s => s.trim()).filter(Boolean);
        const survivor = cm[2].trim();
        const content  = cm[3].trim();
        action.consolidate.push({ targets, survivor, content });
    }

    const processMatch = (name, content, keywords, category) => {
        name = name.trim().replace(/^[A-Z_]{2,10}:\s+/i, '').trim();
        content = content.trim();
        const keys = (keywords || '').split(',').map(k => k.trim());

        // Check for existing by name (stripping bracketed prefixes to match applyAction's matching logic)
        let existingId = null;
        const cleanName = name.replace(/^\[.*?\]\s*/i, '').toLowerCase().trim();
        for (const [bookName, book] of Object.entries(archiveBooks)) {
            for (const [uid, entry] of Object.entries(book.entries)) {
                const entryComment = (entry.comment || '').replace(/^\[.*?\]\s*/i, '').toLowerCase().trim();
                if (entryComment === cleanName) {
                    existingId = `${bookName}::${uid}`;
                    break;
                }
            }
            if (existingId) break;
        }

        if (existingId) {
            action.update.push({ id: existingId, content });
        } else {
            action.record.push({ label: name, content, keys, category });
        }
    };

    // Generic tag parser: [[TAG: ...]]
    const tagRegex = /\[\[(\w+):\s*([\s\S]*?)\]\]/gi;
    let match;

    while ((match = tagRegex.exec(text)) !== null) {
        const tagName = match[1].toUpperCase();
        if (tagName === 'REWRITE' || tagName === 'CONSOLIDATE') continue; // Collision protection

        const inner = match[2];
        const parts = inner.split('|').map(p => p.trim());

        if ((tagName === 'ACTIVATE' || tagName === 'DEACTIVATE' || tagName === 'DELETE') && parts.length >= 1) {
            const name = inner.trim().toLowerCase();
            let targetList = [];
            if (tagName === 'ACTIVATE') targetList = action.activate;
            else if (tagName === 'DEACTIVATE') targetList = action.deactivate;
            else if (tagName === 'DELETE') targetList = action.delete_ids;

            for (const [bookName, book] of Object.entries(archiveBooks)) {
                for (const [uid, entry] of Object.entries(book.entries)) {
                    if ((entry.comment || '').toLowerCase() === name) {
                        targetList.push(`${bookName}::${uid}`);
                        break;
                    }
                }
            }
        } else if (parts.length >= 3) {
            // Generic: first = name, last = keywords, everything in between = body (joined with blank line).
            // Supports any number of middle slots so renaming or adding slots in the UI works automatically.
            const name = parts[0];
            const keywords = parts[parts.length - 1];
            const body = parts.slice(1, -1).filter(Boolean).join('\n\n');
            processMatch(name, body, keywords, tagName);
        }
    }

    return action;
}

/**
 * Shared helper to add an entry to a specific lorebook.
 */
async function addLorebookEntry(lorebookName, entryData, allNames) {
    const ctx = SillyTavern.getContext();
    if (!allNames) allNames = await getWorldInfoNamesSafe();
    
    let bookData = null;
    if (allNames.includes(lorebookName)) {
        try { bookData = await ctx.loadWorldInfo(lorebookName); } catch (_) {}
    }
    
    if (!bookData) {
        try {
            const res = await fetch('/api/worldinfo/get', {
                method: 'POST',
                headers: getRequestHeaders(),
                body: JSON.stringify({ name: lorebookName })
            });
            if (res.ok) {
                const data = await res.json();
                if (data && typeof data === 'object' && data.entries) {
                    bookData = data;
                }
            }
        } catch (_) {}
    }

    if (!bookData) {
        if (getSettings().debugMode) console.log(`[RPG Tracker] Initializing new lorebook: ${lorebookName}`);
        bookData = { 
            entries: {},
            name: lorebookName,
            scan_depth: 4,
            token_budget: 400,
            recursive: false,
            extensions: {}
        };
    }

    // Always reload fresh from disk to get accurate existing UIDs
    // (avoids uid:0 collision when multiple entries are written to a new book in one pass)
    const freshData = bookData;
    const existingUids = Object.keys(freshData?.entries || {}).map(Number).filter(n => !isNaN(n));
    const nextUid = existingUids.length > 0 ? Math.max(...existingUids) + 1 : 0;
    
    const writeTarget = freshData || bookData;
    writeTarget.entries[nextUid] = {
        uid: nextUid,
        key: entryData.keys || [entryData.label || entryData.id],
        keysecondary: [],
        comment: entryData.label || entryData.id || entryData.category || entryData.comment || 'LORE_GEN',
        content: entryData.content,
        constant: false,
        selective: false,
        selectiveLogic: 0,
        addMemo: true,
        order: 100,
        position: 0,
        disable: false,
        probability: 100,
        useProbability: false,
        depth: 4,
        group: '',
        groupOverride: false,
        groupWeight: 100,
    };
    
    await ctx.saveWorldInfo(lorebookName, writeTarget);
    
    // Update allNames cache so subsequent calls know this book now exists
    if (!allNames.includes(lorebookName)) allNames.push(lorebookName);
    
    // Trigger SillyTavern UI/Internal refresh
    if (ctx.reloadWorldInfoEditor) ctx.reloadWorldInfoEditor(lorebookName);
    if (ctx.eventSource && ctx.event_types) {
        ctx.eventSource.emit(ctx.event_types.WORLD_INFO_UPDATED, lorebookName);
    }
    
    return `${lorebookName}::${nextUid}`;
}

/**
 * Manual scene archiving tool.
 */
export async function saveSceneToLorebook(hint = "") {
    const settings = getSettings();
    const ctx = SillyTavern.getContext();
    if (!ctx.generateRaw) return;

    try {
        (/** @type {any} */ (toastr)).info("Saving scene...", "Lorebook Agent");
        
        const { chat } = ctx;
        const filteredChat = (chat || []).filter(m => !m.is_system && m.mes && m.mes.trim());
        const recentChat = filteredChat.slice(-5).map(m => `${(/** @type {any} */ (m)).is_user ? 'Player' : ((/** @type {any} */ (m)).name || 'Narrator')}: ${((/** @type {any} */ (m)).mes || (/** @type {any} */ (m)).content || '').replace(/<[^>]+>/g, '')}`).join('\n\n');

        const systemPrompt = `You are the Scene Archiver. Based on the recent narrative, generate a Lorebook entry for this scene.
Output a JSON object:
{
  "id": "scene_unique_name",
  "desc": "Short description",
  "content": "Full summary of the event",
  "keys": ["Keyword1", "Keyword2"]
}`;

        const userPrompt = `## RECENT CHAT\n${recentChat}\n\n${hint ? `## USER HINT\n${hint}\n\n` : ""}Generate the JSON scene save.`;

        const routerSettings = {
            ...settings,
            connectionSource: settings.routerConnectionSource || "default",
            maxTokens: (settings.routerMaxTokens !== undefined && settings.routerMaxTokens !== null && settings.routerMaxTokens !== '') ? Number(settings.routerMaxTokens) : 1000,
        };

        const result = await sendStateRequest(routerSettings, systemPrompt, userPrompt);
        const match = result.match(/\{[\s\S]*\}/);
        if (match) {
            const data = JSON.parse(match[0]);
            
            const prefix = getLivePrefix();
            const lorebookName = prefix ? `${prefix}World_Chronicle` : 'World Chronicle';
            const newId = await addLorebookEntry(lorebookName, {
                id: data.id,
                keys: data.keys,
                content: data.content,
                comment: 'LORE_SCENE'
            });
            
            const timestamp = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
            settings.routerLog.unshift({
                time: timestamp,
                activate: [newId], deactivate: [],
                reason: `Saved scene: ${data.desc} -> ${lorebookName} (${data.id})`
            });
            settings.activeRouterKeys.push(newId);
            ctx.saveSettingsDebounced();
            document.dispatchEvent(new CustomEvent('rt_lore_agent_updated'));
            
            (/** @type {any} */ (toastr)).success(`Saved scene: ${data.desc}`, 'Lorebook Agent');
        }
    } catch (e) {
        console.error("[Lorebook Agent] Save scene failed:", e);
        (/** @type {any} */ (toastr)).error('Failed to save scene.', 'Lorebook Agent');
    }
}

/**
 * Fetches a manifest of all campaign-scoped lorebook entries for the UI.
 */
export async function getLorebookManifest() {
    const settings = getSettings();
    const ctx = SillyTavern.getContext();
    const prefix = getLivePrefix();
    
    // Always flush ST's registry from disk first so books written via HTTP API are visible
    if (typeof ctx.updateWorldInfoList === 'function') {
        try { await ctx.updateWorldInfoList(); } catch (_) {}
    }

    const names = await getWorldInfoNamesSafe();
    // With no prefix, show nothing ? the user hasn't set a campaign yet.
    if (!prefix) return [];
    const scoped = names.filter(n => bookBelongsToPrefix(n, prefix));
    
    // Fallback 1: books referenced in activeRouterKeys (not yet in registry)
    const activeBookNames = (settings.activeRouterKeys || [])
        .map(k => k.split('::')[0])
        .filter(Boolean);
    for (const n of activeBookNames) {
        if (!scoped.includes(n) && bookBelongsToPrefix(n, prefix)) {
            scoped.push(n);
        }
    }
    
    // Fallback 2: books referenced in routerLog records (catches deactivated entries
    // whose books are no longer in activeRouterKeys nor in ST's registry yet)
    const logBookNames = (settings.routerLog || [])
        .flatMap(e => [...(e.record || []), ...(e.activate || [])].map(id => id.split('::')[0]))
        .filter(Boolean);
    for (const n of logBookNames) {
        if (!scoped.includes(n) && bookBelongsToPrefix(n, prefix)) {
            scoped.push(n);
        }
    }
    
    const manifest = [];
    for (const n of scoped) {
        const b = await ctx.loadWorldInfo(n);
        if (!b?.entries) continue;
        for (const [uid, entry] of Object.entries(b.entries)) {
            manifest.push({
                id: `${n}::${uid}`,
                book: n,
                uid: uid,
                label: entry.comment || (entry.key?.[0]) || uid,
                keys: entry.key || [],
                content: entry.content,
                is_active: settings.activeRouterKeys?.includes(`${n}::${uid}`) || settings.activeWorldKeys?.includes(`${n}::${uid}`)
            });
        }
    }
    return manifest;
}

/**
 * Deletes a lorebook entry by ID (Book::UID).
 */
export async function deleteLorebookEntry(id) {
    const [bookName, uid] = id.split('::');
    if (!bookName || !uid) return false;
    
    const ctx = SillyTavern.getContext();
    const book = await ctx.loadWorldInfo(bookName);
    if (!book?.entries || !book.entries[uid]) return false;
    
    delete book.entries[uid];
    await ctx.saveWorldInfo(bookName, book);
    
    // Also remove from active list if it was there
    const settings = getSettings();
    if (settings.activeRouterKeys?.includes(id)) {
        settings.activeRouterKeys = settings.activeRouterKeys.filter(k => k !== id);
    }
    if (settings.activeWorldKeys?.includes(id)) {
        settings.activeWorldKeys = settings.activeWorldKeys.filter(k => k !== id);
    }
    
    return true;
}

/**
 * Updates editable fields on a single lorebook entry in-place.
 * Reads the book first so other fields (disable, extensions, etc.) are preserved.
 * @param {string} id - "BookName::uid"
 * @param {{ content?: string, key?: string[], comment?: string }} fields
 * @returns {Promise<boolean>}
 */
export async function updateLorebookEntry(id, fields) {
    const [bookName, uid] = id.split('::');
    if (!bookName || !uid) return false;

    const ctx = SillyTavern.getContext();
    const book = await ctx.loadWorldInfo(bookName);
    if (!book?.entries || !book.entries[uid]) return false;

    const entry = book.entries[uid];
    if (fields.content  !== undefined) entry.content = fields.content;
    if (fields.comment  !== undefined) entry.comment = fields.comment;
    if (fields.key      !== undefined) entry.key     = cleanKeys(fields.key);

    try {
        await ctx.saveWorldInfo(bookName, book);
        return true;
    } catch (e) {
        console.error('[RPG Tracker] updateLorebookEntry failed:', e);
        return false;
    }
}

/**
 * Scans the assistant's narrative output for entry keywords across all scoped
 * lorebooks. Entries whose keys appear in the text are immediately added to
 * activeRouterKeys so the Lorebook Agent sees their full content this turn.
 *
 * Must be called BEFORE runRouterPass on each generation.
 *
 * @param {string} narrativeText - The assistant message that just generated.
 * @param {{ sweepEnabled?: boolean }} [opts]
 * @returns {Promise<string[]>} IDs (Book::uid) of entries newly activated this pass.
 */
export async function scanAssistantOutputForKeywords(narrativeText, opts = {}) {
    if (!narrativeText) return [];
    const sweepEnabled = opts.sweepEnabled !== false; // default true
    const settings = getSettings();
    if (!settings.routerEnabled) return [];

    const ctx = SillyTavern.getContext();
    const prefix = getLivePrefix();
    if (!prefix) return [];

    // Fast Path: use the campaignBooks ownership list if available.
    // This avoids calling updateWorldInfoList() — the same 90-second registry scan
    // that was causing the chat-switch latency — on EVERY generation.
    const chatId = typeof globalThis._rpgCurrentChatId === 'function' ? globalThis._rpgCurrentChatId() : null;
    const knownBooks = chatId ? (settings.chatStates?.[chatId]?.campaignBooks || []) : [];

    let booksToScan;
    if (knownBooks.length > 0) {
        // We know exactly which books belong to this campaign — no registry scan needed.
        booksToScan = [...knownBooks];
    } else {
        // Fallback for first-time chats: discover books via in-memory registry.
        // updateWorldInfoList() is intentionally NOT called here — it triggers a
        // full disk re-index on every message send, causing multi-second latency
        // for users whose chatStates.campaignBooks is empty (new campaigns, no
        // lorebook entries yet). The routerLog fallback below already catches any
        // books not yet visible in the in-memory registry at zero I/O cost.
        // runRouterPass calls updateWorldInfoList() after actual book writes (line ~1298),
        // so the registry is already current by the time the next scan fires.
        const allNames = await getWorldInfoNamesSafe();
        const scoped = allNames.filter(n => bookBelongsToPrefix(n, prefix));

        // Also sweep books referenced in routerLog (catches books not yet re-indexed)
        const logBookNames = (settings.routerLog || [])
            .flatMap(e => [...(e.record || []), ...(e.activate || [])].map(id => id.split('::')[0]))
            .filter(Boolean);
        const scopedSet = new Set(scoped);
        for (const n of logBookNames) {
            if (bookBelongsToPrefix(n, prefix)) scopedSet.add(n);
        }
        booksToScan = [...scopedSet];
    }

    // ── Forward pass: activate entries whose keywords appear in the new narrative ──
    // ── or in the recent history window (Retroactive Lookback).            ──
    const lowerText = narrativeText.toLowerCase();
    const chat = ctx.chat || [];
    const recentMessages = chat.filter(m => !m.is_system); // exclude system messages

    const currentActive = new Set(settings.activeRouterKeys || []);
    const currentKeyword = new Set(settings.keywordActivatedKeys || []);
    const newlyTriggered = [];

    // Cache loaded books so the reverse sweep can reuse them without re-loading.
    /** @type {Map<string, any>} */
    const bookCache = new Map();

    for (const bookName of booksToScan) {
        // _Skeleton books are strictly for World Progression engine — never inject into narrative
        if (bookName.toLowerCase().endsWith('_skeleton')) continue;
        const book = await ctx.loadWorldInfo(bookName);
        if (!book?.entries) continue;
        bookCache.set(bookName, book);

        for (const [uid, entry] of Object.entries(book.entries)) {
            const fullId = `${bookName}::${uid}`;
            if (currentActive.has(fullId)) continue; // already active — skip

            const keywords = Array.isArray(entry.key) ? entry.key : [];
            if (keywords.length === 0) continue;

            // Check the current narrative text (discovery)
            let matched = keywords.some(kw =>
                typeof kw === 'string' && kw.length > 0 &&
                lowerText.includes(kw.toLowerCase())
            );

            // Retroactive lookback: check history window if not matched in the current text
            if (!matched) {
                const depth = (typeof entry.depth === 'number' && entry.depth > 0) ? entry.depth : (book.scan_depth ?? 4);
                const window = recentMessages.slice(-depth);
                const windowText = window.map(m => (m.mes || m.content || '')).join(' ').toLowerCase();
                matched = keywords.some(kw =>
                    typeof kw === 'string' && kw.length > 0 &&
                    windowText.includes(kw.toLowerCase())
                );
            }

            if (matched) {
                currentActive.add(fullId);
                currentKeyword.add(fullId);
                newlyTriggered.push(fullId);
            }
        }
    }

    // ── Keyword overflow cap ───────────────────────────────────────────────────────
    // If routerMaxKeywordOverflow > 0, evict the oldest keyword-activated entries so
    // that the total number of active entries (agent-owned + keyword) never exceeds
    // routerMaxActivations + routerMaxKeywordOverflow.
    // Agent-owned entries (not in keywordActivatedKeys) are never touched.
    {
        const kwOverflowCap = settings.routerMaxKeywordOverflow || 0;
        if (kwOverflowCap > 0) {
            const maxActive   = settings.routerMaxActivations || 8;
            const hardCeiling = maxActive + kwOverflowCap;
            const totalActive = currentActive.size;
            if (totalActive > hardCeiling) {
                const toEvict = totalActive - hardCeiling;
                // currentKeyword preserves Set insertion order (oldest first)
                let evicted = 0;
                for (const id of currentKeyword) {
                    if (evicted >= toEvict) break;
                    currentActive.delete(id);
                    currentKeyword.delete(id);
                    evicted++;
                }
                if (settings.debugMode && evicted > 0) {
                    console.log(`[RPG Tracker] Keyword overflow cap: evicted ${evicted} entr${evicted !== 1 ? 'ies' : 'y'} (ceiling: ${hardCeiling}, was: ${totalActive})`);
                }
            }
        }
    }

    // ── Reverse sweep: auto-expire keyword-activated entries whose keywords ──────
    // ── are no longer present in the last `entry.depth` messages.          ──────
    // Only runs on the full onGenerationEnded pass (sweepEnabled=true), not on the
    // lightweight user-message pre-scan from the interceptor.
    if (sweepEnabled) {
        const chat = ctx.chat || [];
        const recentMessages = chat.filter(m => !m.is_system);
        const autoExpired = [];

        for (const id of currentKeyword) {
            if (newlyTriggered.includes(id)) continue;

            const [bookName, uid] = id.split('::');
            if (!bookName || uid === undefined) { autoExpired.push(id); continue; }

            let book = bookCache.get(bookName);
            if (!book) {
                book = await ctx.loadWorldInfo(bookName);
                if (book) bookCache.set(bookName, book);
            }
            const entry = book?.entries?.[uid];
            if (!entry) { autoExpired.push(id); continue; }

            const keywords = Array.isArray(entry.key) ? entry.key : [];
            if (keywords.length === 0) continue;

            const depth = (typeof entry.depth === 'number' && entry.depth > 0) ? entry.depth : (book.scan_depth ?? 4);
            const window = recentMessages.slice(-depth);
            const windowText = window.map(m => (m.mes || m.content || '')).join(' ').toLowerCase();

            const stillPresent = keywords.some(kw =>
                typeof kw === 'string' && kw.length > 0 && windowText.includes(kw.toLowerCase())
            );

            if (!stillPresent) autoExpired.push(id);
        }

        if (autoExpired.length > 0) {
            for (const id of autoExpired) {
                currentActive.delete(id);
                currentKeyword.delete(id);
            }
            if (settings.debugMode) {
                console.log('[RPG Tracker] Keyword scanner auto-expired:', autoExpired);
            }
        }
    }

    // ── Persist ───────────────────────────────────────────────────────────────
    settings.activeRouterKeys = [...currentActive];
    settings.keywordActivatedKeys = [...currentKeyword];
    settings.lastKeywordTriggeredKeys = newlyTriggered;
    ctx.saveSettingsDebounced();

    if (settings.debugMode && newlyTriggered.length > 0) {
        console.log('[RPG Tracker] Keyword scanner activated:', newlyTriggered);
    }

    return newlyTriggered;
}




/**
 * Sets disable: true on every entry in all scoped lorebooks so ST's native
 * keyword scanner never injects managed entries on user-message send.
 * Idempotent — safe to call on every init / chat-change.
 */
export async function disableManagedEntries() {
    const settings = getSettings();
    if (!settings.routerEnabled) return;
    // In native keyword mode, entries are left enabled for ST's keyword scanner to manage.
    if (settings.routerNativeKeywordActivation) return;
    const ctx = SillyTavern.getContext();
    const prefix = getLivePrefix();
    if (!prefix) return;

    try {
        const allNames = await getWorldInfoNamesSafe();
        const scoped = allNames.filter(n => bookBelongsToPrefix(n, prefix));
        for (const bookName of scoped) {
            const book = await ctx.loadWorldInfo(bookName);
            if (!book?.entries) continue;
            let changed = false;
            for (const entry of Object.values(book.entries)) {
                if (!entry.disable) {
                    entry.disable = true;
                    changed = true;
                }
            }
            if (changed) {
                try { await ctx.saveWorldInfo(bookName, book); } catch (_) {}
            }
        }
    } catch (e) {
        console.warn('[RPG Tracker] disableManagedEntries failed:', e);
    }
}

/**
 * Removes duplicates and empty strings from an array of keywords.
 */
function cleanKeys(keys) {
    if (!Array.isArray(keys)) return [];
    return [...new Set(keys.map(k => k?.trim()).filter(Boolean))];
}

/**
 * Given existing lorebook content and a delta the model wants to append,
 * strip any sentences/lines from the delta that are already present in the
 * existing content (the model often echoes the full entry back).
 * Returns only the truly-new content, or an empty string if nothing is new.
 */
function deduplicateContent(existing, delta) {
    if (!existing || !delta) return delta || '';
    const normExisting = existing.toLowerCase();
    // Split delta on newlines; keep a line only if it's not already in existing
    const newLines = delta.split('\n').filter(line => {
        const norm = line.replace(/^\[.*?\]\s*/g, '').trim().toLowerCase();
        // Short or empty fragments are kept as-is (timestamps, separators, etc.)
        if (norm.length < 15) return true;
        return !normExisting.includes(norm);
    });
    return newLines.join('\n').trim();
}

/**
 * Estimates token count using a ~4 chars/token heuristic.
 * Sufficient for threshold comparisons; no tokenizer dependency needed.
 */
function estimateTokens(str) {
    return Math.ceil((str || '').length / 4);
}

/**
 * Returns the set of word bigrams from a string,
 * stripping timestamp markers like [Day X, HH:MM].
 */
function getBigrams(str) {
    const words = str.toLowerCase()
        .replace(/\[[^\]]+\]/g, '')
        .trim()
        .split(/\s+/);
    const bigrams = new Set();
    for (let i = 0; i < words.length - 1; i++) {
        bigrams.add(`${words[i]} ${words[i + 1]}`);
    }
    return bigrams;
}

/**
 * Jaccard similarity between two strings based on word bigrams.
 * Returns 0–1; higher = more similar.
 */
function jaccardSimilarity(a, b) {
    const ba = getBigrams(a), bb = getBigrams(b);
    const intersection = [...ba].filter(x => bb.has(x)).length;
    const union = new Set([...ba, ...bb]).size;
    return union === 0 ? 0 : intersection / union;
}

/**
 * Counts near-duplicate line pairs within a single entry's content.
 * Used to annotate entries in the cleanup context — not passed verbatim to the LLM.
 *
 * @param {string} content
 * @param {number} threshold - Similarity threshold (default 0.6)
 * @returns {number} Count of near-duplicate pairs
 */
function countRedundantPairs(content, threshold = 0.6) {
    const lines = content.split('\n').filter(Boolean);
    let count = 0;
    for (let i = 0; i < lines.length; i++) {
        for (let j = i + 1; j < lines.length; j++) {
            if (jaccardSimilarity(lines[i], lines[j]) >= threshold) count++;
        }
    }
    return count;
}


// -- World Progression ---------------------------------------------------------------

/**
 * Parses an in-world time string (e.g. "11:52 AM, Day 3") into total minutes
 * from campaign start (Day 1, 00:00 = 0). Returns -1 if unparseable.
 * @param {string} timeStr
 * @returns {number}
 */
export function parseInWorldMinutes(timeStr) {
    if (!timeStr) return -1;
    const m = timeStr.match(/(\d{1,2}):(\d{2})\s*(AM|PM),\s*Day\s*(\d+)/i);
    if (!m) return -1;
    let hours = parseInt(m[1], 10);
    const minutes = parseInt(m[2], 10);
    const ampm = m[3].toUpperCase();
    const day = parseInt(m[4], 10);
    if (ampm === 'PM' && hours !== 12) hours += 12;
    if (ampm === 'AM' && hours === 12) hours = 0;
    return (day - 1) * 24 * 60 + hours * 60 + minutes;
}

/**
 * Computes the label for a World Progression period given start/end in total-minutes.
 * Daily or longer intervals: "Day N". Sub-daily: "Day N, HH:MM-HH:MM".
 * @param {number} startMinutes
 * @param {number} endMinutes
 * @param {number} intervalHours
 * @returns {string}
 */
function computePeriodLabel(startMinutes, endMinutes, intervalHours) {
    const day = Math.floor(endMinutes / (24 * 60)) + 1;
    const minutesOfToday = endMinutes % (24 * 60);
    let hours = Math.floor(minutesOfToday / 60);
    const mins = minutesOfToday % 60;
    const ampm = hours >= 12 ? 'PM' : 'AM';
    let displayHours = hours % 12;
    if (displayHours === 0) displayHours = 12;
    const displayHoursStr = String(displayHours).padStart(2, '0');
    const displayMins = String(mins).padStart(2, '0');
    return `Day ${day}, ${displayHoursStr}:${displayMins} ${ampm}`;
}

/**
 * Standalone deterministic World Progression pass.
 * Called by maybeRunWorldProgression() in narrative-hooks.js when the in-world interval
 * has elapsed. Never invoked by the Lorebook Agent itself.
 *
 * @param {string} timeStr        - Raw time string from [TIME] block (e.g. "11:52 AM, Day 3")
 * @param {number} currentMinutes - Current in-world total minutes (from parseInWorldMinutes)
 */
export async function runWorldProgressionPass(timeStr, currentMinutes) {
    const settings = getSettings();
    const prefix = getLivePrefix();
    const worldBookName = prefix ? `${prefix}_World` : 'World';
    const intervalHours = settings.worldProgressionIntervalHours || 24;
    const keepActive = settings.worldProgressionKeepActive || 1;
    const wordTarget = 600;

    // Connection settings shared by all LLM calls within this pass
    // (consolidation pre-step + main report generation).
    const routerSettings = {
        connectionSource: settings.worldConnectionSource || 'default',
        connectionProfileId: settings.worldConnectionProfileId,
        completionPresetId: settings.worldCompletionPresetId,
        ollamaUrl: settings.worldOllamaUrl,
        ollamaModel: settings.worldOllamaModel,
        openaiUrl: settings.worldOpenaiUrl,
        openaiKey: settings.worldOpenaiKey,
        openaiModel: settings.worldOpenaiModel,
    };

    const lastFired = settings.worldProgressionLastFiredAtMinutes ?? -1;
    const intervalMinutes = intervalHours * 60;

    // Determine the start of the period we're reporting on
    const periodStart = lastFired >= 0 ? lastFired : currentMinutes - intervalMinutes;
    const periodEnd = periodStart + intervalMinutes;
    const periodLabel = computePeriodLabel(periodStart, periodEnd, intervalHours);

    broadcastStep('thought', `\uD83C\uDF0D World Progression: Checking for "${periodLabel}" report...`);

    // 1. Load ALL campaign lorebooks once.
    //    Used for: duplicate check, full lore context, and applyAction verification.
    //    No double-fetch - archiveBooks is reused throughout the function.
    const ctx = SillyTavern.getContext();
    if (typeof ctx.updateWorldInfoList === 'function') {
        try { await ctx.updateWorldInfoList(); } catch (_) {}
    }
    const allBookNames = await getWorldInfoNamesSafe();
    const archiveBooks = {};
    for (const n of allBookNames) {
        if (prefix && !bookBelongsToPrefix(n, prefix)) continue;
        try {
            const b = await ctx.loadWorldInfo(n);
            if (b?.entries) archiveBooks[n] = b;
        } catch (_) {}
    }

    // 2. Duplicate check - see if a report for this period already exists in the World book.
    const worldBook = archiveBooks[worldBookName] ?? null;
    const cleanPeriod = periodLabel.toLowerCase().trim();
    if (worldBook?.entries) {
        for (const entry of Object.values(worldBook.entries)) {
            const existingLabel = (entry.comment || '').toLowerCase().trim();
            if (existingLabel === cleanPeriod) {
                broadcastStep('thought', `\uD83C\uDF0D World Progression: "${periodLabel}" already exists - advancing timer.`);
                settings.worldProgressionLastFiredAtMinutes = periodEnd;
                settings.worldProgressionLastFiredPeriodLabel = periodLabel;
                SillyTavern.getContext().saveSettingsDebounced();
                return;
            }
        }
    }

    // 2b. Consolidation pre-step — fire BEFORE building lore context so the historical dump
    //     fed to the new report reflects the freshly compressed archive.
    //     This is a standalone LLM call with its OWN dedicated system prompt.
    //     It is NEVER part of the Lorebook Agent prompt and has zero per-turn token cost.
    if (settings.worldProgressionConsolidateEnabled) {
        const consolidateInterval = Math.max(2, settings.worldProgressionConsolidateInterval || 7);
        const currentWorldBook = archiveBooks[worldBookName] ?? null;
        if (currentWorldBook?.entries) {
            // Sort entries chronologically by UID (insertion order ≈ chronological)
            const allWorldEntries = Object.entries(currentWorldBook.entries)
                .sort(([a], [b]) => Number(a) - Number(b));

            // Classify entries: raw = individual period reports; consolidated = range summaries
            const isRawReport = (label) => {
                if (!/^day\s+\d+/i.test(label)) return false; // must start with "Day N"
                if (/days?\s+\d+\s*[\-\u2013\u2014]\s*\d+/i.test(label)) return false; // "Days N-M"
                if (/condensed|compressed|merged|summary/i.test(label)) return false;
                return true;
            };

            const rawEntries = allWorldEntries.filter(([, e]) =>
                isRawReport((e.comment || '').trim())
            );

            if (rawEntries.length >= consolidateInterval) {
                // Take the oldest N raw reports for consolidation
                const toConsolidate = rawEntries.slice(0, consolidateInterval);

                // Build a content dump for the LLM
                const rawDump = toConsolidate
                    .map(([, e]) => `### ${(e.comment || '').trim()}\n${(e.content || '').trim()}`)
                    .join('\n\n');

                // Determine the day range covered by these reports
                const dayNums = toConsolidate.map(([, e]) => {
                    const m = (e.comment || '').match(/Day\s+(\d+)/i);
                    return m ? parseInt(m[1], 10) : null;
                }).filter(n => n !== null);
                const minDay = dayNums.length ? Math.min(...dayNums) : 1;
                const maxDay = dayNums.length ? Math.max(...dayNums) : minDay;
                const consolidatedLabel = (minDay === maxDay)
                    ? `Day ${minDay} (Condensed)`
                    : `Days ${minDay}\u2013${maxDay}`;

                // Dedicated consolidation system prompt — never reused anywhere else
                const consolidationSystemPrompt =
`You are the World Archivist. Compress the following World Progression reports into a single, unified summary while preserving maximum narrative signal.

## RULES
1. Merge all reports into a single coherent, present-tense narrative.
2. Always retain temporal context. The summary MUST begin with the overall period label (e.g. "[${consolidatedLabel}]"). Never remove all temporal markers.
3. Preserve every unique fact — faction developments, NPC actions, location changes, economic shifts, and plot developments. Never replace detailed facts with generic summaries (e.g. writing "Various events occurred" is a critical failure).
4. Eliminate only true redundancies — if the same fact repeats across multiple reports, write it once.
5. Target 40–60% of the combined original token count.
6. Format: dense prose or tight bullet points, no filler, no markdown headers beyond the period label. 1–2 sentences per development.
7. Output ONLY the compressed report content. No preamble, no tags, no meta-commentary.`;

                const consolidationUserPrompt =
`Compress the following ${toConsolidate.length} World Progression reports into a single summary for the period **${consolidatedLabel}**.

${rawDump}`;

                broadcastStep('thought', `\uD83C\uDF0D World Progression: Consolidating ${toConsolidate.length} reports into \"${consolidatedLabel}\"...`);

                let consolidatedContent = null;
                try {
                    consolidatedContent = await sendStateRequest(routerSettings, consolidationSystemPrompt, consolidationUserPrompt);
                } catch (e) {
                    broadcastStep('error', `World Progression consolidation failed: ${e.message} — continuing without consolidation.`);
                }

                if (consolidatedContent && consolidatedContent.trim()) {
                    // Reload the world book from disk for a fresh write
                    let freshBook = null;
                    try { freshBook = await ctx.loadWorldInfo(worldBookName); } catch (_) {}
                    if (!freshBook?.entries) freshBook = currentWorldBook;

                    // Add the consolidated entry
                    const allUids = Object.keys(freshBook.entries).map(Number).filter(n => !isNaN(n));
                    const nextUid = allUids.length > 0 ? Math.max(...allUids) + 1 : 0;
                    freshBook.entries[nextUid] = {
                        uid: nextUid,
                        key: [],
                        keysecondary: [],
                        comment: consolidatedLabel,
                        content: consolidatedContent.trim(),
                        constant: false,
                        selective: false, selectiveLogic: 0, addMemo: true,
                        order: settings.routerDefaultOrder ?? 100,
                        position: settings.routerDefaultPosition ?? 0,
                        disable: true,
                        probability: 100, useProbability: false,
                        depth: settings.routerDefaultDepth ?? 4,
                        role: null,
                        group: '', groupOverride: false, groupWeight: 100,
                    };

                    // Delete the raw entries that were consolidated
                    const toDeleteUids = toConsolidate.map(([uid]) => uid);
                    for (const uid of toDeleteUids) {
                        delete freshBook.entries[uid];
                        const fullId = `${worldBookName}::${uid}`;
                        settings.activeWorldKeys = (settings.activeWorldKeys || []).filter(k => k !== fullId);
                    }

                    // Persist to disk
                    await fetch('/api/worldinfo/edit', {
                        method: 'POST',
                        headers: getRequestHeaders(),
                        body: JSON.stringify({ name: worldBookName, data: freshBook })
                    });
                    try { await ctx.saveWorldInfo(worldBookName, freshBook); } catch (_) {}

                    // Update the in-memory archive so the lore context build step reads fresh data
                    archiveBooks[worldBookName] = freshBook;

                    broadcastStep('thought', `\uD83C\uDF0D World Progression: \"${consolidatedLabel}\" consolidated — ${toDeleteUids.length} raw reports removed.`);
                }
            }
        }
    }

    // 3. Build full lore context from ALL campaign lorebooks, split into three sections.
    //    _Skeleton books -> Day 0 Baseline (foundational undiscovered entities, never injected
    //                       into narrative context — only visible to the World Progression engine)
    //    Regular books   -> Active World Lore (all discovered entities, active or not)
    //    _World books    -> Historical Reports (all prior periods, incl. deactivated)
    //
    //    Segregating the Skeleton into its own timestamped section prevents the LLM from
    //    treating Day-0 stub data as current events, while still making those entities available
    //    for off-screen simulation.
    const skeletonLines = [];
    const loreGrouped = {}; // categoryHeader -> Array of entry lines
    const historicalReportLines = [];
    // Typed entity name pools — skeleton vs. narrative
    const skeletonNpcNames = [];
    const narrativeNpcNames = [];
    const skeletonLocationNames = [];
    const narrativeLocationNames = [];
    const skeletonFactionNames = [];
    const narrativeFactionNames = [];
    const conflictNames = [];
    // First-sentence descriptions for the fallback generator context
    const skeletonFactionDescs = []; // { name, desc }
    const skeletonLocationDescs = []; // { name, desc }

    // Compute exclusion list
    const excludedTerms = [];
    if (settings.worldProgressionExclusionList) {
        settings.worldProgressionExclusionList
            .split(',')
            .map(term => term.trim().toLowerCase())
            .filter(Boolean)
            .forEach(term => excludedTerms.push(term));
    }
    if (settings.worldProgressionAutoExcludeParty) {
        const memo = settings.currentMemo || '';
        const partyMatch = memo.match(/\[PARTY\]([\s\S]*?)\[\/PARTY\]/i);
        if (partyMatch) {
            const blockContent = partyMatch[1];
            const lines = blockContent.split('\n').map(l => l.trim()).filter(Boolean);
            for (const line of lines) {
                const colonIdx = line.indexOf(':');
                const entityPart = colonIdx !== -1 ? line.substring(0, colonIdx).trim() : line;
                const namePart = entityPart.replace(/\s*\([^)]*\)/g, '').trim();
                if (namePart && namePart !== '(unnamed)') {
                    excludedTerms.push(namePart.toLowerCase());
                }
            }
        }
    }

    function getBookCategoryHeader(bookName, prefix) {
        let cleanName = bookName;
        if (prefix && bookName.startsWith(prefix + '_')) {
            cleanName = bookName.slice(prefix.length + 1);
        }
        return cleanName.toUpperCase();
    }

    for (const [bookName, book] of Object.entries(archiveBooks)) {
        const nameLower = bookName.toLowerCase();
        const isSkeletonBook = nameLower.endsWith('_skeleton');
        const isWorldBook = nameLower.endsWith('_world') || nameLower === 'world';
        // Sort by uid (numeric insertion order ≈ chronological)
        let sortedEntries = Object.entries(book.entries)
            .sort(([a], [b]) => Number(a) - Number(b));

        if (isWorldBook) {
            const historyLookback = settings.worldProgressionHistoryLookback ?? 0;
            if (historyLookback > 0) {
                sortedEntries = sortedEntries.slice(-historyLookback);
            }
        }

        for (const [, entry] of sortedEntries) {
            if (!entry?.content?.trim()) continue;
            const label = (entry.comment || entry.key?.[0] || '(unnamed)').trim();
            if (label === '(unnamed)' || !label) continue;

            const categoryHeader = getBookCategoryHeader(bookName, prefix);
            const isNpc = (isSkeletonBook && entry.extensions?.rpgCategory === 'NPC') ||
                          (!isSkeletonBook && (categoryHeader === 'NPC' || categoryHeader === 'NPCS' || nameLower.includes('npc')));
            const isLoc = (isSkeletonBook && entry.extensions?.rpgCategory === 'LOC') ||
                          (!isSkeletonBook && (categoryHeader === 'LOC' || categoryHeader === 'LOCATIONS' || nameLower.includes('location') || nameLower.includes('place')));
            const isFac = (isSkeletonBook && entry.extensions?.rpgCategory === 'FAC') ||
                          (!isSkeletonBook && (categoryHeader === 'FAC' || categoryHeader === 'FACTIONS' || nameLower.includes('faction') || nameLower.includes('guild')));
            const isConflict = (isSkeletonBook && entry.extensions?.rpgCategory === 'EVENT') ||
                               (!isSkeletonBook && (categoryHeader === 'EVENT' || categoryHeader === 'EVENTS' || categoryHeader === 'QUEST' || categoryHeader === 'QUESTS' || nameLower.includes('event') || nameLower.includes('conflict') || nameLower.includes('quest')));

            // Check exclusion list
            let isExcluded = false;
            if (excludedTerms.length > 0) {
                const labelLower = label.toLowerCase();
                const primaryKeys = Array.isArray(entry.key) ? entry.key.map(k => String(k).trim().toLowerCase()) : [];
                const secondaryKeys = Array.isArray(entry.keysecondary) ? entry.keysecondary.map(k => String(k).trim().toLowerCase()) : [];

                isExcluded = excludedTerms.some(term => {
                    if (labelLower.includes(term)) return true;
                    if (primaryKeys.some(k => k.includes(term))) return true;
                    if (secondaryKeys.some(k => k.includes(term))) return true;
                    return false;
                });
            }

            if (isSkeletonBook) {
                skeletonLines.push(`### ${label}\n${entry.content.trim()}`);
                if (!isExcluded) {
                    if (isNpc) skeletonNpcNames.push(label);
                    else if (isLoc) {
                        skeletonLocationNames.push(label);
                        skeletonLocationDescs.push({ name: label, desc: entry.content.trim().split(/[.!?]/)[0].trim() });
                    } else if (isFac) {
                        skeletonFactionNames.push(label);
                        skeletonFactionDescs.push({ name: label, desc: entry.content.trim().split(/[.!?]/)[0].trim() });
                    } else if (isConflict) conflictNames.push(label);
                }
            } else if (isWorldBook) {
                historicalReportLines.push(`### ${label}\n${entry.content.trim()}`);
            } else {
                const isQuestOrEvent = categoryHeader === 'EVENT' || categoryHeader === 'EVENTS' ||
                                       categoryHeader === 'QUEST' || categoryHeader === 'QUESTS' ||
                                       nameLower.includes('event') || nameLower.includes('quest');
                if (isQuestOrEvent) continue;

                if (!loreGrouped[categoryHeader]) {
                    loreGrouped[categoryHeader] = [];
                }
                loreGrouped[categoryHeader].push(`### ${label}\n${entry.content.trim()}`);
                if (!isExcluded) {
                    if (isNpc) narrativeNpcNames.push(label);
                    else if (isLoc) narrativeLocationNames.push(label);
                    else if (isFac) narrativeFactionNames.push(label);
                }
            }
        }
    }


    const skeletonDump = skeletonLines.length
        ? skeletonLines.join('\n\n')
        : '(No skeleton generated — engine will rely solely on discovered lore.)';

    let loreDump = '';
    const categories = Object.keys(loreGrouped).sort();
    if (categories.length > 0) {
        const categoryBlocks = [];
        for (const cat of categories) {
            categoryBlocks.push(`## ${cat}\n${loreGrouped[cat].join('\n\n')}`);
        }
        loreDump = categoryBlocks.join('\n\n');
    } else {
        loreDump = 'No lore entries found.';
    }

    const historicalDump = historicalReportLines.length
        ? historicalReportLines.join('\n\n')
        : 'No prior World Progression reports.';

    // 4. Grab recent narrative blocks (for current scene context) if configured
    let recentNarrative = '';
    const wpLookback = settings.worldProgressionLookback ?? 0;
    if (wpLookback > 0) {
        const { chat } = ctx;
        const narrativeBlocks = [];
        if (Array.isArray(chat)) {
            let found = 0;
            for (const msg of [...chat].reverse()) {
                if (found >= wpLookback) break;
                if (msg.is_system || msg.is_user) continue;
                let mes = (msg.mes || '').trim()
                    .replace(/<details[^>]*>[\s\S]*?<\/details>/gi, '')
                    .replace(/<think[^>]*>[\s\S]*?<\/think>/gi, '').trim();
                if (mes) { narrativeBlocks.unshift(mes); found++; }
            }
        }
        recentNarrative = narrativeBlocks.join('\n\n');
    }

    // 5. Build the system prompt from settings ({periodLabel} and {wordTarget} substitution)
    const rawPrompt = settings.worldProgressionSystemPrompt || '';
    const systemPrompt = rawPrompt
        .replace(/\{periodLabel\}/g, periodLabel)
        .replace(/\{wordTarget\}/g, String(wordTarget));

    // Auto-generation fallback: ensure skeleton NPC pool meets requested count
    if (settings.worldProgressionRandomizeNPCs) {
        const requestedSkeletonNpcs = settings.worldProgressionRandomSkeletonNPCCount || 0;
        if (requestedSkeletonNpcs > 0 && skeletonNpcNames.length < requestedSkeletonNpcs) {
            const missingCount = requestedSkeletonNpcs - skeletonNpcNames.length;
            const atmosphereSummary = settings.worldProgressionSkeletonAtmosphereSummary || '';
            try {
                broadcastStep('thought', `\uD83E\uDDEC World Skeleton: Auto-generating ${missingCount} NPC(s) to meet requested pool size...`);
                const newNames = await runSkeletonGeneratorAgent(
                    missingCount, atmosphereSummary,
                    skeletonFactionDescs, conflictNames, skeletonLocationDescs, archiveBooks
                );
                skeletonNpcNames.push(...newNames);
                if (typeof globalThis._rpgUpdateSkeletonStatus === 'function') {
                    globalThis._rpgUpdateSkeletonStatus().catch(() => {});
                }
            } catch (e) {
                broadcastStep('error', `World Skeleton auto-generation failed: ${e.message} \u2014 proceeding with existing pool.`);
            }
        }
    }

    // Determine designated entities using typed skeleton/narrative pools
    const designations = [];
    const shuffleAndSelect = (arr, count) => {
        const unique = Array.from(new Set(arr)).filter(Boolean);
        const clamped = Math.min(Math.max(count, 0), unique.length);
        if (clamped === 0) return [];
        const shuffled = [...unique];
        for (let i = shuffled.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
        }
        return shuffled.slice(0, clamped);
    };

    const handleTypedRandomization = (enabled, skeletonNames, narrativeNames, skeletonCount, narrativeCount, category) => {
        if (!enabled) return;
        const skelSelected = shuffleAndSelect(skeletonNames, skeletonCount);
        const narSelected = shuffleAndSelect(narrativeNames, narrativeCount);
        if (skelSelected.length > 0 || narSelected.length > 0) {
            let block = `### ${category}`;
            if (skelSelected.length > 0) {
                block += `\n#### SKELETON ENTITIES [drawn from skeleton lorebook only]\n` + skelSelected.map(n => `- ${n}`).join('\n');
            }
            if (narSelected.length > 0) {
                block += `\n#### NARRATIVE ENTITIES [drawn from active world lore only]\n` + narSelected.map(n => `- ${n}`).join('\n');
            }
            designations.push(block);
        }
    };

    handleTypedRandomization(
        settings.worldProgressionRandomizeNPCs,
        skeletonNpcNames, narrativeNpcNames,
        settings.worldProgressionRandomSkeletonNPCCount || 0,
        settings.worldProgressionRandomNarrativeNPCCount || 0,
        'NPCs'
    );
    handleTypedRandomization(
        settings.worldProgressionRandomizeLocations,
        skeletonLocationNames, narrativeLocationNames,
        settings.worldProgressionRandomSkeletonLocationCount || 0,
        settings.worldProgressionRandomNarrativeLocationCount || 0,
        'Locations'
    );
    handleTypedRandomization(
        settings.worldProgressionRandomizeFactions,
        skeletonFactionNames, narrativeFactionNames,
        settings.worldProgressionRandomSkeletonFactionCount || 0,
        settings.worldProgressionRandomNarrativeFactionCount || 0,
        'Factions'
    );



    let selectedNPCsText = '';
    if (designations.length > 0) {
        selectedNPCsText = `\n\n## DESIGNATED ENTITIES FOR THIS PERIOD\n` +
            `The following entities have been pre-selected by the system simulator. Entities listed under SKELETON ENTITIES originate from the hidden background skeleton (off-screen, undiscovered by the player). Entities listed under NARRATIVE ENTITIES originate from the active discovered world lore. You MUST focus on and advance the timeline only for these designated entities:\n\n` +
            designations.join('\n\n') +
            `\n\nYou are strictly forbidden from changing the status, advancing the timeline, or creating new narrative beats for entities not listed above. You MAY mention them passively as background context where their prior established actions are a direct catalyst for a designated entity.`;
    }

    let userPrompt =
`## WORLD SKELETON (Day 0 Baseline — Foundational Undiscovered State)
These entities existed at the start of the campaign. They have been acting off-screen since Day 1.
They are NOT yet known to the player. Use them freely to generate off-screen activity.
${skeletonDump}

## ACTIVE WORLD LORE (Discovered Entities — Current Known State)
${loreDump}

## HISTORICAL WORLD REPORTS (Previously Generated Off-Screen Activity)
${historicalDump}`;

    if (recentNarrative) {
        userPrompt += `\n\n## RECENT NARRATIVE (Current Scene Context)\n${recentNarrative}`;
    }

    if (selectedNPCsText) {
        userPrompt += selectedNPCsText;
    }

    userPrompt += `\n\nWrite the World Progression report for **${periodLabel}**.`;

    // 6. Send the LLM request using the Lorebook Agent connection settings
    const loreCount = Object.values(loreGrouped).reduce((sum, arr) => sum + arr.length, 0);
    broadcastStep('thought', `\uD83C\uDF0D World Progression: Generating report for "${periodLabel}" (${skeletonLines.length} skeleton, ${loreCount} lore, ${historicalReportLines.length} prior reports)...`);
    let reportContent;
    try {
        reportContent = await sendStateRequest(routerSettings, systemPrompt, userPrompt);
    } catch (e) {
        broadcastStep('error', `World Progression generation failed: ${e.message}`);
        return;
    }
    if (!reportContent || !reportContent.trim()) {
        broadcastStep('error', 'World Progression: LLM returned empty response.');
        return;
    }

    // 7. Store the entry via applyAction (routes to the _World lorebook).
    //    archiveBooks already loaded in step 1 - no re-fetch needed.
    const entryKeys = ['world progression', 'world report', periodLabel.toLowerCase()];
    const dayNum = periodLabel.match(/day\s+(\d+)/i)?.[1];
    if (dayNum) entryKeys.push(`day ${dayNum}`);

    await applyAction({
        record: [{ label: periodLabel, keys: entryKeys, content: reportContent.trim(), category: 'WORLD' }],
        reason: `World Progression: auto-generated report for ${periodLabel}`,
    }, archiveBooks, timeStr, '');

    // 8. Rolling window: keep only the N most recent WORLD entries active.
    await new Promise(r => setTimeout(r, 300));
    let freshWorldBook = null;
    try { freshWorldBook = await ctx.loadWorldInfo(worldBookName); } catch (_) {}
    if (!freshWorldBook?.entries) {
        try {
            const r = await fetch('/api/worldinfo/get', {
                method: 'POST',
                headers: getRequestHeaders(),
                body: JSON.stringify({ name: worldBookName })
            });
            if (r.ok) { const d = await r.json(); if (d?.entries) freshWorldBook = d; }
        } catch (_) {}
    }

    if (freshWorldBook?.entries) {
        const sorted = Object.entries(freshWorldBook.entries)
            .sort(([a], [b]) => Number(a) - Number(b));
        const allWorldIds = sorted.map(([uid]) => `${worldBookName}::${uid}`);
        const toActivate = allWorldIds.slice(-keepActive);
        const toDeactivate = allWorldIds.slice(0, Math.max(0, allWorldIds.length - keepActive));

        if (toActivate.length > 0 || toDeactivate.length > 0) {
            // Reload archive after the new entry was written for accurate verification
            const freshArchive = {};
            for (const n of Object.keys(archiveBooks)) {
                try { const b = await ctx.loadWorldInfo(n); if (b?.entries) freshArchive[n] = b; } catch (_) {}
            }
            freshArchive[worldBookName] = freshWorldBook;
            await applyAction({
                activate: toActivate,
                deactivate: toDeactivate,
                reason: `World Progression: rolling window (keep ${keepActive} active)`,
            }, freshArchive, timeStr, '');
        }
    }

    // 9. Advance the timer and persist
    settings.worldProgressionLastFiredAtMinutes = periodEnd;
    settings.worldProgressionLastFiredPeriodLabel = periodLabel;
    SillyTavern.getContext().saveSettingsDebounced();

    broadcastStep('finish', `\uD83C\uDF0D World Progression: "${periodLabel}" report saved.`);
    if (typeof globalThis._rpgRenderRouterUI === 'function') {
        globalThis._rpgRenderRouterUI();
    }
}
// -- World Skeleton ------------------------------------------------------------------

/**
 * Parses the raw LLM output from the skeleton generation pass into individual
 * lore records, grouped by section header (## FACTIONS, ## LOCATIONS, etc.).
 * Returns an array of { label, content, category } objects.
 * @param {string} rawText
 * @returns {Array<{label: string, content: string, category: string}>}
 */
function parseSkeletonOutput(rawText) {
    const categoryMap = {
        'FACTIONS': 'FAC',
        'FACTION': 'FAC',
        'LOCATIONS': 'LOC',
        'LOCATION': 'LOC',
        'NPCS': 'NPC',
        'NPC': 'NPC',
        'CONFLICTS': 'EVENT',
        'CONFLICT': 'EVENT',
        'EVENTS': 'EVENT',
    };

    const records = [];
    const lines = rawText.split('\n');
    
    let currentCategory = 'NPC';
    let currentItem = null;

    const sectionRegex = /^##\s+([A-Z]+)/i;
    const subHeaderRegex = /^###\s+(.+)/;
    const listRegexBold = /^\s*(?:[\*\-\d\.\s]*)\s*\*\*(.+?)\*\*\s*[:\-]?\s*(.*)/;
    const listRegexPlain = /^\s*(?:[\*\-\d\.\s]*)\s*([^:\-\n]+)\s*[:\-]\s*(.*)/;

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const trimmedLine = line.trim();

        // 1. Check for ## Section Header
        const secMatch = line.match(sectionRegex);
        if (secMatch) {
            if (currentItem) {
                records.push(currentItem);
                currentItem = null;
            }
            const key = secMatch[1].toUpperCase();
            currentCategory = categoryMap[key] || 'NPC';
            continue;
        }

        // 2. Check for ### Sub-header
        const subMatch = line.match(subHeaderRegex);
        if (subMatch) {
            if (currentItem) {
                records.push(currentItem);
            }
            currentItem = {
                label: subMatch[1].trim(),
                content: '',
                category: currentCategory
            };
            continue;
        }

        // 3. Check for list items like * **Name**: description
        let listMatch = line.match(listRegexBold);
        if (!listMatch) {
            listMatch = line.match(listRegexPlain);
        }
        if (listMatch) {
            if (currentItem) {
                records.push(currentItem);
            }
            currentItem = {
                label: listMatch[1].trim(),
                content: listMatch[2].trim(),
                category: currentCategory
            };
            continue;
        }

        // 4. Append to existing item content
        if (currentItem) {
            if (trimmedLine) {
                if (currentItem.content) {
                    currentItem.content += ' ' + trimmedLine;
                } else {
                    currentItem.content = trimmedLine;
                }
            }
        }
    }

    if (currentItem) {
        records.push(currentItem);
    }

    // Clean up content strings (collapse multiple spaces, remove quotes)
    for (const rec of records) {
        rec.content = rec.content.replace(/\s+/g, ' ').trim();
        if (rec.content.startsWith('"') && rec.content.endsWith('"')) {
            rec.content = rec.content.slice(1, -1).trim();
        }
        if (rec.content.startsWith("'") && rec.content.endsWith("'")) {
            rec.content = rec.content.slice(1, -1).trim();
        }
    }

    return records.filter(r => r.label && r.content);
}

/**
 * Auto-generates skeleton NPCs when the pool is below the requested count.
 * Operates in informational isolation — receives only the skeleton theme, atmosphere
 * summary, and existing skeleton faction/location/conflict names.
 * Never sees narrative content, active NPC stats, quest details, or player logs.
 *
 * @param {number} missingCount  Number of NPCs to generate
 * @param {string} atmosphere    Atmosphere summary (single paragraph, required foundation for skeleton generation)
 * @param {Array}  factionDescs  Array of {name, desc} from skeleton factions
 * @param {Array}  conflictNames Skeleton conflict/event names (names only)
 * @param {Array}  locationDescs Array of {name, desc} from skeleton locations
 * @param {Object} archiveBooks  Loaded lorebook map for writing back to skeleton
 * @returns {Promise<string[]>}  Names of newly created skeleton NPCs
 */
async function runSkeletonGeneratorAgent(missingCount, atmosphere, factionDescs, conflictNames, locationDescs, archiveBooks) {
    const settings = getSettings();
    const prefix = getLivePrefix();
    const skeletonBookName = prefix ? `${prefix}_Skeleton` : 'World_Skeleton';

    const factionContext = factionDescs.length > 0
        ? factionDescs.map(f => `- ${f.name}: ${f.desc}`).join('\n')
        : '(none defined yet)';
    const locationContext = locationDescs.length > 0
        ? locationDescs.map(l => `- ${l.name}: ${l.desc}`).join('\n')
        : '(none defined yet)';
    const conflictContext = conflictNames.length > 0
        ? conflictNames.map(n => `- ${n}`).join('\n')
        : '(none defined yet)';

    const systemPrompt =
`You are a World Architect. Generate background skeleton NPCs for an RPG campaign simulation.
These NPCs are undiscovered background characters — they have never appeared in the narrative.
Do NOT reference any player characters, recent events, or narrative content.
Output ONLY structured content:

## NPCS
### [Name]
[Role in the world. Current situation or agenda in 1-2 sentences.]`;

    let userPrompt = `## ATMOSPHERE / DESCRIPTION\n${atmosphere || '(No atmosphere description provided)'}\n\n`;
    userPrompt +=
`## EXISTING SKELETON CONTEXT (for thematic consistency — do not replicate)
### Factions
${factionContext}

### Locations
${locationContext}

### Active Conflicts
${conflictContext}

Generate exactly ${missingCount} new skeleton NPC(s). Each must be unique, thematically consistent, and not affiliated with or named after any player character.`;

    const routerSettings = {
        connectionSource: settings.worldConnectionSource || 'default',
        connectionProfileId: settings.worldConnectionProfileId,
        completionPresetId: settings.worldCompletionPresetId,
        ollamaUrl: settings.worldOllamaUrl,
        ollamaModel: settings.worldOllamaModel,
        openaiUrl: settings.worldOpenaiUrl,
        openaiKey: settings.worldOpenaiKey,
        openaiModel: settings.worldOpenaiModel,
    };

    const rawOutput = await sendStateRequest(routerSettings, systemPrompt, userPrompt);
    if (!rawOutput?.trim()) throw new Error('Skeleton generator agent returned empty response');

    const records = parseSkeletonOutput(rawOutput).filter(r => r.category === 'NPC');
    if (records.length === 0) throw new Error('Skeleton generator: no NPC records parsed from output');

    // Load or reuse the skeleton book
    let skeletonBook = (archiveBooks && archiveBooks[skeletonBookName]) || null;
    if (!skeletonBook || !skeletonBook.entries) {
        const ctx = SillyTavern.getContext();
        try { skeletonBook = await ctx.loadWorldInfo(skeletonBookName); } catch (_) {}
        if (!skeletonBook || !skeletonBook.entries) {
            skeletonBook = { entries: {}, name: skeletonBookName, scan_depth: 4, token_budget: 400, recursive: false, extensions: {} };
        }
    }

    const existingUids = Object.keys(skeletonBook.entries).map(Number).filter(n => !isNaN(n));
    let nextUid = existingUids.length > 0 ? Math.max(...existingUids) + 1 : 0;

    const newNames = [];
    for (const rec of records) {
        skeletonBook.entries[nextUid] = {
            uid: nextUid,
            key: [],
            keysecondary: [],
            comment: `NPC: ${rec.label}`,
            content: `[Day 0 Baseline — Auto-generated]\n${rec.content}`,
            constant: false, selective: false, selectiveLogic: 0, addMemo: true,
            order: 100, position: 0,
            disable: true,
            probability: 100, useProbability: false,
            depth: 4, group: '', groupOverride: false, groupWeight: 100,
            extensions: { rpgCategory: 'NPC', rpgSkeleton: true },
        };
        newNames.push(rec.label);
        nextUid++;
    }

    const saveRes = await fetch('/api/worldinfo/edit', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({ name: skeletonBookName, data: skeletonBook })
    });
    if (!saveRes.ok) throw new Error(`Skeleton generator save failed: HTTP ${saveRes.status}`);

    const ctx = SillyTavern.getContext();
    try { await ctx.saveWorldInfo(skeletonBookName, skeletonBook); } catch (_) {}

    if (archiveBooks) archiveBooks[skeletonBookName] = skeletonBook;

    broadcastStep('thought', `\uD83E\uDDEC Skeleton Generator: ${newNames.length} NPC(s) created (${newNames.join(', ')}).`);
    return newNames;
}

/**
 * Generates the World Skeleton: a hidden lorebook of foundational undiscovered
 * entities (factions, locations, NPCs, conflicts) seeded from the user's atmosphere summary.
 * Saves all entries to [CampaignPrefix]_Skeleton. Overwrites any existing skeleton.
 *
 * @param {string} atmosphereSummary - User-provided setting/atmosphere summary for the world
 * @returns {Promise<number>} Number of skeleton entries created
 */
export async function runSkeletonGenerationPass(atmosphereSummary, append = false, useExisting = true) {
    const settings = getSettings();
    const prefix = getLivePrefix();
    const skeletonBookName = prefix ? `${prefix}_Skeleton` : 'World_Skeleton';

    broadcastStep('thought', `\uD83D\uDDE6 World Skeleton: Generating entries...`);

    const ctx = SillyTavern.getContext();
    let skeletonBook = null;
    if (append) {
        try {
            skeletonBook = await ctx.loadWorldInfo(skeletonBookName);
        } catch (_) {}
    }
    if (!skeletonBook || !skeletonBook.entries) {
        skeletonBook = { entries: {}, name: skeletonBookName, scan_depth: 4, token_budget: 400, recursive: false, extensions: {} };
    }

    const factionCount = settings.worldProgressionSkeletonFactions ?? 4;
    const locationCount = settings.worldProgressionSkeletonLocations ?? 4;
    const npcCount = settings.worldProgressionSkeletonNPCs ?? 0;
    const conflictCount = settings.worldProgressionSkeletonConflicts ?? 3;
    const atmosphere = (atmosphereSummary || settings.worldProgressionSkeletonAtmosphereSummary || '').trim();

    const systemPrompt = (settings.worldProgressionSkeletonSystemPrompt || '')
        .replace(/\{factionCount\}/g, String(factionCount))
        .replace(/\{locationCount\}/g, String(locationCount))
        .replace(/\{npcCount\}/g, String(npcCount))
        .replace(/\{conflictCount\}/g, String(conflictCount));

    // Gather existing entity details to avoid duplication and provide full context
    let existingEntitiesStr = '';
    if (append && useExisting && skeletonBook.entries) {
        const entries = Object.values(skeletonBook.entries)
            .filter(e => e.comment && e.content);
        if (entries.length > 0) {
            const formattedEntries = entries.map(e => {
                const cleanContent = e.content.replace(/^\[Day 0 Baseline\]\n?/i, '').trim();
                return `### ${e.comment}\n${cleanContent}`;
            }).join('\n\n');
            existingEntitiesStr = `Avoid duplicating these or generating similar entities. Build on top of or expand this context with new, unique entities:\n\n${formattedEntries}`;
        }
    }

    let userPrompt = `## ATMOSPHERE / DESCRIPTION\n${atmosphere || '(No atmosphere description provided — generate a generic fantasy world skeleton.)'}\n\n`;
    if (existingEntitiesStr) {
        userPrompt += `## EXISTING SKELETON ENTITIES\n${existingEntitiesStr}\n\n`;
    }
    userPrompt += `Generate ${append ? 'additional' : 'the'} world skeleton ${append ? 'entities' : ''} now.`;

    const routerSettings = {
        connectionSource: settings.worldConnectionSource || 'default',
        connectionProfileId: settings.worldConnectionProfileId,
        completionPresetId: settings.worldCompletionPresetId,
        ollamaUrl: settings.worldOllamaUrl,
        ollamaModel: settings.worldOllamaModel,
        openaiUrl: settings.worldOpenaiUrl,
        openaiKey: settings.worldOpenaiKey,
        openaiModel: settings.worldOpenaiModel,
    };

    let rawOutput;
    try {
        rawOutput = await sendStateRequest(routerSettings, systemPrompt, userPrompt);
    } catch (e) {
        broadcastStep('error', `World Skeleton generation failed: ${e.message}`);
        throw e;
    }
    if (!rawOutput?.trim()) {
        broadcastStep('error', 'World Skeleton: LLM returned empty response.');
        throw new Error('Empty skeleton response');
    }

    const records = parseSkeletonOutput(rawOutput);
    if (records.length === 0) {
        broadcastStep('error', 'World Skeleton: Could not parse any entries from LLM output.');
        throw new Error('No parseable skeleton entries');
    }

    // Determine starting uid for new entries
    let uid = 0;
    if (append && skeletonBook.entries) {
        const keys = Object.keys(skeletonBook.entries).map(Number);
        if (keys.length > 0) {
            uid = Math.max(...keys) + 1;
        }
    }

    for (const rec of records) {
        const prefixMap = { 'FAC': 'FACTION', 'LOC': 'LOCATION', 'NPC': 'NPC', 'EVENT': 'CONFLICT' };
        const typePrefix = prefixMap[rec.category] || 'ENTITY';
        const typePrefixedLabel = `${typePrefix}: ${rec.label}`;

        skeletonBook.entries[uid] = {
            uid,
            key: [], // No keywords to prevent narrative activation
            keysecondary: [],
            comment: typePrefixedLabel,
            content: `[Day 0 Baseline]\n${rec.content}`,
            constant: false, selective: false, selectiveLogic: 0, addMemo: true,
            order: 100, position: 0,
            disable: true, // Always disabled — never injected into narrative context
            probability: 100, useProbability: false,
            depth: 4, group: '', groupOverride: false, groupWeight: 100,
            extensions: { rpgCategory: rec.category, rpgSkeleton: true },
        };
        uid++;
    }

    const saveRes = await fetch('/api/worldinfo/edit', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({ name: skeletonBookName, data: skeletonBook })
    });
    if (!saveRes.ok) {
        broadcastStep('error', `World Skeleton: Failed to save lorebook (HTTP ${saveRes.status})`);
        throw new Error(`Save failed: ${saveRes.status}`);
    }

    // Register book with ST's in-memory registry
    try { await ctx.saveWorldInfo(skeletonBookName, skeletonBook); } catch (_) {}

    // Register in campaignBooks if not already there
    const chatId = typeof globalThis._rpgCurrentChatId === 'function' ? globalThis._rpgCurrentChatId() : null;
    if (chatId && settings.chatStates?.[chatId]) {
        const existing = new Set(settings.chatStates[chatId].campaignBooks || []);
        existing.add(skeletonBookName);
        settings.chatStates[chatId].campaignBooks = [...existing];
        ctx.saveSettingsDebounced();
    }

    // Refresh the SillyTavern UI so it updates immediately without F5
    setTimeout(async () => {
        try {
            if (typeof ctx.updateWorldInfoList === 'function') {
                await ctx.updateWorldInfoList();
            }
            if (typeof ctx.reloadWorldInfoEditor === 'function') {
                ctx.reloadWorldInfoEditor(skeletonBookName, true);
            }
        } catch (uiErr) {
            console.warn('[RPG Tracker] UI refresh after skeleton generation failed:', uiErr);
        }
    }, 200);

    broadcastStep('finish', `\uD83D\uDDE6 World Skeleton: ${records.length} entries generated and saved to "${skeletonBookName}".`);
    return records.length;
}

/**
 * Promotes a skeleton entity to the active lorebook when the player discovers it.
 * Scans Historical World Reports for references to the entity and performs a merge
 * LLM pass to synthesize a cohesive, up-to-date lore entry incorporating both
 * the Day 0 stub and any off-screen history accumulated since then.
 *
 * @param {string} skeletonId     - "BookName::uid" of the skeleton entry to promote
 * @param {string} newLabel       - Label of the newly discovered entry (from Lorebook Agent)
 * @param {string} newContent     - Content of the newly discovered entry
 * @param {Object} archiveBooks   - Loaded lorebook map (from runWorldProgressionPass or applyAction)
 * @returns {Promise<{label: string, content: string, category: string}|null>}
 */
export async function promoteSkeletonEntity(skeletonId, newLabel, newContent, archiveBooks) {
    const [skeletonBookName, uid] = skeletonId.split('::');
    const skeletonBook = archiveBooks[skeletonBookName];
    if (!skeletonBook?.entries?.[uid]) return null;

    const skeletonEntry = skeletonBook.entries[uid];
    const skeletonContent = (skeletonEntry.content || '').trim();
    const category = skeletonEntry.extensions?.rpgCategory || 'NPC';

    // Gather historical world report references to this entity
    const nameLower = newLabel.toLowerCase();
    const historySnippets = [];
    for (const [bookName, book] of Object.entries(archiveBooks)) {
        if (!bookName.toLowerCase().endsWith('_world') && bookName.toLowerCase() !== 'world') continue;
        const sorted = Object.entries(book.entries).sort(([a], [b]) => Number(a) - Number(b));
        for (const [, entry] of sorted) {
            if ((entry.content || '').toLowerCase().includes(nameLower)) {
                const reportLabel = entry.comment || '(unknown period)';
                historySnippets.push(`[${reportLabel}] ${(entry.content || '').trim()}`);
            }
        }
    }

    if (historySnippets.length === 0) {
        // No off-screen history — simple merge of stub + scene entry
        const merged = skeletonContent && newContent
            ? `${newContent}\n\n[Prior State]\n${skeletonContent}`
            : (newContent || skeletonContent);
        // Delete skeleton entry
        await deleteLorebookEntry(skeletonId);
        return { label: newLabel, content: merged, category };
    }

    // Run merge LLM pass to synthesize a complete up-to-date entry
    const settings = getSettings();
    const systemPrompt = `You are a Lore Synthesizer. You will be given three pieces of information about an entity:
1. Their original Day 0 background stub (how they were at campaign start)
2. Their off-screen activity history extracted from World Progression reports
3. A new scene-based description written after the player has encountered them

Synthesize these into a single, cohesive, up-to-date lore entry. Write in third person.
Preserve all specific names, facts, and events. Do not invent new information.
Output ONLY the final lore entry text. No preamble, no labels, no meta-commentary.`;

    const userPrompt = `## ENTITY: ${newLabel}

## DAY 0 SKELETON STUB
${skeletonContent}

## OFF-SCREEN HISTORY (from World Progression reports)
${historySnippets.join('\n\n---\n\n')}

## NEW SCENE-BASED DESCRIPTION (player has now encountered this entity)
${newContent}

Synthesize the above into one complete, up-to-date lore entry.`;

    const routerSettings = {
        connectionSource: settings.worldConnectionSource || 'default',
        connectionProfileId: settings.worldConnectionProfileId,
        completionPresetId: settings.worldCompletionPresetId,
        ollamaUrl: settings.worldOllamaUrl,
        ollamaModel: settings.worldOllamaModel,
        openaiUrl: settings.worldOpenaiUrl,
        openaiKey: settings.worldOpenaiKey,
        openaiModel: settings.worldOpenaiModel,
    };

    let mergedContent;
    try {
        mergedContent = await sendStateRequest(routerSettings, systemPrompt, userPrompt);
    } catch (_) {
        // Merge failed — fall back to simple concatenation
        mergedContent = `${newContent}\n\n[Off-screen history]\n${historySnippets.join('\n\n')}`;
    }

    // Delete skeleton entry
    await deleteLorebookEntry(skeletonId);

    broadcastStep('thought', `\uD83D\uDDE6 Skeleton Promotion: "${newLabel}" promoted with ${historySnippets.length} history reference(s).`);
    return { label: newLabel, content: (mergedContent || '').trim(), category };
}

/**
 * Manually consolidates a specific number of raw World Progression reports.
 * @param {number} targetCount - Number of raw reports to consolidate.
 * @returns {Promise<string>} - The consolidated label (e.g., "Days 1-7").
 */
export async function runWorldProgressionConsolidationPass(targetCount) {
    const settings = getSettings();
    const prefix = getLivePrefix();
    const worldBookName = prefix ? `${prefix}_World` : 'World';

    const routerSettings = {
        connectionSource: settings.worldConnectionSource || 'default',
        connectionProfileId: settings.worldConnectionProfileId,
        completionPresetId: settings.worldCompletionPresetId,
        ollamaUrl: settings.worldOllamaUrl,
        ollamaModel: settings.worldOllamaModel,
        openaiUrl: settings.worldOpenaiUrl,
        openaiKey: settings.worldOpenaiKey,
        openaiModel: settings.worldOpenaiModel,
    };

    const ctx = SillyTavern.getContext();
    if (typeof ctx.updateWorldInfoList === 'function') {
        try { await ctx.updateWorldInfoList(); } catch (_) {}
    }

    const allBookNames = await getWorldInfoNamesSafe();
    const archiveBooks = {};
    for (const n of allBookNames) {
        if (prefix && !bookBelongsToPrefix(n, prefix)) continue;
        try {
            const b = await ctx.loadWorldInfo(n);
            if (b?.entries) archiveBooks[n] = b;
        } catch (_) {}
    }

    const currentWorldBook = archiveBooks[worldBookName] ?? null;
    if (!currentWorldBook?.entries) {
        throw new Error(`World lorebook "${worldBookName}" not found or empty.`);
    }

    // Sort entries chronologically by UID
    const allWorldEntries = Object.entries(currentWorldBook.entries)
        .sort(([a], [b]) => Number(a) - Number(b));

    const isRawReport = (label) => {
        if (!/^day\s+\d+/i.test(label)) return false;
        if (/days?\s+\d+\s*[\-\u2013\u2014]\s*\d+/i.test(label)) return false;
        if (/condensed|compressed|merged|summary/i.test(label)) return false;
        return true;
    };

    const rawEntries = allWorldEntries.filter(([, e]) =>
        isRawReport((e.comment || '').trim())
    );

    if (rawEntries.length < 2) {
        throw new Error(`Need at least 2 raw reports to consolidate. Found ${rawEntries.length}.`);
    }

    const countToUse = Math.max(2, Math.min(targetCount || 7, rawEntries.length));
    const toConsolidate = rawEntries.slice(0, countToUse);

    const rawDump = toConsolidate
        .map(([, e]) => `### ${(e.comment || '').trim()}\n${(e.content || '').trim()}`)
        .join('\n\n');

    const dayNums = toConsolidate.map(([, e]) => {
        const m = (e.comment || '').match(/Day\s+(\d+)/i);
        return m ? parseInt(m[1], 10) : null;
    }).filter(n => n !== null);
    const minDay = dayNums.length ? Math.min(...dayNums) : 1;
    const maxDay = dayNums.length ? Math.max(...dayNums) : minDay;
    const consolidatedLabel = (minDay === maxDay)
        ? `Day ${minDay} (Condensed)`
        : `Days ${minDay}\u2013${maxDay}`;

    const consolidationSystemPrompt =
`You are the World Archivist. Compress the following World Progression reports into a single, unified summary while preserving maximum narrative signal.

## RULES
1. Merge all reports into a single coherent, present-tense narrative.
2. Always retain temporal context. The summary MUST begin with the overall period label (e.g. "[${consolidatedLabel}]"). Never remove all temporal markers.
3. Preserve every unique fact — faction developments, NPC actions, location changes, economic shifts, and plot developments. Never replace detailed facts with generic summaries (e.g. writing "Various events occurred" is a critical failure).
4. Eliminate only true redundancies — if the same fact repeats across multiple reports, write it once.
5. Target 40–60% of the combined original token count.
6. Format: dense prose or tight bullet points, no filler, no markdown headers beyond the period label. 1–2 sentences per development.
7. Output ONLY the compressed report content. No preamble, no tags, no meta-commentary.`;

    const consolidationUserPrompt =
`Compress the following ${toConsolidate.length} World Progression reports into a single summary for the period **${consolidatedLabel}**.

${rawDump}`;

    broadcastStep('thought', `\uD83C\uDF0D World Progression: Manually consolidating ${toConsolidate.length} reports into "${consolidatedLabel}"...`);

    const consolidatedContent = await sendStateRequest(routerSettings, consolidationSystemPrompt, consolidationUserPrompt);
    if (!consolidatedContent || !consolidatedContent.trim()) {
        throw new Error("LLM returned an empty response during consolidation.");
    }

    // Reload for fresh write
    let freshBook = null;
    try { freshBook = await ctx.loadWorldInfo(worldBookName); } catch (_) {}
    if (!freshBook?.entries) freshBook = currentWorldBook;

    const allUids = Object.keys(freshBook.entries).map(Number).filter(n => !isNaN(n));
    const nextUid = allUids.length > 0 ? Math.max(...allUids) + 1 : 0;
    freshBook.entries[nextUid] = {
        uid: nextUid,
        key: [],
        keysecondary: [],
        comment: consolidatedLabel,
        content: consolidatedContent.trim(),
        constant: false,
        selective: false, selectiveLogic: 0, addMemo: true,
        order: settings.routerDefaultOrder ?? 100,
        position: settings.routerDefaultPosition ?? 0,
        disable: true,
        probability: 100, useProbability: false,
        depth: settings.routerDefaultDepth ?? 4,
        role: null,
        group: '', groupOverride: false, groupWeight: 100,
    };

    const toDeleteUids = toConsolidate.map(([uid]) => uid);
    for (const uid of toDeleteUids) {
        delete freshBook.entries[uid];
        const fullId = `${worldBookName}::${uid}`;
        settings.activeWorldKeys = (settings.activeWorldKeys || []).filter(k => k !== fullId);
    }

    await fetch('/api/worldinfo/edit', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({ name: worldBookName, data: freshBook })
    });
    try { await ctx.saveWorldInfo(worldBookName, freshBook); } catch (_) {}

    broadcastStep('finish', `\uD83C\uDF0D World Progression: "${consolidatedLabel}" consolidated — ${toDeleteUids.length} raw reports removed.`);
    return consolidatedLabel;
}

/**
 * Generates a single paragraph Atmosphere Summary based on a lookback window of the chat.
 * Uses sendStateRequest to execute the generation call.
 * @param {number} lookbackCount
 * @returns {Promise<string>}
 */
export async function runAtmosphereGenerationPass(lookbackCount) {
    const settings = getSettings();
    const ctx = SillyTavern.getContext();
    const chat = ctx.chat || [];
    if (chat.length === 0) {
        throw new Error('No chat history available to generate atmosphere summary.');
    }

    // Grab the last lookbackCount messages
    const recentMessages = chat.slice(-lookbackCount);

    // Format them
    const lines = [];
    for (const msg of recentMessages) {
        const sender = msg.name || (msg.is_user ? 'User' : 'Assistant');
        let text = msg.mes || msg.content || '';
        if (Array.isArray(text)) {
            text = text.filter(p => p && p.type === 'text').map(p => p.text || '').join('\n');
        } else if (typeof text !== 'string') {
            text = String(text);
        }
        // Basic cleanup of tracking structures
        text = text.replace(/###\s*STATE MEMO[^]*?(?=\n\[RNG_QUEUE|\n###|\n\[(?!RNG_QUEUE)[A-Z]|$)/i, '');
        text = text.replace(/\[RNG_QUEUE\s[^\]]*\][\s\S]*?\[\/RNG_QUEUE\][ \t]*\n?/gi, '');
        text = text.replace(/\[[A-Z_]+\][\s\S]*?\[\/[A-Z_]+\]/g, '');
        text = text.replace(/###\s*CURRENT USER INPUT[^\n]*\n?/gi, '');
        text = text.replace(/\[Continue the narrative\]/gi, '');
        text = text.trim();

        if (text) {
            lines.push(`${sender}: ${text}`);
        }
    }

    if (lines.length === 0) {
        throw new Error('No readable chat messages found within the lookback window.');
    }

    const formattedChatHistory = lines.join('\n\n');

    const systemPrompt =
`You are a World Architect. Analyze the provided chat history segment and extract a concise, thematic Atmosphere Summary of the world setting.

## Atmosphere Summary Definition
A single paragraph description of the social texture, recurring tensions, and thematic tone of this world.
- Focus on the atmosphere, environment, social hierarchy, and mood.
- Do NOT name specific characters or list specific plot events.
- Keep it generalized to the setting.
- Example: 'Poverty and desperation define daily life. The nobility maintains control through debt bondage. Corruption is endemic — even the church answers to noble patrons.'

Output ONLY the single paragraph Atmosphere Summary. No preamble, no meta-commentary.`;

    const userPrompt =
`## RECENT CHAT HISTORY
${formattedChatHistory}

Generate the Atmosphere Summary:`;

    const routerSettings = {
        connectionSource: settings.worldConnectionSource || 'default',
        connectionProfileId: settings.worldConnectionProfileId,
        completionPresetId: settings.worldCompletionPresetId,
        ollamaUrl: settings.worldOllamaUrl,
        ollamaModel: settings.worldOllamaModel,
        openaiUrl: settings.worldOpenaiUrl,
        openaiKey: settings.worldOpenaiKey,
        openaiModel: settings.worldOpenaiModel,
    };

    // Fall back to general settings if world specific settings are empty
    if (routerSettings.connectionSource === 'default') {
        routerSettings.connectionProfileId = settings.connectionProfileId;
        routerSettings.completionPresetId = settings.completionPresetId;
        routerSettings.ollamaUrl = settings.ollamaUrl;
        routerSettings.ollamaModel = settings.ollamaModel;
        routerSettings.openaiUrl = settings.openaiUrl;
        routerSettings.openaiKey = settings.openaiKey;
        routerSettings.openaiModel = settings.openaiModel;
    }

    const rawOutput = await sendStateRequest(routerSettings, systemPrompt, userPrompt);
    if (!rawOutput?.trim()) throw new Error('LLM returned an empty response.');

    // Clean up surrounding quotes/newlines
    let summary = rawOutput.trim();
    if (summary.startsWith('"') && summary.endsWith('"')) {
        summary = summary.slice(1, -1).trim();
    }
    if (summary.startsWith("'") && summary.endsWith("'")) {
        summary = summary.slice(1, -1).trim();
    }

    return summary;
}