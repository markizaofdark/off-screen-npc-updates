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
const INJECTION_POSITION = 1;

const DEFAULTS = {
    enabled: true,
    hfToken: '',
    hfModel: 'mistralai/Mistral-7B-Instruct-v0.3',
    triggerEvery: 5,
    maxEvents: 7,
    injectMaxMessages: 0,
};

const CATEGORIES = ['Personal', 'Relationship', 'Status', 'Discovery', 'Social'];

const SCALE = [
    { min: 1,  max: 8,  id: 'minor',   label: 'MINOR'   },
    { min: 9,  max: 16, id: 'notable', label: 'NOTABLE' },
    { min: 17, max: 20, id: 'major',   label: 'MAJOR'   },
];

// ── State ──────────────────────────────────────────────────

let msgCounter = 0;
let loadedBookName = ''; // name of the currently loaded lorebook

// ── Settings & NPC helpers ─────────────────────────────────

function getSettings() {
    if (!extension_settings[EXT]) extension_settings[EXT] = {};
    for (const [k, v] of Object.entries(DEFAULTS)) {
        if (extension_settings[EXT][k] === undefined) {
            extension_settings[EXT][k] = v;
        }
    }
    return extension_settings[EXT];
}

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

// ── Lorebook parsing ──────────────────────────────────────

/**
 * Checks if entry is a before_char NPC entry.
 * Two conditions (either is enough):
 *   1. position === 0 or "before_char"
 *   2. keys array contains "character"
 */
function isNPCEntry(entry) {
    // Condition 1: position check
    const pos = entry.position
        ?? entry.extensions?.position
        ?? entry.insertion_position
        ?? null;
    const isBeforeChar = pos === 0 || pos === 'before_char';

    // Condition 2: keyword check
    const keys = entry.key || entry.keys || [];
    const keyArray = Array.isArray(keys) ? keys : [keys];
    const hasCharacterKeyword = keyArray.some(k =>
        typeof k === 'string' && k.toLowerCase().trim() === 'character'
    );

    return isBeforeChar || hasCharacterKeyword;
}

/**
 * Extracts NPC name and description from a lorebook entry.
 */
function extractNPCInfo(entry) {
    // Skip disabled
    if (entry.disable === true || entry.enabled === false) return null;

    const name = entry.comment
        || entry.name
        || (Array.isArray(entry.key) ? entry.key[0] : entry.key)
        || null;

    if (!name || name.trim() === '') return null;

    return {
        name: name.trim(),
        description: (entry.content || '').trim(),
    };
}

/**
 * Parses a lorebook JSON object and returns NPC list.
 * Handles both formats:
 *   - { entries: { "0": {...}, "1": {...} } }
 *   - [ {...}, {...} ]
 */
function parseLorebookJSON(data) {
    let entries = [];

    if (data.entries && typeof data.entries === 'object') {
        entries = Object.values(data.entries);
    } else if (Array.isArray(data)) {
        entries = data;
    } else {
        // Try to find entries nested somewhere
        for (const val of Object.values(data)) {
            if (val && typeof val === 'object' && val.entries) {
                entries = Object.values(val.entries);
                break;
            }
        }
    }

    const found = [];
    for (const entry of entries) {
        if (!isNPCEntry(entry)) continue;
        const info = extractNPCInfo(entry);
        if (info) found.push(info);
    }

    return found;
}

/**
 * Loads lorebook from a File object (user picked via file input).
 */
async function loadFromFile(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
            try {
                const data = JSON.parse(reader.result);
                resolve(data);
            } catch (e) {
                reject(new Error('Invalid JSON file'));
            }
        };
        reader.onerror = () => reject(new Error('File read error'));
        reader.readAsText(file);
    });
}

function registerNPCs(scanned) {
    const npcs = getNPCs();
    let added = 0;
    for (const { name, description } of scanned) {
        if (!npcs[name]) {
            npcs[name] = { name, description, enabled: true, events: [] };
            added++;
        } else {
            npcs[name].description = description;
        }
    }
    saveNPCs(npcs);
    return added;
}

// ── Event rolling & generation ─────────────────────────────

function rollD20() { return Math.floor(Math.random() * 20) + 1; }
function getScale(roll) { return SCALE.find(s => roll >= s.min && roll <= s.max) || SCALE[0]; }
function getCategory() { return CATEGORIES[Math.floor(Math.random() * CATEGORIES.length)]; }

function buildHFPrompt(npc, scale, category, isPositive) {
    const impact = isPositive ? 'positive' : 'negative';
    const history = npc.events.slice(-3).map(e => `- ${e.text}`).join('\n') || 'No previous events.';

    return `<s>[INST] You are a narrator generating offscreen story events for a roleplay character.

CHARACTER: ${npc.name}
DESCRIPTION: ${npc.description.slice(0, 600)}

RECENT EVENTS (context — do NOT repeat):
${history}

TASK: Generate ONE new offscreen event for ${npc.name}.
- Scale: ${scale.label}
- Category: ${category}
- Impact: ${impact}
- Must be influenced by recent events if relevant
- Two sentences: what happened, then the consequence.
- English only. No dialogue. No meta. Just the event.

Output only the two sentences. [/INST]`;
}

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
            if (response.status === 503) {
                console.warn('[WildOffscreen] Model cold-starting, will retry next cycle.');
                return null;
            }
            console.error('[WildOffscreen] HF API error:', response.status);
            return null;
        }

        const data = await response.json();
        const text = Array.isArray(data) ? data[0]?.generated_text : data?.generated_text;
        return text?.trim() || null;
    } catch (e) {
        console.error('[WildOffscreen] Fetch error:', e);
        return null;
    }
}

async function generateEventForNPC(npc) {
    const roll = rollD20();
    const scale = getScale(roll);
    const category = getCategory();
    const isPositive = roll % 2 === 0;

    const prompt = buildHFPrompt(npc, scale, category, isPositive);
    const text = await callHF(prompt);
    if (!text) return null;

    return {
        text,
        scale: scale.id,
        category,
        positive: isPositive,
        msgIndex: getContext().chat?.length ?? 0,
        timestamp: Date.now(),
    };
}

async function runGenerationCycle() {
    const npcs = getNPCs();
    const s = getSettings();
    const keys = Object.keys(npcs).filter(k => npcs[k].enabled);
    if (keys.length === 0) return;

    $('#wo_status').text('Generating offscreen events…').show();

    for (const key of keys) {
        const npc = npcs[key];
        const event = await generateEventForNPC(npc);
        if (!event) continue;

        npc.events.push(event);
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

function buildInjectionText(npcs, injectMax) {
    const entries = Object.values(npcs).filter(n => n.enabled && n.events.length > 0);
    if (entries.length === 0) return '';

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
        container.append('<div class="wo_empty">No NPCs registered. Load a lorebook below.</div>');
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

        card.find('.wo_npc_header').on('click', function (e) {
            if ($(e.target).closest('.wo_npc_actions').length) return;
            evContainer.slideToggle(150);
        });

        card.find('.wo_btn_toggle').on('click', () => {
            const n = getNPCs();
            n[key].enabled = !n[key].enabled;
            saveNPCs(n);
            renderNPCList();
            updateInjection();
        });

        card.find('.wo_btn_clear').on('click', () => {
            if (!confirm(`Clear all events for ${key}?`)) return;
            const n = getNPCs();
            n[key].events = [];
            saveNPCs(n);
            renderNPCList();
            updateInjection();
        });

        card.find('.wo_btn_delete').on('click', () => {
            if (!confirm(`Remove ${key} from tracking?`)) return;
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

            <!-- Lorebook loading -->
            <div class="wo_section_label">Lorebook</div>
            <div id="wo_book_info" class="wo_book_info">No lorebook loaded</div>
            <div class="wo_actions">
                <label class="menu_button wo_file_btn" for="wo_file_input">📂 Load Lorebook</label>
                <input type="file" id="wo_file_input" accept=".json" style="display:none;" />
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

// ── Init ───────────────────────────────────────────────────

jQuery(async () => {
    buildUI();
    const s = getSettings();

    $('#wo_toggle').prop('checked', s.enabled);
    $('#wo_hf_token').val(s.hfToken);
    $('#wo_hf_model').val(s.hfModel);
    $('#wo_trigger_every').val(s.triggerEvery);
    $('#wo_max_events').val(s.maxEvents);
    $('#wo_inject_max').val(s.injectMaxMessages);

    renderNPCList();

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

    // ── File picker — load lorebook JSON ──
    $('#wo_file_input').on('change', async function () {
        const file = this.files?.[0];
        if (!file) return;

        try {
            const data = await loadFromFile(file);
            const npcs = parseLorebookJSON(data);

            if (npcs.length === 0) {
                toastr.warning('No NPC entries found. Make sure entries have position "before_char" or keyword "character" in keys.');
                console.warn('[WildOffscreen] Parsed lorebook but found 0 matching entries. Total entries checked:', 
                    data.entries ? Object.keys(data.entries).length : 'unknown');
                return;
            }

            loadedBookName = file.name.replace('.json', '');
            const added = registerNPCs(npcs);
            renderNPCList();
            updateInjection();

            $('#wo_book_info').text(`📖 ${loadedBookName} — ${npcs.length} NPCs found`);
            toastr.success(`Loaded: ${npcs.length} NPCs found, ${added} newly added.`);
        } catch (e) {
            toastr.error(`Failed to load lorebook: ${e.message}`);
            console.error('[WildOffscreen] Load error:', e);
        }

        // Reset file input so same file can be re-selected
        this.value = '';
    });

    // ── Generate now ──
    $('#wo_generate_now').on('click', async () => {
        if (!s.hfToken) {
            toastr.error('HuggingFace API token required.');
            return;
        }
        await runGenerationCycle();
        toastr.success('Offscreen events generated.');
    });

    // ── Hooks ──
    eventSource.on(event_types.GENERATION_STARTED, onGenerationStarted);

    eventSource.on(event_types.CHAT_CHANGED, () => {
        msgCounter = 0;
        renderNPCList();
        updateInjection();
    });

    updateInjection();
});
