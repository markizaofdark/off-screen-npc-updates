/**
 * Wild Offscreen — SillyTavern Extension
 * Tracks offscreen NPC lives: generates events via OpenAI-compatible API.
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
    getRequestHeaders,
} from '../../../../script.js';
import { world_info } from '../../../world-info.js';

// ── Constants ──────────────────────────────────────────────

const EXT = 'wild-offscreen';
const INJECTION_POSITION = 1;

const DEFAULTS = {
    enabled: true,
    triggerEvery: 5,
    maxEvents: 7,
    injectMaxMessages: 0,
    connectionProfile: '', // ST Connection Profile name
    maxTokens: 200,
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

// ── NPC storage (per-bot) ──────────────────────────────────

function getBotKey() {
    try {
        const ctx = SillyTavern.getContext();
        const char = ctx.characters?.[ctx.characterId];
        return char?.avatar?.replace(/\.[^.]+$/, '') || char?.name || 'unknown';
    } catch (e) { return 'unknown'; }
}

function getNPCs() {
    const s = getSettings();
    const key = getBotKey();
    if (!s.npcData) s.npcData = {};
    if (!s.npcData[key]) s.npcData[key] = {};
    return s.npcData[key];
}

async function saveNPCs(npcs) {
    const s = getSettings();
    const key = getBotKey();
    if (!s.npcData) s.npcData = {};
    s.npcData[key] = npcs;
    saveSettingsDebounced();
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

function getCharacterLorebookNames() {
    const names = new Set();
    try {
        if (this_chid !== undefined && this_chid !== null && characters?.[this_chid]) {
            const primary = characters[this_chid]?.data?.extensions?.world;
            if (primary) names.add(primary);
            const charName = characters[this_chid]?.name;
            const charFilename = characters[this_chid]?.avatar?.replace(/\.[^.]+$/, '') || charName;
            const charLore = world_info?.charLore || [];
            for (const entry of charLore) {
                if (entry.name === charFilename || entry.name === charName) {
                    (entry.extraBooks || []).forEach(b => names.add(b));
                }
            }
        }
    } catch (e) { console.warn('[WildOffscreen] Error reading character lorebooks:', e.message); }
    if (chat_metadata?.world_info) names.add(chat_metadata.world_info);
    if (Array.isArray(chat_metadata?.carrot_chat_books)) {
        chat_metadata.carrot_chat_books.forEach(b => names.add(b));
    }
    return [...names].filter(Boolean);
}

async function fetchBookEntries(bookName) {
    if (!bookName) return [];
    const baseHeaders = getRequestHeaders();
    const endpoints = [
        { url: '/api/worldinfo/get', method: 'POST', body: { name: bookName } },
        { url: '/api/worldinfo/getone', method: 'POST', body: { name: bookName } },
        { url: `/api/worldinfo/${encodeURIComponent(bookName)}`, method: 'GET', body: null },
    ];
    for (const ep of endpoints) {
        try {
            const opts = { method: ep.method, headers: { ...baseHeaders, 'Content-Type': 'application/json' } };
            if (ep.body) opts.body = JSON.stringify(ep.body);
            const r = await fetch(ep.url, opts);
            if (!r.ok) continue;
            const text = await r.text();
            if (!text || text.trim().startsWith('<')) continue;
            const data = JSON.parse(text);
            if (data?.entries) return Object.values(data.entries);
            if (Array.isArray(data)) return data;
        } catch (e) { console.warn(`[WildOffscreen] ${ep.url} failed:`, e.message); }
    }
    return [];
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
    if (data && data.entries && typeof data.entries === 'object' && !Array.isArray(data.entries)) {
        entries = Object.values(data.entries);
    } else if (data && Array.isArray(data.entries)) {
        entries = data.entries;
    } else if (Array.isArray(data)) {
        entries = data;
    } else if (data && typeof data === 'object') {
        for (const val of Object.values(data)) {
            if (val && val.entries) { entries = Array.isArray(val.entries) ? val.entries : Object.values(val.entries); break; }
        }
    }
    console.log('[WildOffscreen] parseLorebookJSON: found', entries.length, 'raw entries');
    const found = [];
    for (const e of entries) {
        if (!e || typeof e !== 'object') continue;
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

// ── API call ───────────────────────────────────────────────

/**
 * Get ST connection profiles list
 */
function getConnectionProfiles() {
    const ctx = SillyTavern.getContext();
    return ctx.extensionSettings?.connectionManager?.profiles || [];
}

/**
 * Get currently selected ST connection profile name
 */
function getDefaultProfileName() {
    const ctx = SillyTavern.getContext();
    const cm = ctx.extensionSettings?.connectionManager;
    if (!cm) return '';
    return cm.profiles?.find(p => p.id === cm.selectedProfile)?.name
        || cm.profiles?.[0]?.name
        || '';
}

/**
 * Call ST's own backend using the selected Connection Profile.
 * Mirrors ExtBlocks ApiService.generateBlocks() pattern exactly.
 */
async function callAPI(messages) {
    const s = getSettings();
    const ctx = SillyTavern.getContext();
    const profiles = getConnectionProfiles();

    if (!profiles.length) {
        console.warn('[WildOffscreen] No connection profiles found in ST');
        return null;
    }

    // Pick the selected profile
    const profileName = s.connectionProfile || getDefaultProfileName();
    const profile = profiles.find(p => p.name === profileName) || profiles[0];

    if (!profile) {
        console.warn('[WildOffscreen] No connection profile available');
        return null;
    }

    // Map ST API names (same as ExtBlocks does)
    const apiName = profile.api || 'openai';
    const cc_source = apiName === 'google' ? 'makersuite' : apiName;

    const generate_data = {
        messages,
        model: profile.model || '',
        temperature: 0.85,
        max_tokens: 120,
        stream: false,
        chat_completion_source: cc_source,
    };

    // Handle secret-id for some providers
    if (profile['secret-id']) {
        generate_data['secret_id'] = profile['secret-id'];
    }

    // Custom URL for custom API type
    if (cc_source === 'custom' && profile['api-url']) {
        generate_data['custom_url'] = profile['api-url'].trim().replace(/\/+$/, '');
    }

    // Vertex AI region
    if (cc_source === 'vertexai' && profile['api-url']) {
        generate_data['vertexai_region'] = profile['api-url'];
    }

    // Use sysprompt for Claude and Gemini
    if (cc_source === 'makersuite' || cc_source === 'claude') {
        generate_data['use_sysprompt'] = true;
    }

    console.log('[WildOffscreen] Calling ST backend, profile:', profile.name, 'source:', cc_source, 'model:', profile.model);

    try {
        const r = await fetch('/api/backends/chat-completions/generate', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify(generate_data),
        });

        const text = await r.text();
        console.log('[WildOffscreen] ST backend response:', r.status, text.slice(0, 300));

        if (!r.ok) {
            console.error('[WildOffscreen] ST backend error:', r.status, text.slice(0, 300));
            return null;
        }

        const data = JSON.parse(text);

        // Extract text based on source format (mirrors ExtBlocks extractMessageFromData)
        if (cc_source === 'claude') {
            return data?.content?.[0]?.text?.trim() || null;
        } else {
            return data?.choices?.[0]?.message?.content?.trim() || null;
        }
    } catch (e) {
        console.error('[WildOffscreen] ST backend fetch error:', e.message);
        return null;
    }
}

// ── Event generation ───────────────────────────────────────

function rollD20() { return Math.floor(Math.random() * 20) + 1; }
function getScale(roll) { return SCALE.find(s => roll >= s.min && roll <= s.max) || SCALE[0]; }
function getCategory() { return CATEGORIES[Math.floor(Math.random() * CATEGORIES.length)]; }

function buildMessages(npc, scale, category, isPositive) {
    const history = npc.events.slice(-3).map(e => '- ' + e.text).join('\n') || 'No previous events.';
    return [
        {
            role: 'system',
            content: 'You are a narrator generating brief offscreen story events for roleplay characters. Output ONLY the event text — no labels, no meta, no commentary.',
        },
        {
            role: 'user',
            content: 'Generate ONE offscreen event for this character.\n\n'
                + 'CHARACTER: ' + npc.name + '\n'
                + 'DESCRIPTION: ' + npc.description.slice(0, 500) + '\n\n'
                + 'RECENT EVENTS (do NOT repeat):\n' + history + '\n\n'
                + 'Requirements:\n'
                + '- Scale: ' + scale.label + '\n'
                + '- Category: ' + category + '\n'
                + '- Impact: ' + (isPositive ? 'positive' : 'negative') + ' for ' + npc.name + '\n'
                + '- Exactly two sentences: what happened, then the immediate consequence\n'
                + '- English only. No dialogue. No meta-commentary.\n\n'
                + 'Output only the two sentences:',
        },
    ];
}

async function generateEventForNPC(npc) {
    const roll = rollD20();
    const scale = getScale(roll);
    const category = getCategory();
    const isPositive = roll % 2 === 0;
    const messages = buildMessages(npc, scale, category, isPositive);
    let text = await callAPI(messages);
    if (!text) return null;
    text = text.replace(/^(event|result|output|here|two sentences)[:\s]*/i, '').trim();
    return { text, scale: scale.id, category, positive: isPositive, timestamp: Date.now() };
}

async function runGenerationCycle() {
    const npcs = getNPCs();
    const s = getSettings();
    const keys = Object.keys(npcs).filter(k => npcs[k].enabled);
    if (!keys.length) return;

    $('#wo_status').text('Generating offscreen events…').show();
    let generated = 0, failed = 0;

    for (const key of keys) {
        const npc = npcs[key];
        const event = await generateEventForNPC(npc);
        if (!event) { failed++; continue; }
        npc.events.push(event);
        if (npc.events.length > s.maxEvents) npc.events = npc.events.slice(-s.maxEvents);
        generated++;
    }

    await saveNPCs(npcs);
    updateInjection();
    renderNPCList();
    $('#wo_status').text('').hide();

    if (generated === 0 && failed > 0) {
        toastr.error('Generation failed. Check API URL, key and model in settings.');
    } else if (failed > 0) {
        toastr.warning(`Generated ${generated} events, ${failed} failed.`);
    } else {
        toastr.success(`Generated ${generated} offscreen events.`);
    }
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
        const evLines = npc.events.slice(-3).map(e => '  [' + (e.positive ? '+' : '-') + e.scale.toUpperCase() + '] ' + e.text).join('\n');
        return '• ' + npc.name + ':\n' + evLines;
    });
    return '[OFF-SCREEN NPC UPDATES — use when character enters scene. Do NOT generate this block yourself.]\n'
        + lines.join('\n') + '\n[/OFF-SCREEN NPC UPDATES]';
}

function updateInjection() {
    const s = getSettings();
    const text = s.enabled ? buildInjectionText(getNPCs(), s.injectMaxMessages) : '';
    setExtensionPrompt(EXT, text, INJECTION_POSITION, 0, false, 0);
}

// ── Generation hook ────────────────────────────────────────

function onGenerationStarted() {
    const s = getSettings();
    if (!s.enabled) return;
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
        container.append('<div class="wo_empty">No NPCs registered. Scan or load a lorebook.</div>');
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
                <input type="button" id="wo_scan" class="menu_button" value="🔍 Scan Lorebook" />
                <label class="menu_button wo_file_btn" for="wo_file_input">📂 Load JSON</label>
                <input type="file" id="wo_file_input" accept=".json" style="display:none;" />
            </div>
            <div class="wo_actions" style="margin-top:4px;">
                <input type="button" id="wo_generate_now" class="menu_button" value="⚡ Generate Now" />
            </div>

            <hr>

            <div class="wo_section_label">Connection Profile</div>
            <label><small>Uses your SillyTavern Connection Profiles</small></label>
            <div class="wo_actions">
                <select id="wo_profile_select" class="text_pole" style="flex:1;"></select>
                <input type="button" id="wo_profile_refresh" class="menu_button" value="↻" title="Refresh profiles list" style="flex:none;width:36px;" />
            </div>

            <hr>

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
    $('#wo_trigger_every').val(s.triggerEvery);
    $('#wo_max_events').val(s.maxEvents);
    $('#wo_inject_max').val(s.injectMaxMessages);

    // Populate profile selector
    function refreshProfileSelect() {
        const profiles = getConnectionProfiles();
        const select = $('#wo_profile_select');
        select.empty();
        if (!profiles.length) {
            select.append('<option value="">-- no profiles found --</option>');
            return;
        }
        const currentName = s.connectionProfile || getDefaultProfileName();
        for (const p of profiles) {
            select.append(`<option value="${p.name}" ${p.name === currentName ? 'selected' : ''}>${p.name} (${p.api || '?'} / ${p.model || 'no model'})</option>`);
        }
        // Save current selection
        if (!s.connectionProfile) {
            s.connectionProfile = currentName;
            saveSettingsDebounced();
        }
    }

    refreshProfileSelect();
    renderNPCList();

    // ── Settings handlers ──

    $('#wo_toggle').on('change', function () { s.enabled = this.checked; saveSettingsDebounced(); updateInjection(); });

    $('#wo_profile_select').on('change', function () {
        s.connectionProfile = this.value;
        saveSettingsDebounced();
    });

    $('#wo_profile_refresh').on('click', () => {
        refreshProfileSelect();
        toastr.info('Profiles refreshed.');
    });

    $('#wo_trigger_every').on('input', function () { s.triggerEvery = parseInt(this.value) || DEFAULTS.triggerEvery; saveSettingsDebounced(); });
    $('#wo_max_events').on('input', function () { s.maxEvents = parseInt(this.value) || DEFAULTS.maxEvents; saveSettingsDebounced(); });
    $('#wo_inject_max').on('input', function () { s.injectMaxMessages = parseInt(this.value) || 0; saveSettingsDebounced(); });

    // ── Scan ──
    $('#wo_scan').on('click', async () => {
        $('#wo_status').text('Scanning…').show();
        try {
            const { npcs: found, bookNames } = await scanCharacterLorebooks();
            if (!found.length) {
                const books = bookNames.length ? `Books checked: ${bookNames.join(', ')}` : 'No lorebook attached to this character.';
                toastr.warning(`No NPC entries found. ${books}`);
                $('#wo_book_info').text(bookNames.length ? `📖 ${bookNames.join(', ')} — 0 NPCs` : 'No lorebook attached');
            } else {
                const { npcs, added } = registerNPCs(found);
                await saveNPCs(npcs); renderNPCList(); updateInjection();
                $('#wo_book_info').text(`📖 ${bookNames.join(', ')} — ${found.length} NPCs`);
                toastr.success(`Scan complete: ${found.length} NPCs found, ${added} newly added.`);
            }
        } catch (e) { toastr.error('Scan failed: ' + e.message); }
        $('#wo_status').hide();
    });

    // ── Load JSON ──
    $('#wo_file_input').on('change', async function () {
        const file = this.files?.[0]; if (!file) return;
        try {
            const data = await loadFromFile(file);
            const found = parseLorebookJSON(data);
            if (!found.length) { toastr.warning('No NPC entries found.'); return; }
            const { npcs, added } = registerNPCs(found);
            await saveNPCs(npcs); renderNPCList(); updateInjection();
            $('#wo_book_info').text(`📂 ${file.name} — ${found.length} NPCs`);
            toastr.success(`Loaded: ${found.length} NPCs, ${added} newly added.`);
        } catch (e) { toastr.error('Load failed: ' + e.message); }
        this.value = '';
    });

    // ── Generate now ──
    $('#wo_generate_now').on('click', async () => {
        if (!getConnectionProfiles().length) {
            toastr.error('No ST Connection Profiles found. Create one in SillyTavern settings first.');
            return;
        }
        await runGenerationCycle();
    });

    // ── Hooks ──
    eventSource.on(event_types.GENERATION_STARTED, onGenerationStarted);
    eventSource.on(event_types.CHAT_CHANGED, () => {
        msgCounter = 0;
        setTimeout(() => {
            renderNPCList();
            updateInjection();
            $('#wo_book_info').text('Bot: ' + getBotKey());
        }, 200);
    });

    updateInjection();
});
