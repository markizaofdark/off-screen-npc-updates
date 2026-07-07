/**
 * Wild Offscreen — SillyTavern Extension
 * Tracks offscreen NPC lives: generates events every N messages via HuggingFace API.
 * Events influence each other — each NPC has a running history that affects next events.
 * Injects a summary block into the system prompt so the main model knows what happened.
 */

import { extension_settings, getContext } from '../../../extensions.js';
import {
    saveSettingsDebounced,
    eventSource,
    event_types,
    setExtensionPrompt,
} from '../../../../script.js';

// ── Constants ──────────────────────────────────────────────

const EXT = 'wild-offscreen';
const INJECTION_POSITION = 1; // system prompt

const DEFAULTS = {
    enabled: true,
    hfToken: '',
    hfModel: 'mistralai/Mistral-7B-Instruct-v0.3',
    triggerEvery: 5,       // generate events every N messages
    maxEvents: 7,          // max stored events per NPC
    injectMaxMessages: 0,  // 0 = inject all NPCs; N = only NPCs seen in last N messages
    selectedLorebook: '',  // name of lorebook to scan
};

// Event categories with weights (higher = more likely on low rolls)
const CATEGORIES = ['Personal', 'Relationship', 'Status', 'Discovery', 'Social'];

// Scale thresholds based on d20 roll
const SCALE = [
    { min: 1,  max: 8,  id: 'minor',   label: 'MINOR'   },
    { min: 9,  max: 16, id: 'notable', label: 'NOTABLE' },
    { min: 17, max: 20, id: 'major',   label: 'MAJOR'   },
];

// ── State ──────────────────────────────────────────────────

let msgCounter = 0; // counts messages since last event generation cycle

// ── Settings & NPC data helpers ────────────────────────────

function getSettings() {
    if (!extension_settings[EXT]) extension_settings[EXT] = {};
    for (const [k, v] of Object.entries(DEFAULTS)) {
        if (extension_settings[EXT][k] === undefined) {
            extension_settings[EXT][k] = v;
        }
    }
    return extension_settings[EXT];
}

/** NPC data is stored per-chat in chatMetadata */
function getNPCs() {
    const ctx = getContext();
    if (!ctx.chatMetadata) return {};
    if (!ctx.chatMetadata.wild_offscreen_npcs) ctx.chatMetadata.wild_offscreen_npcs = {};
    return ctx.chatMetadata.wild_offscreen_npcs;
}

function saveNPCs(npcs) {
    const ctx = getContext();
    if (!ctx.chatMetadata) return;
    ctx.chatMetadata.wild_offscreen_npcs = npcs;
    ctx.saveMetadata();
}

// ── Lore scanning ──────────────────────────────────────────

/**
 * Returns a list of all available lorebook names ST knows about.
 * Tries multiple locations ST uses across versions.
 */
function getAvailableLorebooks() {
    const names = new Set();

    // Primary source: ST's world_names array — these are the actual file/display names
    if (Array.isArray(window.world_names)) {
        for (const n of window.world_names) if (n) names.add(n);
    }

    // ST >= 1.12 worldInfoData is keyed by name
    if (window.worldInfoData && typeof window.worldInfoData === 'object') {
        for (const k of Object.keys(window.worldInfoData)) {
            // Skip numeric-only keys (those are entry IDs, not book names)
            if (!/^\d+$/.test(k)) names.add(k);
        }
    }

    // loaded_world_info may be an array of name strings
    if (Array.isArray(window.loaded_world_info)) {
        for (const n of window.loaded_world_info) if (n && typeof n === 'string') names.add(n);
    }

    // window.world_info is usually { [index]: data } — keys are numbers, skip for names
    // but if somehow a version uses string keys, grab them
    if (window.world_info && typeof window.world_info === 'object' && !Array.isArray(window.world_info)) {
        for (const k of Object.keys(window.world_info)) {
            if (!/^\d+$/.test(k)) names.add(k);
        }
    }

    return [...names].sort();
}

/**
 * Extracts entries array from a lorebook data object.
 * Handles: array, {entries:{...}}, numeric-keyed object {0:{...},1:{...}}.
 */
function extractEntries(lorebookData) {
    if (!lorebookData) return [];
    if (Array.isArray(lorebookData)) return lorebookData;
    // Named entries object: { entries: { 0: {...}, 1: {...} } }
    if (lorebookData.entries && typeof lorebookData.entries === 'object') {
        return Object.values(lorebookData.entries);
    }
    // Flat numeric-keyed object: { 0: {...}, 1: {...} }
    const vals = Object.values(lorebookData);
    if (vals.length && vals[0] && typeof vals[0] === 'object' && ('content' in vals[0] || 'key' in vals[0])) {
        return vals;
    }
    // One more level deep (some ST versions wrap everything)
    const first = vals[0];
    if (first && first.entries) return Object.values(first.entries);
    return [];
}

/**
 * Scans a specific lorebook (by name) for NPC entries.
 * Match criteria (OR logic):
 *   1. position === before_char (0 or 'before_char')
 *   2. any key contains the word "character" (case-insensitive)
 */
function scanLorebook(lorebookName) {
    // --- Resolve raw entries ---
    let rawEntries = [];

    if (lorebookName) {
        // world_names[i] => world_info[i] mapping (most common ST layout)
        if (Array.isArray(window.world_names) && window.world_info) {
            const idx = window.world_names.indexOf(lorebookName);
            if (idx !== -1 && window.world_info[idx]) {
                rawEntries = extractEntries(window.world_info[idx]);
            }
        }
        // Fallback: worldInfoData keyed by name
        if (rawEntries.length === 0 && window.worldInfoData?.[lorebookName]) {
            rawEntries = extractEntries(window.worldInfoData[lorebookName]);
        }
        // Fallback: world_info keyed by name directly
        if (rawEntries.length === 0 && window.world_info?.[lorebookName]) {
            rawEntries = extractEntries(window.world_info[lorebookName]);
        }
    }

    // Last resort: active lorebook from context
    if (rawEntries.length === 0) {
        const ctx = getContext();
        const wi = ctx.worldInfo || ctx.world_info || {};
        rawEntries = extractEntries(wi);
    }

    // --- Filter: before_char OR keyword contains "character" ---
    const found = [];
    for (const entry of rawEntries) {
        if (entry.disable === true || entry.enabled === false) continue;

        const pos = entry.position ?? entry.extensions?.position ?? entry.insertion_position;
        const isBeforeChar = pos === 0 || pos === 'before_char';

        // Keys can be an array of strings
        const keys = Array.isArray(entry.key) ? entry.key : (entry.key ? [entry.key] : []);
        const hasCharacterKey = keys.some(k => /character/i.test(k));

        if (!isBeforeChar && !hasCharacterKey) continue;

        const name = entry.comment || entry.name || keys[0] || null;
        if (!name) continue;

        found.push({
            name,
            description: entry.content || '',
            matchReason: isBeforeChar ? 'before_char' : 'keyword:character',
        });
    }

    return found;
}

function registerNPCs(scanned) {
    const npcs = getNPCs();
    let added = 0;

    for (const { name, description } of scanned) {
        if (!npcs[name]) {
            npcs[name] = {
                name,
                description,
                enabled: true,
                events: [],
            };
            added++;
        } else {
            // Update description in case lorebook changed
            npcs[name].description = description;
        }
    }

    saveNPCs(npcs);
    return added;
}

// ── Event rolling ──────────────────────────────────────────

function rollD20() {
    return Math.floor(Math.random() * 20) + 1;
}

function getScale(roll) {
    return SCALE.find(s => roll >= s.min && roll <= s.max) || SCALE[0];
}

function getCategory() {
    return CATEGORIES[Math.floor(Math.random() * CATEGORIES.length)];
}

/**
 * Builds the HuggingFace prompt for one NPC event generation.
 * Sends character description + last events as context.
 */
function buildHFPrompt(npc, scale, category, isPositive) {
    const impact = isPositive ? 'positive' : 'negative';
    const recentHistory = npc.events.slice(-3).map(e => `- ${e.text}`).join('\n') || 'No previous events.';

    return `<s>[INST] You are a narrator generating offscreen story events for a roleplay character.

CHARACTER: ${npc.name}
DESCRIPTION: ${npc.description.slice(0, 600)}

RECENT EVENTS (for context, do NOT repeat these):
${recentHistory}

TASK: Generate exactly ONE new offscreen event for ${npc.name}.
Rules:
- Scale: ${scale.label} (${scale.id})
- Category: ${category}
- Impact: ${impact} for ${npc.name}
- Must be influenced by recent events if relevant
- Format: two sentences. First: what happened. Second: the immediate consequence.
- English only. No dialogue. No meta-commentary. Just the event.
- Keep it grounded and specific, not vague.

Output only the two sentences, nothing else. [/INST]`;
}

/**
 * Calls HuggingFace Inference API.
 * Returns generated text string or null on failure.
 */
async function callHF(prompt) {
    const s = getSettings();
    if (!s.hfToken) return null;

    try {
        const response = await fetch(
            `https://api-inference.huggingface.co/models/${s.hfModel}`,
            {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${s.hfToken}`,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    inputs: prompt,
                    parameters: {
                        max_new_tokens: 80,
                        temperature: 0.85,
                        do_sample: true,
                        return_full_text: false,
                    },
                }),
            }
        );

        if (!response.ok) {
            const err = await response.json().catch(() => ({}));
            // Model loading — HF returns 503 when model is cold
            if (response.status === 503) {
                console.warn('[WildOffscreen] Model loading, will retry next cycle.');
                return null;
            }
            console.error('[WildOffscreen] HF API error:', err);
            return null;
        }

        const data = await response.json();
        const text = Array.isArray(data)
            ? data[0]?.generated_text
            : data?.generated_text;

        return text?.trim() || null;
    } catch (e) {
        console.error('[WildOffscreen] Fetch error:', e);
        return null;
    }
}

/**
 * Generates one event for one NPC and stores it.
 */
async function generateEventForNPC(npc) {
    const roll = rollD20();
    const scale = getScale(roll);
    const category = getCategory();
    const isPositive = roll % 2 === 0;

    const prompt = buildHFPrompt(npc, scale, category, isPositive);
    const text = await callHF(prompt);

    if (!text) return null;

    const event = {
        text,
        scale: scale.id,
        category,
        positive: isPositive,
        msgIndex: getContext().chat?.length ?? 0,
        timestamp: Date.now(),
    };

    return event;
}

/**
 * Runs event generation cycle for all enabled NPCs.
 * Fires every triggerEvery messages.
 */
async function runGenerationCycle() {
    const npcs = getNPCs();
    const s = getSettings();
    const keys = Object.keys(npcs).filter(k => npcs[k].enabled);

    if (keys.length === 0) return;

    // Show loading indicator
    $('#wo_status').text('Generating offscreen events…').show();

    for (const key of keys) {
        const npc = npcs[key];
        const event = await generateEventForNPC(npc);
        if (!event) continue;

        npc.events.push(event);
        // Trim to max
        if (npc.events.length > s.maxEvents) {
            npc.events = npc.events.slice(-s.maxEvents);
        }
    }

    saveNPCs(npcs);
    updateInjection();
    renderNPCList();
    $('#wo_status').text('').hide();
}

// ── Injection ──────────────────────────────────────────────

/**
 * Builds the text block injected into the system prompt.
 * Main model uses this when a character enters a scene.
 */
function buildInjectionText(npcs, injectMax) {
    const entries = Object.values(npcs).filter(n => n.enabled && n.events.length > 0);

    if (entries.length === 0) return '';

    // If injectMax > 0, only include NPCs mentioned in last N chat messages
    let filtered = entries;
    if (injectMax > 0) {
        const ctx = getContext();
        const chat = ctx.chat ?? [];
        const recent = chat.slice(-injectMax).map(m => m.mes?.toLowerCase() || '').join(' ');
        filtered = entries.filter(n => recent.includes(n.name.toLowerCase()));
    }

    if (filtered.length === 0) return '';

    const lines = filtered.map(npc => {
        const last = npc.events.slice(-3);
        const evLines = last.map(e => {
            const sign = e.positive ? '+' : '−';
            return `  [${sign}${e.scale.toUpperCase()}] ${e.text}`;
        }).join('\n');
        return `• ${npc.name}:\n${evLines}`;
    });

    return [
        '[OFF-SCREEN NPC UPDATES — use when character enters scene. Do NOT generate this block yourself.]',
        lines.join('\n'),
        '[/OFF-SCREEN NPC UPDATES]',
    ].join('\n');
}

function updateInjection() {
    const s = getSettings();
    if (!s.enabled) {
        setExtensionPrompt(EXT, '', INJECTION_POSITION, 0);
        return;
    }

    const npcs = getNPCs();
    const text = buildInjectionText(npcs, s.injectMaxMessages);
    setExtensionPrompt(EXT, text, INJECTION_POSITION, 0, false, 0);
}

// ── Generation hook ────────────────────────────────────────

function onGenerationStarted() {
    const s = getSettings();
    if (!s.enabled || !s.hfToken) return;

    msgCounter++;

    if (msgCounter >= s.triggerEvery) {
        msgCounter = 0;
        // Run async, don't block generation
        runGenerationCycle();
    }

    updateInjection();
}

// ── UI ─────────────────────────────────────────────────────

function renderNPCList() {
    const npcs = getNPCs();
    const container = $('#wo_npc_list');
    container.empty();

    const keys = Object.keys(npcs);
    if (keys.length === 0) {
        container.append('<div class="wo_empty">No NPCs registered. Click Scan.</div>');
        return;
    }

    for (const key of keys) {
        const npc = npcs[key];
        const count = npc.events.length;
        const enabledClass = npc.enabled ? '' : 'wo_npc_disabled';

        const card = $(`
        <div class="wo_npc_card ${enabledClass}" data-name="${key}">
            <div class="wo_npc_header">
                <span class="wo_npc_name">${npc.name}</span>
                <span class="wo_npc_count">${count} event${count !== 1 ? 's' : ''}</span>
                <div class="wo_npc_actions">
                    <button class="wo_btn_toggle menu_button" title="${npc.enabled ? 'Disable' : 'Enable'}">${npc.enabled ? '⏸' : '▶'}</button>
                    <button class="wo_btn_clear menu_button" title="Clear events">🗑</button>
                    <button class="wo_btn_delete menu_button" title="Remove NPC">✕</button>
                </div>
            </div>
            <div class="wo_npc_events" style="display:none;"></div>
        </div>`);

        // Populate events
        const evContainer = card.find('.wo_npc_events');
        if (npc.events.length === 0) {
            evContainer.append('<div class="wo_no_events">No events yet.</div>');
        } else {
            for (const ev of [...npc.events].reverse()) {
                const sign = ev.positive ? '▲' : '▼';
                const color = ev.positive ? '#66bb6a' : '#ef5350';
                evContainer.append(`
                <div class="wo_event">
                    <span class="wo_event_meta" style="color:${color}">${sign} ${ev.scale.toUpperCase()} · ${ev.category}</span>
                    <div class="wo_event_text">${ev.text}</div>
                </div>`);
            }
        }

        // Toggle accordion
        card.find('.wo_npc_header').on('click', function (e) {
            if ($(e.target).closest('.wo_npc_actions').length) return;
            evContainer.slideToggle(150);
        });

        // Enable/disable
        card.find('.wo_btn_toggle').on('click', () => {
            const n = getNPCs();
            n[key].enabled = !n[key].enabled;
            saveNPCs(n);
            renderNPCList();
            updateInjection();
        });

        // Clear events
        card.find('.wo_btn_clear').on('click', () => {
            if (!confirm(`Clear all events for ${key}?`)) return;
            const n = getNPCs();
            n[key].events = [];
            saveNPCs(n);
            renderNPCList();
            updateInjection();
        });

        // Delete NPC
        card.find('.wo_btn_delete').on('click', () => {
            if (!confirm(`Remove ${key} from offscreen tracking?`)) return;
            const n = getNPCs();
            delete n[key];
            saveNPCs(n);
            renderNPCList();
            updateInjection();
        });

        container.append(card);
    }
}

function buildUI() {
    const html = `
    <div id="wo_panel" class="inline-drawer">
        <div class="inline-drawer-toggle inline-drawer-header">
            <b>Wild Offscreen</b>
            <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
        </div>
        <div class="inline-drawer-content">

            <label class="checkbox_label">
                <input type="checkbox" id="wo_toggle" />
                <span>Enable</span>
            </label>

            <div id="wo_status" class="wo_status" style="display:none;"></div>

            <!-- NPC list -->
            <div id="wo_npc_list" class="wo_npc_list"></div>

            <!-- Lorebook selector -->
            <div class="wo_lorebook_row">
                <label><small>Lorebook to scan</small></label>
                <div class="wo_lorebook_select_wrap">
                    <select id="wo_lorebook_select" class="text_pole wo_lorebook_select">
                        <option value="">(auto — active lorebook)</option>
                    </select>
                    <input type="button" id="wo_lorebook_refresh" class="menu_button wo_lorebook_refresh_btn" title="Refresh lorebook list" value="↻" />
                </div>
            </div>

            <!-- Actions -->
            <div class="wo_actions">
                <input type="button" id="wo_scan" class="menu_button" value="⟳ Scan Lorebook" />
                <input type="button" id="wo_generate_now" class="menu_button" value="⚡ Generate Now" />
            </div>

            <hr>

            <!-- Settings -->
            <label><small>HuggingFace API Token</small></label>
            <input type="password" id="wo_hf_token" class="text_pole" placeholder="hf_..." />

            <label><small>HuggingFace Model</small></label>
            <input type="text" id="wo_hf_model" class="text_pole" />

            <label><small>Generate events every N messages</small></label>
            <input type="number" id="wo_trigger_every" class="text_pole" min="1" max="50" step="1" />

            <label><small>Max stored events per NPC</small></label>
            <input type="number" id="wo_max_events" class="text_pole" min="1" max="20" step="1" />

            <label><small>Inject only NPCs seen in last N messages (0 = all)</small></label>
            <input type="number" id="wo_inject_max" class="text_pole" min="0" max="200" step="1" />

        </div>
    </div>`;

    $('#extensions_settings').append(html);
}

// ── Lorebook selector ──────────────────────────────────────

function populateLorebookSelect(savedValue) {
    const select = $('#wo_lorebook_select');
    const books = getAvailableLorebooks();
    select.empty().append('<option value="">(auto — active lorebook)</option>');
    for (const name of books) {
        const opt = $('<option>').val(name).text(name);
        if (name === savedValue) opt.prop('selected', true);
        select.append(opt);
    }
    // If saved value not in list but non-empty, add it anyway so it isn't lost
    if (savedValue && !books.includes(savedValue)) {
        select.append($('<option>').val(savedValue).text(savedValue).prop('selected', true));
    }
}

// ── Init ───────────────────────────────────────────────────

jQuery(async () => {
    buildUI();

    const s = getSettings();

    // Populate UI
    $('#wo_toggle').prop('checked', s.enabled);
    $('#wo_hf_token').val(s.hfToken);
    $('#wo_hf_model').val(s.hfModel);
    $('#wo_trigger_every').val(s.triggerEvery);
    $('#wo_max_events').val(s.maxEvents);
    $('#wo_inject_max').val(s.injectMaxMessages);

    renderNPCList();
    populateLorebookSelect(s.selectedLorebook);

    // ── Settings handlers ──

    $('#wo_toggle').on('change', function () {
        s.enabled = this.checked;
        saveSettingsDebounced();
        updateInjection();
    });

    $('#wo_hf_token').on('input', function () {
        s.hfToken = this.value.trim();
        saveSettingsDebounced();
    });

    $('#wo_hf_model').on('input', function () {
        s.hfModel = this.value.trim();
        saveSettingsDebounced();
    });

    $('#wo_trigger_every').on('input', function () {
        s.triggerEvery = parseInt(this.value) || DEFAULTS.triggerEvery;
        saveSettingsDebounced();
    });

    $('#wo_max_events').on('input', function () {
        s.maxEvents = parseInt(this.value) || DEFAULTS.maxEvents;
        saveSettingsDebounced();
    });

    $('#wo_inject_max').on('input', function () {
        s.injectMaxMessages = parseInt(this.value) || 0;
        saveSettingsDebounced();
    });

    // ── Lorebook selector ──
    $('#wo_lorebook_select').on('change', function () {
        s.selectedLorebook = this.value;
        saveSettingsDebounced();
    });

    $('#wo_lorebook_refresh').on('click', () => {
        populateLorebookSelect(s.selectedLorebook);
        toastr.info('Lorebook list refreshed.');
    });

    // ── Scan button ──
    $('#wo_scan').on('click', () => {
        const bookName = s.selectedLorebook || '';
        const scanned = scanLorebook(bookName);
        if (scanned.length === 0) {
            const hint = bookName
                ? `No before_char entries found in "${bookName}".`
                : 'No before_char entries found in active lorebook. Try selecting one manually above.';
            toastr.warning(hint);
            return;
        }
        const added = registerNPCs(scanned);
        renderNPCList();
        updateInjection();
        const byPos = scanned.filter(e => e.matchReason === 'before_char').length;
        const byKey = scanned.filter(e => e.matchReason !== 'before_char').length;
        const detail = [byPos && `${byPos} by position`, byKey && `${byKey} by keyword`].filter(Boolean).join(', ');
        toastr.success(`Scan complete: ${scanned.length} found (${detail}), ${added} newly registered.`);
    });

    // ── Generate now button ──
    $('#wo_generate_now').on('click', async () => {
        if (!s.hfToken) {
            toastr.error('HuggingFace API token required.');
            return;
        }
        await runGenerationCycle();
        toastr.success('Offscreen events generated.');
    });

    // ── Generation hook ──
    eventSource.on(event_types.GENERATION_STARTED, onGenerationStarted);

    // ── Chat switch ──
    eventSource.on(event_types.CHAT_CHANGED, () => {
        msgCounter = 0;
        renderNPCList();
        updateInjection();
    });

    // Initial injection on load
    updateInjection();
});
