/**
 * Wild Offscreen — SillyTavern Extension
 * Tracks offscreen NPC lives via HuggingFace API.
 */

'use strict';

import { extension_settings, saveMetadataDebounced } from '../../../extensions.js';
import {
    saveSettingsDebounced,
    eventSource,
    event_types,
    setExtensionPrompt,
    chat_metadata,
    characters,
    this_chid,
} from '../../../../script.js';
import { world_info } from '../../../world-info.js';

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

// ── Settings ───────────────────────────────────────────────

function getSettings() {
    if (!extension_settings[EXT]) extension_settings[EXT] = {};
    for (const [k, v] of Object.entries(DEFAULTS)) {
        if (extension_settings[EXT][k] === undefined) extension_settings[EXT][k] = v;
    }
    return extension_settings[EXT];
}

// ── NPC storage ────────────────────────────────────────────

function getNPCs() {
    if (!chat_metadata.wild_offscreen_npcs) chat_metadata.wild_offscreen_npcs = {};
    return chat_metadata.wild_offscreen_npcs;
}

async function saveNPCs(npcs) {
    chat_metadata.wild_offscreen_npcs = npcs;
    await saveMetadataDebounced();
}

// ── NPC entry detection ────────────────────────────────────

function isNPCEntry(entry) {
    const pos = entry.position ?? entry.extensions?.position ?? entry.insertion_position ?? null;
    const isBeforeChar = pos === 0 || pos === 'before_char';
    const keys = entry.key || entry.keys || [];
    const keyArr = Array.isArray(keys) ? keys : [keys];
    const hasCharKw = keyArr.some(k => typeof k === 'string' && k.toLowerCase().trim() === 'character');
    return isBeforeChar || hasCharKw;
}

function extractNPCInfo(entry) {
    if (entry.disable === true || entry.enabled === false) return null;
    const name = entry.comment || entry.name || (Array.isArray(entry.key) ? entry.key[0] : entry.key) || null;
    if (!name?.trim()) return null;
    return { name: name.trim(), description: (entry.content || '').trim() };
}

// ── Lorebook access ────────────────────────────────────────

/**
 * Get lorebook names for the current character.
 * Uses character's primary world + charLore extra books + chat-level book.
 */
function getCharacterLorebookNames() {
    const names = new Set();

    try {
        // Primary lorebook from character card
        if (this_chid !== undefined && this_chid !== null && characters?.[this_chid]) {
            const primary = characters[this_chid]?.data?.extensions?.world;
            if (primary) names.add(primary);

            // Extra books from world_info.charLore
            // charLore entries use the character's filename (name without path/ext)
            const charName = characters[this_chid]?.name;
            const charFilename = characters[this_chid]?.avatar?.replace(/\.[^.]+$/, '') || charName;
            const charLore = world_info?.charLore || [];

            for (const entry of charLore) {
                // Match by filename or by character name
                if (entry.name === charFilename || entry.name === charName) {
                    (entry.extraBooks || []).forEach(b => names.add(b));
                }
            }
        }
    } catch (e) {
        console.warn('[WildOffscreen] Error reading character lorebooks:', e.message);
    }

    // Chat-level lorebook
    if (chat_metadata?.world_info) names.add(chat_metadata.world_info);
    if (Array.isArray(chat_metadata?.carrot_chat_books)) {
        chat_metadata.carrot_chat_books.forEach(b => names.add(b));
    }

    return [...names].filter(Boolean);
}

async function fetchBookEntries(bookName) {
    if (!bookName) return [];
    try {
        const r = await fetch('/api/worldinfo/get', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: bookName }),
        });
        if (!r.ok) return [];
        const data = await r.json();
        return data?.entries ? Object.values(data.entries) : [];
    } catch (e) {
        console.warn('[WildOffscreen] fetchBookEntries failed:', e.message);
        return [];
    }
}

async function scanCharacterLorebooks() {
    const bookNames = getCharacterLorebookNames();
    console.log('[WildOffscreen] Books found:', bookNames);

    const npcs = [];
    for (const bookName of bookNames) {
        const entries = await fetchBookEntries(bookName);
        console.log(`[WildOffscreen] "${bookName}": ${entries.length} entries`);
        for (const entry of entries) {
            if (!isNPCEntry(entry)) continue;
            const info = extractNPCInfo(entry);
            if (info) { npcs.push(info); console.log(`[WildOffscreen]   ✓ ${info.name}`); }
        }
    }
    return { npcs, bookNames };
}

async function debugFirstEntries() {
    const bookNames = getCharacterLorebookNames();
    if (!bookNames.length) {
        return { error: 'No lorebooks found for current character. Attach a lorebook to this character card first.', bookNames: [] };
    }
    const firstBook = bookNames[0];

    // Raw API response for debugging
    let rawResponse = null;
    let rawKeys = [];
    let entries = [];
    try {
        const r = await fetch('/api/worldinfo/get', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: firstBook }),
        });
        const text = await r.text();
        rawResponse = text.slice(0, 300); // first 300 chars
        const data = JSON.parse(text);
        rawKeys = Object.keys(data || {});
        if (data?.entries) entries = Object.values(data.entries);
        else if (Array.isArray(data)) entries = data;
    } catch(e) {
        return { error: 'API fetch failed: ' + e.message, bookNames, activeBook: firstBook };
    }

    return {
        bookNames,
        activeBook: firstBook,
        totalEntries: entries.length,
        rawKeys,
        rawPreview: rawResponse,
        sample: entries.slice(0, 5).map(e => ({
            name: e.comment || e.name || e.key?.[0] || '—',
            position: e.position ?? e.extensions?.position ?? e.insertion_position ?? 'MISSING',
            keys: (e.key || e.keys || []).slice(0, 5),
            disabled: e.disable === true || e.enabled === false,
        })),
    };
}

// ── File loading ───────────────────────────────────────────

async function loadFromFile(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => { try { resolve(JSON.parse(reader.result)); } catch (e) { reject(new Error('Invalid JSON')); } };
        reader.onerror = () => reject(new Error('File read error'));
        reader.readAsText(file);
    });
}

function parseLorebookJSON(data) {
    let entries = [];
    if (data.entries && typeof data.entries === 'object') entries = Object.values(data.entries);
    else if (Array.isArray(data)) entries = data;
    else { for (const val of Object.values(data)) { if (val?.entries) { entries = Object.values(val.entries); break; } } }
    const found = [];
    for (const e of entries) {
        if (!isNPCEntry(e)) continue;
        const info = extractNPCInfo(e);
        if (info) found.push(info);
    }
    return found;
}

function registerNPCs(scanned) {
    const npcs = getNPCs();
    let added = 0;
    for (const { name, description } of scanned) {
        if (!npcs[name]) { npcs[name] = { name, description, enabled: true, events: [] }; added++; }
        else npcs[name].description = description;
    }
    return { npcs, added };
}

// ── Event generation ───────────────────────────────────────

function rollD20() { return Math.floor(Math.random() * 20) + 1; }
function getScale(roll) { return SCALE.find(s => roll >= s.min && roll <= s.max) || SCALE[0]; }
function getCategory() { return CATEGORIES[Math.floor(Math.random() * CATEGORIES.length)]; }

function buildHFPrompt(npc, scale, category, isPositive) {
    const history = npc.events.slice(-3).map(e => `- ${e.text}`).join('\n') || 'No previous events.';
    return `<s>[INST] You are a narrator generating offscreen story events for a roleplay character.

CHARACTER: ${npc.name}
DESCRIPTION: ${npc.description.slice(0, 600)}

RECENT EVENTS (do NOT repeat):
${history}

Generate ONE new offscreen event for ${npc.name}.
Scale: ${scale.label} | Category: ${category} | Impact: ${isPositive ? 'positive' : 'negative'}
Two sentences: what happened, then the consequence.
English only. No dialogue. No meta.

Output only the two sentences. [/INST]`;
}

async function callHF(prompt) {
    const s = getSettings();
    if (!s.hfToken) return null;
    try {
        const r = await fetch(`https://api-inference.huggingface.co/models/${s.hfModel}`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${s.hfToken}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ inputs: prompt, parameters: { max_new_tokens: 80, temperature: 0.85, do_sample: true, return_full_text: false } }),
        });
        if (!r.ok) { if (r.status === 503) console.warn('[WildOffscreen] HF model cold-starting'); return null; }
        const data = await r.json();
        return (Array.isArray(data) ? data[0]?.generated_text : data?.generated_text)?.trim() || null;
    } catch (e) { console.error('[WildOffscreen] HF error:', e); return null; }
}

async function generateEventForNPC(npc) {
    const roll = rollD20();
    const scale = getScale(roll);
    const category = getCategory();
    const isPositive = roll % 2 === 0;
    const text = await callHF(buildHFPrompt(npc, scale, category, isPositive));
    if (!text) return null;
    return { text, scale: scale.id, category, positive: isPositive, timestamp: Date.now() };
}

async function runGenerationCycle() {
    const npcs = getNPCs();
    const s = getSettings();
    const keys = Object.keys(npcs).filter(k => npcs[k].enabled);
    if (!keys.length) return;

    $('#wo_status').text('Generating offscreen events…').show();
    for (const key of keys) {
        const npc = npcs[key];
        const event = await generateEventForNPC(npc);
        if (!event) continue;
        npc.events.push(event);
        if (npc.events.length > s.maxEvents) npc.events = npc.events.slice(-s.maxEvents);
    }
    await saveNPCs(npcs);
    updateInjection();
    renderNPCList();
    $('#wo_status').text('').hide();
}

// ── Injection ──────────────────────────────────────────────

function buildInjectionText(npcs, injectMax) {
    const entries = Object.values(npcs).filter(n => n.enabled && n.events.length > 0);
    if (!entries.length) return '';

    let filtered = entries;
    if (injectMax > 0) {
        const ctx = SillyTavern.getContext();
        const recent = (ctx.chat ?? []).slice(-injectMax).map(m => m.mes?.toLowerCase() || '').join(' ');
        filtered = entries.filter(n => recent.includes(n.name.toLowerCase()));
    }
    if (!filtered.length) return '';

    const lines = filtered.map(npc => {
        const evLines = npc.events.slice(-3).map(e => `  [${e.positive ? '+' : '−'}${e.scale.toUpperCase()}] ${e.text}`).join('\n');
        return `• ${npc.name}:\n${evLines}`;
    });

    return '[OFF-SCREEN NPC UPDATES — use when character enters scene. Do NOT generate this block yourself.]\n'
        + lines.join('\n')
        + '\n[/OFF-SCREEN NPC UPDATES]';
}

function updateInjection() {
    const s = getSettings();
    const text = s.enabled ? buildInjectionText(getNPCs(), s.injectMaxMessages) : '';
    setExtensionPrompt(EXT, text, INJECTION_POSITION, 0, false, 0);
}

// ── Generation hook ────────────────────────────────────────

function onGenerationStarted() {
    const s = getSettings();
    if (!s.enabled || !s.hfToken) return;
    msgCounter++;
    if (msgCounter >= s.triggerEvery) { msgCounter = 0; runGenerationCycle(); }
    updateInjection();
}

// ── UI ─────────────────────────────────────────────────────

function renderNPCList() {
    const npcs = getNPCs();
    const container = $('#wo_npc_list');
    container.empty();

    const keys = Object.keys(npcs);
    if (!keys.length) {
        container.append('<div class="wo_empty">No NPCs registered. Click Scan or load a JSON.</div>');
        return;
    }

    for (const key of keys) {
        const npc = npcs[key];
        const count = npc.events.length;

        const card = $(`
        <div class="wo_npc_card ${npc.enabled ? '' : 'wo_npc_disabled'}" data-name="${key}">
            <div class="wo_npc_header">
                <span class="wo_npc_name">${npc.name}</span>
                <span class="wo_npc_count">${count} event${count !== 1 ? 's' : ''}</span>
                <div class="wo_npc_actions">
                    <button class="wo_btn_toggle menu_button">${npc.enabled ? '⏸' : '▶'}</button>
                    <button class="wo_btn_clear menu_button">🗑</button>
                    <button class="wo_btn_delete menu_button">✕</button>
                </div>
            </div>
            <div class="wo_npc_events" style="display:none;"></div>
        </div>`);

        const evContainer = card.find('.wo_npc_events');
        if (!npc.events.length) {
            evContainer.append('<div class="wo_no_events">No events yet.</div>');
        } else {
            for (const ev of [...npc.events].reverse()) {
                const color = ev.positive ? '#66bb6a' : '#ef5350';
                evContainer.append(`<div class="wo_event">
                    <span class="wo_event_meta" style="color:${color}">${ev.positive ? '▲' : '▼'} ${ev.scale.toUpperCase()} · ${ev.category}</span>
                    <div class="wo_event_text">${ev.text}</div>
                </div>`);
            }
        }

        card.find('.wo_npc_header').on('click', function (e) {
            if ($(e.target).closest('.wo_npc_actions').length) return;
            evContainer.slideToggle(150);
        });
        card.find('.wo_btn_toggle').on('click', async () => {
            const n = getNPCs(); n[key].enabled = !n[key].enabled;
            await saveNPCs(n); renderNPCList(); updateInjection();
        });
        card.find('.wo_btn_clear').on('click', async () => {
            if (!confirm(`Clear all events for ${key}?`)) return;
            const n = getNPCs(); n[key].events = [];
            await saveNPCs(n); renderNPCList(); updateInjection();
        });
        card.find('.wo_btn_delete').on('click', async () => {
            if (!confirm(`Remove ${key} from tracking?`)) return;
            const n = getNPCs(); delete n[key];
            await saveNPCs(n); renderNPCList(); updateInjection();
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
            <label class="checkbox_label"><input type="checkbox" id="wo_toggle" /><span>Enable</span></label>
            <div id="wo_status" class="wo_status" style="display:none;"></div>
            <div id="wo_npc_list" class="wo_npc_list"></div>

            <div class="wo_section_label">Lorebook</div>
            <div id="wo_book_info" class="wo_book_info">—</div>
            <div class="wo_actions">
                <input type="button" id="wo_scan" class="menu_button" value="🔍 Scan Character Lorebook" />
            </div>
            <div class="wo_actions">
                <label class="menu_button wo_file_btn" for="wo_file_input">📂 Load JSON</label>
                <input type="file" id="wo_file_input" accept=".json" style="display:none;" />
                <input type="button" id="wo_debug" class="menu_button" value="🔎 Debug" />
            </div>
            <div id="wo_debug_out" class="wo_debug_out" style="display:none;"></div>
            <div class="wo_actions" style="margin-top:6px;">
                <input type="button" id="wo_generate_now" class="menu_button" value="⚡ Generate Now" />
            </div>
            <hr>
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

    $('#wo_toggle').on('change', function () { s.enabled = this.checked; saveSettingsDebounced(); updateInjection(); });
    $('#wo_hf_token').on('input', function () { s.hfToken = this.value.trim(); saveSettingsDebounced(); });
    $('#wo_hf_model').on('input', function () { s.hfModel = this.value.trim(); saveSettingsDebounced(); });
    $('#wo_trigger_every').on('input', function () { s.triggerEvery = parseInt(this.value) || DEFAULTS.triggerEvery; saveSettingsDebounced(); });
    $('#wo_max_events').on('input', function () { s.maxEvents = parseInt(this.value) || DEFAULTS.maxEvents; saveSettingsDebounced(); });
    $('#wo_inject_max').on('input', function () { s.injectMaxMessages = parseInt(this.value) || 0; saveSettingsDebounced(); });

    $('#wo_scan').on('click', async () => {
        $('#wo_status').text('Scanning…').show();
        try {
            const { npcs: found, bookNames } = await scanCharacterLorebooks();
            if (!found.length) {
                const books = bookNames.length ? `Books checked: ${bookNames.join(', ')}` : 'No lorebook attached to this character.';
                toastr.warning(`No NPC entries found. ${books}\nEntries need position "before_char" or keyword "character".`);
                $('#wo_book_info').text(bookNames.length ? `📖 ${bookNames.join(', ')} — 0 NPCs` : 'No lorebook attached');
            } else {
                const { npcs, added } = registerNPCs(found);
                await saveNPCs(npcs);
                renderNPCList(); updateInjection();
                $('#wo_book_info').text(`📖 ${bookNames.join(', ')} — ${found.length} NPCs`);
                toastr.success(`Scan complete: ${found.length} NPCs found, ${added} newly added.`);
            }
        } catch (e) {
            toastr.error('Scan failed: ' + e.message);
            console.error('[WildOffscreen]', e);
        }
        $('#wo_status').hide();
    });

    $('#wo_file_input').on('change', async function () {
        const file = this.files?.[0]; if (!file) return;
        try {
            const data = await loadFromFile(file);
            const found = parseLorebookJSON(data);
            if (!found.length) { toastr.warning('No NPC entries found. Entries need position "before_char" or keyword "character".'); return; }
            const { npcs, added } = registerNPCs(found);
            await saveNPCs(npcs); renderNPCList(); updateInjection();
            $('#wo_book_info').text(`📂 ${file.name} — ${found.length} NPCs`);
            toastr.success(`Loaded: ${found.length} NPCs found, ${added} newly added.`);
        } catch (e) { toastr.error('Load failed: ' + e.message); }
        this.value = '';
    });

    $('#wo_debug').on('click', async () => {
        const out = $('#wo_debug_out');
        out.empty().show().append('<div class="wo_debug_title">Fetching…</div>');
        try {
            const info = await debugFirstEntries();
            out.empty();
            if (info.error) { out.append(`<div class="wo_debug_row" style="color:#ef5350;">❌ ${info.error}</div>`); return; }
            out.append(`<div class="wo_debug_title">Books found: <code>${info.bookNames.join(', ') || 'none'}</code></div>`);
            out.append(`<div class="wo_debug_title">Active book: <code>${info.activeBook}</code></div>`);
            out.append(`<div class="wo_debug_title">API response top-level keys: <code>${(info.rawKeys || []).join(', ') || '(empty)'}</code></div>`);
            out.append(`<div class="wo_debug_title">Entries found: <b>${info.totalEntries}</b></div>`);
            if (info.rawPreview) {
                out.append(`<div class="wo_debug_title">Raw response preview:</div>`);
                out.append(`<div class="wo_debug_entry"><code style="word-break:break-all;font-size:0.8em;">${info.rawPreview}</code></div>`);
            }
            if (info.sample?.length) {
                out.append(`<div class="wo_debug_title">First entries:</div>`);
                for (const e of info.sample) {
                    out.append(`<div class="wo_debug_entry">
                        <b>${e.name}</b>${e.disabled ? ' <span style="color:#ef5350">[disabled]</span>' : ''}<br>
                        position: <code>${JSON.stringify(e.position)}</code><br>
                        keys: <code>${e.keys.join(', ') || '(none)'}</code>
                    </div>`);
                }
            }
        } catch (err) { out.empty().append(`<div class="wo_debug_row" style="color:#ef5350;">Error: ${err.message}</div>`); }
    });

    $('#wo_generate_now').on('click', async () => {
        if (!getSettings().hfToken) { toastr.error('HuggingFace API token required.'); return; }
        await runGenerationCycle();
        toastr.success('Offscreen events generated.');
    });

    eventSource.on(event_types.GENERATION_STARTED, onGenerationStarted);
    eventSource.on(event_types.CHAT_CHANGED, () => {
        msgCounter = 0; renderNPCList(); updateInjection();
        $('#wo_debug_out').hide().empty();
        $('#wo_book_info').text('—');
    });

    updateInjection();
});
