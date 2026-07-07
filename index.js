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
    // API settings
    apiUrl: '',
    apiKey: '',
    apiModel: '',
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
 * Fetch available models from the configured endpoint
 */
async function fetchModels() {
    const s = getSettings();
    if (!s.apiUrl) return [];
    const url = s.apiUrl.replace(/\/+$/, '') + '/v1/models';
    try {
        const headers = { 'Content-Type': 'application/json' };
        if (s.apiKey) headers['Authorization'] = 'Bearer ' + s.apiKey;
        const r = await fetch(url, { method: 'GET', headers });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const data = await r.json();
        const models = data.data || data.models || [];
        return models.map(m => m.id || m.name || m).filter(Boolean);
    } catch (e) {
        console.warn('[WildOffscreen] fetchModels failed:', e.message);
        return [];
    }
}

/**
 * Call OpenAI-compatible API directly
 */
async function callAPI(messages) {
    const s = getSettings();
    if (!s.apiUrl) {
        console.warn('[WildOffscreen] No API URL configured');
        return null;
    }
    if (!s.apiModel) {
        console.warn('[WildOffscreen] No model selected');
        return null;
    }

    const url = s.apiUrl.replace(/\/+$/, '') + '/v1/chat/completions';
    const headers = { 'Content-Type': 'application/json' };
    if (s.apiKey) headers['Authorization'] = 'Bearer ' + s.apiKey;

    try {
        const r = await fetch(url, {
            method: 'POST',
            headers,
            body: JSON.stringify({
                model: s.apiModel,
                messages,
                max_tokens: 120,
                temperature: 0.85,
            }),
        });

        const text = await r.text();
        console.log('[WildOffscreen] API response:', r.status, text.slice(0, 200));

        if (!r.ok) {
            console.error('[WildOffscreen] API error:', r.status, text.slice(0, 200));
            return null;
        }

        const data = JSON.parse(text);
        return data.choices?.[0]?.message?.content?.trim() || null;
    } catch (e) {
        console.error('[WildOffscreen] API fetch error:', e.message);
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

            <div class="wo_section_label">API Settings</div>

            <label><small>API URL (OpenAI-compatible endpoint)</small></label>
            <input type="text" id="wo_api_url" class="text_pole" placeholder="http://localhost:5001" />

            <label><small>API Key (leave empty if not needed)</small></label>
            <input type="password" id="wo_api_key" class="text_pole" placeholder="sk-..." />

            <label><small>Model</small></label>
            <div class="wo_actions">
                <select id="wo_api_model" class="text_pole" style="flex:1;"></select>
                <input type="button" id="wo_fetch_models" class="menu_button" value="↻" title="Fetch models from endpoint" style="flex:none;width:36px;" />
            </div>
            <div id="wo_model_manual_wrap">
                <label><small>Or type model name manually</small></label>
                <input type="text" id="wo_api_model_manual" class="text_pole" placeholder="gemini-2.0-flash, gpt-4o-mini, etc." />
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
    $('#wo_api_url').val(s.apiUrl);
    $('#wo_api_key').val(s.apiKey);
    $('#wo_api_model_manual').val(s.apiModel);
    $('#wo_trigger_every').val(s.triggerEvery);
    $('#wo_max_events').val(s.maxEvents);
    $('#wo_inject_max').val(s.injectMaxMessages);

    // Populate model select if model already saved
    if (s.apiModel) {
        $('#wo_api_model').append(`<option value="${s.apiModel}" selected>${s.apiModel}</option>`);
    } else {
        $('#wo_api_model').append('<option value="">-- fetch models or type below --</option>');
    }

    renderNPCList();

    // ── Settings handlers ──

    $('#wo_toggle').on('change', function () { s.enabled = this.checked; saveSettingsDebounced(); updateInjection(); });

    $('#wo_api_url').on('input', function () { s.apiUrl = this.value.trim(); saveSettingsDebounced(); });
    $('#wo_api_key').on('input', function () { s.apiKey = this.value.trim(); saveSettingsDebounced(); });

    // Model select takes priority over manual input
    $('#wo_api_model').on('change', function () {
        if (this.value) {
            s.apiModel = this.value;
            $('#wo_api_model_manual').val(this.value);
            saveSettingsDebounced();
        }
    });

    // Manual input updates model and select
    $('#wo_api_model_manual').on('input', function () {
        s.apiModel = this.value.trim();
        saveSettingsDebounced();
    });

    // Fetch models button
    $('#wo_fetch_models').on('click', async () => {
        if (!s.apiUrl) { toastr.warning('Enter API URL first.'); return; }
        $('#wo_fetch_models').prop('disabled', true).text('…');
        const models = await fetchModels();
        $('#wo_fetch_models').prop('disabled', false).text('↻');
        if (!models.length) { toastr.warning('No models found. Check URL and key.'); return; }

        const select = $('#wo_api_model');
        select.empty();
        select.append('<option value="">-- select model --</option>');
        for (const m of models) {
            select.append(`<option value="${m}" ${m === s.apiModel ? 'selected' : ''}>${m}</option>`);
        }
        toastr.success(`Found ${models.length} models.`);
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
        if (!s.apiUrl || !s.apiModel) {
            toastr.error('Configure API URL and model in settings first.');
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
