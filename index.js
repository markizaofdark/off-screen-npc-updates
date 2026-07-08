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
    connectionProfile: '',
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

function extractNPCInfo(entry, bookName) {
    if (entry.disable === true || entry.enabled === false) return null;
    const name = entry.comment || entry.name || (Array.isArray(entry.key) ? entry.key[0] : entry.key) || null;
    if (!name?.trim()) return null;
    const keys = (Array.isArray(entry.key) ? entry.key : [entry.key || '']).filter(k => k && k !== 'character');
    return {
        name: name.trim(),
        description: (entry.content || '').trim(),
        searchKeys: keys,
        lorebookName: bookName || '',
        entryUid: entry.uid ?? entry.id ?? null,
    };
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
            const info = extractNPCInfo(entry, bookName);
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
        const info = extractNPCInfo(e, '');
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

function getConnectionProfiles() {
    const ctx = SillyTavern.getContext();
    return ctx.extensionSettings?.connectionManager?.profiles || [];
}

function getDefaultProfileName() {
    const ctx = SillyTavern.getContext();
    const cm = ctx.extensionSettings?.connectionManager;
    if (!cm) return '';
    return cm.profiles?.find(p => p.id === cm.selectedProfile)?.name
        || cm.profiles?.[0]?.name
        || '';
}

async function callAPI(messages) {
    const s = getSettings();
    const profiles = getConnectionProfiles();

    if (!profiles.length) {
        console.warn('[WildOffscreen] No connection profiles found in ST');
        return null;
    }

    const profileName = s.connectionProfile || getDefaultProfileName();
    const profile = profiles.find(p => p.name === profileName) || profiles[0];

    if (!profile) {
        console.warn('[WildOffscreen] No connection profile available');
        return null;
    }

    const apiName = profile.api || 'openai';
    const cc_source = apiName === 'google' ? 'makersuite' : apiName;

    const generate_data = {
        messages,
        model: profile.model || '',
        temperature: 0.85,
        max_tokens: 200,
        stream: false,
        chat_completion_source: cc_source,
    };

    if (profile['secret-id']) generate_data['secret_id'] = profile['secret-id'];
    if (cc_source === 'custom' && profile['api-url']) {
        generate_data['custom_url'] = profile['api-url'].trim().replace(/\/+$/, '');
    }
    if (cc_source === 'vertexai' && profile['api-url']) {
        generate_data['vertexai_region'] = profile['api-url'];
    }
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

function getMainCharInfo() {
    try {
        const ctx = SillyTavern.getContext();
        const char = ctx.characters?.[ctx.characterId];
        if (!char) return '';
        const name = char.name || '';
        const desc = [char.description, char.personality, char.scenario]
            .filter(Boolean).join('\n').trim().slice(0, 2000);
        return name ? 'MAIN CHARACTER: ' + name + '\n' + desc : '';
    } catch (e) { return ''; }
}

// ── Search helpers (used for context lookup, NOT for regex gen) ────────────

function parseRegexKey(key) {
    const m = key.match(/^\/(.+)\/([gimsuy]*)$/);
    if (!m) return null;
    try { return new RegExp(m[1], m[2] || 'i'); } catch(e) { return null; }
}

function buildStemRegex(word) {
    word = word.trim();
    if (!word || word.length < 2) return null;
    const isCyrillic = /[а-яёА-ЯЁ]/.test(word);
    const stem = word.length > 5 ? word.slice(0, -2) : word.length > 3 ? word.slice(0, -1) : word;
    const charClass = isCyrillic ? 'а-яёА-ЯЁ' : 'a-zA-Z';
    try {
        return new RegExp(
            '(?:^|[^' + charClass + '])' + stem + '[' + charClass + ']*(?=[^' + charClass + ']|$)',
            'i'
        );
    } catch(e) { return null; }
}

function buildSearchRegexes(npc) {
    const results = [];
    const seen = new Set();

    const addRegex = (term, regex) => {
        const key = term.toLowerCase();
        if (seen.has(key) || !regex) return;
        seen.add(key);
        results.push({ term, regex });
    };

    const keys = npc.searchKeys || [];

    for (const k of keys) {
        const rx = parseRegexKey(k);
        if (rx) addRegex(k, rx);
    }

    for (const k of keys) {
        if (!parseRegexKey(k) && k && k.length > 1) {
            addRegex(k, buildStemRegex(k));
        }
    }

    const nameParts = npc.name.trim().split(/\s+/).filter(p => p.length > 2);
    for (const p of nameParts) {
        addRegex(p, buildStemRegex(p));
    }

    return results;
}

// ── Chat context ───────────────────────────────────────────

function getChatContextForNPC(npc, maxMessages = 8, maxCharsPerMsg = 2000) {
    const npcObj = typeof npc === 'string' ? { name: npc, searchKeys: [] } : npc;
    const npcName = npcObj.name;

    const debugInfo = {
        npc: npcName,
        totalMessages: 0,
        nonSystemMessages: 0,
        searchTerms: [],
        searchRegexes: [],
        mentionCount: 0,
        usedMessages: 0,
        fallback: false,
        error: null,
    };

    try {
        const ctx = SillyTavern.getContext();
        const chat = ctx.chat || [];
        debugInfo.totalMessages = chat.length;

        const nonSystem = chat.filter(m => !m.is_system && m.mes);
        debugInfo.nonSystemMessages = nonSystem.length;

        const regexPairs = buildSearchRegexes(npcObj);
        debugInfo.searchTerms = regexPairs.map(r => r.term);
        debugInfo.searchRegexes = regexPairs.map(r => r.regex.toString());

        const cleanMsg = (m) => m.mes.replace(/<[^>]+>/g, '').trim();

        const mentions = nonSystem.filter(m => {
            const text = cleanMsg(m);
            return regexPairs.some(r => r.regex.test(text));
        });
        debugInfo.mentionCount = mentions.length;

        let selected;
        if (mentions.length > 0) {
            selected = mentions.slice(-maxMessages);
            debugInfo.usedMessages = selected.length;
            debugInfo.fallback = false;
        } else {
            selected = nonSystem.slice(-5);
            debugInfo.usedMessages = selected.length;
            debugInfo.fallback = true;
        }

        const text = selected
            .map(m => (m.is_user ? '[User]' : '[Bot]') + ' ' + cleanMsg(m).slice(0, maxCharsPerMsg).trim())
            .join('\n');

        return { text, debug: debugInfo };
    } catch (e) {
        debugInfo.error = e.message;
        console.warn('[WildOffscreen] getChatContextForNPC error:', e.message);
        return { text: '', debug: debugInfo };
    }
}

// ── Prompt building ────────────────────────────────────────

const SCALE_DESC = {
    'minor':   'small but meaningful change',
    'notable': 'significant event, changes something',
    'major':   'major event, hard to ignore',
};

const CATEGORY_DESC = {
    'Personal':     'personal development, habit, or inner state',
    'Relationship': 'interaction or shift with another person',
    'Status':       'change in social, material, or physical status',
    'Discovery':    'finding out or stumbling upon something',
    'Social':       'social situation or public event',
};

function rollEventParams() {
    const roll = rollD20();
    const scale = getScale(roll);
    const category = getCategory();
    const isPositive = roll % 2 === 0;
    return { roll, scale, category, isPositive };
}

function buildBatchMessages(npcList, mainCharInfo, sharedChatContext) {
    const npcBlocks = npcList.map((item, i) => {
        const { npc, params } = item;
        const history = npc.events.slice(-3).map(e => '- ' + e.text).join('\n') || 'None yet.';
        const impact = params.isPositive ? 'POSITIVE' : 'NEGATIVE';
        const scaleDesc = SCALE_DESC[params.scale.id] || params.scale.label;
        const catDesc = CATEGORY_DESC[params.category] || params.category;
        const npcContextResult = getChatContextForNPC(npc);
        const npcContext = npcContextResult.text;
        const lastLoc = npc.lastLocation ? 'Last known location: ' + npc.lastLocation : '';

        return '--- NPC ' + (i + 1) + ': ' + npc.name + ' ---\n'
            + 'DESCRIPTION: ' + npc.description.slice(0, 3000) + '\n'
            + (lastLoc ? lastLoc + '\n' : '')
            + 'RECENT OFFSCREEN EVENTS (do not repeat): ' + history + '\n'
            + 'MENTIONS IN STORY (for context): ' + (npcContext || 'none') + '\n'
            + 'EVENT REQUIREMENTS: ' + impact + ' | ' + scaleDesc + ' | ' + catDesc;
    }).join('\n\n');

    const userContent = (mainCharInfo ? mainCharInfo + '\n\n' : '')
        + 'CURRENT STORY CONTEXT:\n' + (sharedChatContext || 'none') + '\n\n'
        + npcBlocks + '\n\n'
        + 'For each NPC above, write exactly ONE sentence (15-25 words) describing what they just did or experienced INDEPENDENTLY, while away from the main scene.\n'
        + 'These NPCs are NOT in the current scene. Do not place them near each other or near the main character unless the story context explicitly shows them together.\n'
        + 'Requirements for each sentence:\n'
        + '- Match the event requirements (impact/scale/type) listed for that NPC\n'
        + '- Be specific to their personality and situation\n'
        + '- Do NOT start with their name\n'
        + '- No dialogue, no poetic language\n\n'
        + 'Also determine a short location name (1-5 words) for where this NPC currently is.\n\n'
        + 'Respond with ONLY this format, one line per NPC:\n'
        + npcList.map((item, i) => 'NPC' + (i + 1) + ': [location] | [event sentence]').join('\n') + '\n'
        + 'Example: NPC1: the marketplace | She haggled bitterly over a bag of spices with an impatient merchant.';

    console.log('[WildOffscreen] Batch prompt for', npcList.length, 'NPCs, userContent length:', userContent.length);

    return [
        {
            role: 'system',
            content: 'You write brief offscreen event summaries for story characters. '
                + 'Dry, specific, one sentence per character. No names at sentence start. No dialogue.',
        },
        { role: 'user', content: userContent },
    ];
}

/**
 * Parse batch response.
 * Expected format per line: NPC1: [location] | [event sentence]
 * Returns array of { location, text } or null per NPC.
 */
function parseBatchResponse(text, count) {
    const results = [];
    for (let i = 1; i <= count; i++) {
        const regex = new RegExp('NPC' + i + '[:\\s]+(.+?)(?=NPC' + (i + 1) + '[:\\s]|$)', 'si');
        const match = text.match(regex);
        if (!match) { results.push(null); continue; }

        let raw = match[1].trim().replace(/^["']|["']$/g, '').trim();

        let location = 'unknown';
        let sentence = raw;

        const pipeIdx = raw.indexOf('|');
        if (pipeIdx > 0 && pipeIdx < 60) {
            const maybeLocation = raw.slice(0, pipeIdx).trim();
            const maybeEvent = raw.slice(pipeIdx + 1).trim();
            if (maybeLocation.length > 0 && maybeLocation.length < 50 && !maybeLocation.includes('.') && maybeEvent.length > 10) {
                location = maybeLocation;
                sentence = maybeEvent;
            }
        }

        // Take only first sentence
        const first = sentence.match(/^[^.!?]+[.!?]/);
        if (first && first[0].length > 10) sentence = first[0].trim();

        results.push(sentence.length >= 10 ? { location, text: sentence } : null);
    }
    return results;
}

/**
 * Generate events for ALL enabled NPCs in a single API call.
 */
async function generateEventsForAllNPCs(npcs) {
    const keys = Object.keys(npcs).filter(k => npcs[k].enabled);
    if (!keys.length) return;

    const mainCharInfo = getMainCharInfo();
    const sharedChat = (() => {
        try {
            const ctx = SillyTavern.getContext();
            return (ctx.chat || [])
                .filter(m => !m.is_system && m.mes)
                .slice(-5)
                .map(m => (m.is_user ? '[User]' : '[Bot]') + ' ' + m.mes.replace(/<[^>]+>/g, '').trim().slice(0, 500))
                .join('\n');
        } catch(e) { return ''; }
    })();

    const npcList = keys.map(k => ({ npc: npcs[k], key: k, params: rollEventParams() }));

    const messages = buildBatchMessages(npcList, mainCharInfo, sharedChat);
    const rawText = await callAPI(messages);
    console.log('[WildOffscreen] Batch response:', rawText?.slice(0, 500));

    if (!rawText) return;

    const parsed = parseBatchResponse(rawText, npcList.length);
    const s = getSettings();

    for (let i = 0; i < npcList.length; i++) {
        const { npc, key, params } = npcList[i];
        const result = parsed[i]; // { location, text } or null

        if (!result) {
            console.warn('[WildOffscreen] No result for', npc.name, '- skipping');
            continue;
        }

        const event = {
            text: result.text,         // ← строка, не объект
            location: result.location,
            scale: params.scale.id,
            category: params.category,
            positive: params.isPositive,
            timestamp: Date.now(),
        };

        npc.events.push(event);
        if (npc.events.length > s.maxEvents) npc.events = npc.events.slice(-s.maxEvents);

        // Обновляем последнюю известную локацию персонажа
        if (result.location && result.location !== 'unknown') {
            npc.lastLocation = result.location;
        }

        console.log('[WildOffscreen] Event for', npc.name, '@', result.location, ':', result.text);
    }
}

async function runGenerationCycle() {
    const npcs = getNPCs();
    const keys = Object.keys(npcs).filter(k => npcs[k].enabled);
    if (!keys.length) return;

    $('#wo_status').text('Generating offscreen events…').show();

    const beforeCounts = Object.fromEntries(keys.map(k => [k, npcs[k].events.length]));

    await generateEventsForAllNPCs(npcs);
    const firstGenerated = keys.filter(k => npcs[k].events.length > beforeCounts[k]).length;
    if (firstGenerated === 0) {
        console.log('[WildOffscreen] First attempt got 0 results, retrying...');
        await new Promise(r => setTimeout(r, 1500));
        await generateEventsForAllNPCs(npcs);
    }

    await saveNPCs(npcs);
    updateInjection();
    renderNPCList();
    $('#wo_status').text('').hide();

    const generated = keys.filter(k => npcs[k].events.length > beforeCounts[k]).length;
    const failed = keys.length - generated;

    if (generated === 0) {
        toastr.error('Generation failed. Check your connection profile and model.');
    } else if (failed > 0) {
        toastr.warning(`Generated events for ${generated}/${keys.length} NPCs.`);
    } else {
        toastr.success(`Generated events for all ${generated} NPCs in one request.`);
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
        const loc = npc.lastLocation || 'unknown';
        const evLines = npc.events.slice(-3).map(e => {
            const evLoc = e.location && e.location !== loc ? ' @' + e.location : '';
            return '  [' + (e.positive ? '+' : '-') + e.scale.toUpperCase() + evLoc + '] ' + e.text;
        }).join('\n');
        return '• ' + npc.name + ' (currently: ' + loc + '):\n' + evLines;
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
                <span class="wo_npc_count">${npc.lastLocation ? '📍 ' : ''}${count} event${count !== 1 ? 's' : ''}</span>
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
            if (npc.lastLocation) {
                evContainer.append('<div class="wo_npc_location">📍 ' + npc.lastLocation + '</div>');
            }
            for (const ev of [...npc.events].reverse()) {
                const color = ev.positive ? '#66bb6a' : '#ef5350';
                const locTag = ev.location && ev.location !== 'unknown'
                    ? '<span class="wo_event_loc">📍 ' + ev.location + '</span>'
                    : '';
                // ev.text всегда строка после фикса
                const evText = typeof ev.text === 'string' ? ev.text : String(ev.text?.text || ev.text || '');
                evContainer.append('<div class="wo_event">'
                    + '<span class="wo_event_meta" style="color:' + color + '">'
                    + (ev.positive ? '▲' : '▼') + ' ' + ev.scale.toUpperCase() + ' · ' + ev.category
                    + '</span>'
                    + locTag
                    + '<div class="wo_event_text">' + evText + '</div>'
                    + '</div>');
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
                <input type="button" id="wo_debug_btn" class="menu_button" value="🔎 Debug" />
            </div>
            <div id="wo_debug_panel" class="wo_debug_out" style="display:none;"></div>

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
        if (!s.connectionProfile) {
            s.connectionProfile = currentName;
            saveSettingsDebounced();
        }
    }

    refreshProfileSelect();
    renderNPCList();

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

    $('#wo_generate_now').on('click', async () => {
        if (!getConnectionProfiles().length) {
            toastr.error('No ST Connection Profiles found. Create one in SillyTavern settings first.');
            return;
        }
        await runGenerationCycle();
    });

    $('#wo_debug_btn').on('click', () => {
        const panel = $('#wo_debug_panel');
        panel.empty().show();

        const npcs = getNPCs();
        const keys = Object.keys(npcs);
        const s = getSettings();
        const mainInfo = getMainCharInfo();

        panel.append('<div class="wo_debug_title">🔎 Wild Offscreen Debug</div>');

        panel.append('<div class="wo_debug_title" style="margin-top:8px;">Settings</div>');
        panel.append('<div class="wo_debug_entry">'
            + 'Profile: <code>' + (s.connectionProfile || 'default') + '</code><br>'
            + 'Trigger every: <code>' + s.triggerEvery + ' msgs</code><br>'
            + 'Max events/NPC: <code>' + s.maxEvents + '</code>'
            + '</div>');

        panel.append('<div class="wo_debug_title" style="margin-top:8px;">Main character (bot)</div>');
        panel.append('<div class="wo_debug_entry">'
            + (mainInfo ? '<code>' + mainInfo.slice(0, 200) + (mainInfo.length > 200 ? '…' : '') + '</code>' : '<span style="color:#ef5350">Not found</span>')
            + '</div>');

        try {
            const ctx = SillyTavern.getContext();
            const chat = ctx.chat || [];
            const nonSystem = chat.filter(m => !m.is_system && m.mes);
            panel.append('<div class="wo_debug_title" style="margin-top:8px;">Chat</div>');
            panel.append('<div class="wo_debug_entry">'
                + 'Total messages: <code>' + chat.length + '</code><br>'
                + 'Non-system: <code>' + nonSystem.length + '</code>'
                + '</div>');
        } catch(e) {
            panel.append('<div class="wo_debug_entry" style="color:#ef5350">Chat error: ' + e.message + '</div>');
        }

        if (!keys.length) {
            panel.append('<div class="wo_debug_entry" style="color:#ef5350">No NPCs registered.</div>');
        } else {
            panel.append('<div class="wo_debug_title" style="margin-top:8px;">NPC context search</div>');
            for (const key of keys) {
                const npc = npcs[key];
                const result = getChatContextForNPC(npc);
                const d = result.debug;
                const statusColor = d.mentionCount > 0 ? '#66bb6a' : '#ffa726';
                panel.append('<div class="wo_debug_entry">'
                    + '<b>' + npc.name + '</b>'
                    + (npc.enabled ? '' : ' <span style="color:#ef5350">[disabled]</span>') + '<br>'
                    + 'Search terms: <code>' + d.searchTerms.join(', ') + '</code><br>'
                    + 'Regexes: <code>' + d.searchRegexes.join(' | ') + '</code><br>'
                    + 'Chat scanned: <code>' + d.nonSystemMessages + ' msgs</code><br>'
                    + 'Mentions found: <code style="color:' + statusColor + '">' + d.mentionCount + '</code><br>'
                    + 'Used in prompt: <code>' + d.usedMessages + ' msgs</code>'
                    + (d.fallback ? ' <span style="color:#ffa726">(fallback — no mentions)</span>' : '') + '<br>'
                    + 'Last location: <code>' + (npc.lastLocation || 'not set') + '</code><br>'
                    + 'Lorebook desc: <code>' + npc.description.length + ' chars</code><br>'
                    + 'Stored events: <code>' + npc.events.length + '</code>'
                    + (d.error ? '<br><span style="color:#ef5350">Error: ' + d.error + '</span>' : '')
                    + '</div>');
            }
        }

        panel.append('<div class="wo_debug_title" style="margin-top:8px;">Batch prompt preview (first 600 chars)</div>');
        try {
            const enabledNpcs = keys.filter(k => npcs[k].enabled);
            if (enabledNpcs.length) {
                const npcList = enabledNpcs.map(k => ({ npc: npcs[k], key: k, params: rollEventParams() }));
                const sharedChat = (() => {
                    try {
                        const ctx = SillyTavern.getContext();
                        return (ctx.chat || []).filter(m => !m.is_system && m.mes).slice(-5)
                            .map(m => (m.is_user ? '[User]' : '[Bot]') + ' ' + m.mes.replace(/<[^>]+>/g, '').trim().slice(0, 500))
                            .join('\n');
                    } catch(e) { return ''; }
                })();
                const msgs = buildBatchMessages(npcList, mainInfo, sharedChat);
                const preview = msgs[1].content.slice(0, 600);
                panel.append('<div class="wo_debug_entry"><code style="word-break:break-all;font-size:0.78em;">'
                    + preview.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
                    + (msgs[1].content.length > 600 ? '\n…(' + msgs[1].content.length + ' chars total)' : '')
                    + '</code></div>');
            } else {
                panel.append('<div class="wo_debug_entry" style="color:#ffa726">No enabled NPCs to preview.</div>');
            }
        } catch(e) {
            panel.append('<div class="wo_debug_entry" style="color:#ef5350">Preview error: ' + e.message + '</div>');
        }
    });

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