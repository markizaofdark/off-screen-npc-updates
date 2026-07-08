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
    maxMessages: 30,       // НОВЫЙ ПАРАМЕТР
    maxCharsPerMsg: 2000,  // НОВЫЙ ПАРАМЕТР
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
let lastChatLength = 0;  // tracks chat size to detect rerolls
let isGenerating = false; // guard against re-entrant generation

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
        if (!npcs[name]) {
            npcs[name] = { name, description, enabled: true, events: [], permanentFacts: [] };
            added++;
        } else {
            npcs[name].description = description;
            // Migrate old NPCs that don't have permanentFacts yet
            if (!npcs[name].permanentFacts) npcs[name].permanentFacts = [];
        }
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
        temperature: 0.95,
        frequency_penalty: 0.2,
        presence_penalty: 0.3,
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

// ── Scene info parser ─────────────────────────────────────────────────────

/**
 * Parses the styled info-block from the last message containing a date.
 * Expected format: "2008/11/12, Поздняя осень • 14:15 • Локация • Персонаж1, Персонаж2"
 * Returns { raw, date, time, season, location, characters[] } or null.
 */
function parseSceneInfo() {
    try {
        const ctx = SillyTavern.getContext();
        const chat = ctx.chat || [];
        const lastMsg = [...chat].reverse().find(m => m.mes && /\d{4}\/\d{2}\/\d{2}/.test(m.mes));
        if (!lastMsg) return null;

        let raw = null;
        // Try styled div first
        const divMatch = lastMsg.mes.match(/<div[^>]+border-left[^>]*?>([\s\S]*?)<\/div>/i);
        if (divMatch) {
            const inner = divMatch[1].replace(/<[^>]+>/g, '').trim();
            if (/\d{4}\/\d{2}\/\d{2}/.test(inner)) raw = inner;
        }
        // Fallback: strip all tags and grab the first line with a date
        if (!raw) {
            const stripped = lastMsg.mes.replace(/<[^>]+>/g, '');
            const lineMatch = stripped.match(/.*\d{4}\/\d{2}\/\d{2}.*/);
            if (lineMatch) raw = lineMatch[0].trim();
        }
        if (!raw) return null;

        // Split on • (bullet U+2022 or literal)
        const parts = raw.split(/\s*[\u2022•]\s*/);
        // parts[0] → "2008/11/12, Поздняя осень"
        // parts[1] → "14:15"
        // parts[2] → "Тюменское ГУВД, кабинет Парфёнова"
        // parts[3] → "Савелий Парфёнов, Андрей Кравцов, Лилит"  (may contain main char too)

        const datePart  = (parts[0] || '').trim();
        const timePart  = (parts[1] || '').trim();
        const locPart   = (parts[2] || '').trim();
        const charPart  = (parts[3] || '').trim();

        const dateMatch = datePart.match(/(\d{4}\/\d{2}\/\d{2})/);
        const date      = dateMatch ? dateMatch[1] : datePart;
        const season    = datePart.replace(/\d{4}\/\d{2}\/\d{2}[,\s]*/,'').trim();

        // Characters: split by comma, trim, remove empties
        const characters = charPart
            ? charPart.split(',').map(s => s.trim()).filter(Boolean)
            : [];

        console.log('[WildOffscreen] parseSceneInfo →', JSON.stringify({ date, time: timePart, location: locPart, characters }));
        return { raw, date, time: timePart, season, location: locPart, characters };
    } catch(e) {
        console.warn('[WildOffscreen] parseSceneInfo error:', e.message);
        return null;
    }
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

function getChatContextForNPC(npc, maxMessages = 30, maxCharsPerMsg = 3000) {
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
        // Используем переданные параметры maxMessages
        if (mentions.length > 0) {
            selected = mentions.slice(-maxMessages);
            debugInfo.usedMessages = selected.length;
            debugInfo.fallback = false;
        } else {
            // Если упоминаний нет, берем больше сообщений для контекста (fallback)
            selected = nonSystem.slice(-maxMessages);
            debugInfo.usedMessages = selected.length;
            debugInfo.fallback = true;
        }

        // Формируем текст, используя maxCharsPerMsg для обрезки каждого сообщения
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
    'minor':   'MINOR — a small, forgettable moment. A habit, a passing mood, a minor errand. Examples: bought groceries, forgot an umbrella, had a bad coffee, daydreamed about someone.',
    'notable': 'NOTABLE — something worth remembering that shifts their day or week. A real change, not just a moment. Examples: got into an argument that ended badly, received unexpected news, lost something important, made a decision they've been avoiding, ran into someone they didn't expect.',
    'major':   'MAJOR — a life-altering event. Something that changes who they are, what they have, or what their future looks like. This is NOT a slightly unusual moment — it must be genuinely significant. Examples: lost their job, found out they're pregnant, witnessed a crime, had a serious accident, received a diagnosis, ended or started a relationship that matters, made an irreversible decision.',
};

const CATEGORY_DESC = {
    'Personal':     'Personal — internal state, body, habits, private life. Something happening TO them or WITHIN them, not involving others much.',
    'Relationship': 'Relationship — a real interaction or shift with a specific other person. Not just thinking about someone — actual contact, conflict, revelation, change in bond.',
    'Status':       'Status — change in their material, social, legal, or physical standing. Job, money, housing, health, reputation, possessions.',
    'Discovery':    'Discovery — finding out something they didn't know. Information, a secret, a place, an object, a truth about themselves or someone else.',
    'Social':       'Social — involvement in a group event, public situation, or community dynamic. Not just being present — actively affected by it.',
};

function rollEventParams() {
    const roll = rollD20();
    const scale = getScale(roll);
    const category = getCategory();
    const isPositive = roll % 2 === 0;
    return { roll, scale, category, isPositive };
}

function buildBatchMessages(npcList, mainCharInfo, sharedChatContext, sceneInfo) {
    const s = getSettings();
    const npcBlocks = npcList.map((item, i) => {
        const { npc, params } = item;
        const history = npc.events.slice(-3).map(e => '- ' + e.text).join('\n') || 'None yet.';
        const impact = params.isPositive ? 'POSITIVE' : 'NEGATIVE';
        const scaleDesc = SCALE_DESC[params.scale.id] || params.scale.label;
        const catDesc = CATEGORY_DESC[params.category] || params.category;
        const npcContextResult = getChatContextForNPC(npc, s.maxMessages, s.maxCharsPerMsg);
        const npcContext = npcContextResult.text;
        const lastLoc = npc.lastLocation ? 'Last known location: ' + npc.lastLocation : '';

        // Detect if this NPC is currently in the active scene
        let inScene = false;
        const sceneChars = (sceneInfo && Array.isArray(sceneInfo.characters)) ? sceneInfo.characters : [];
        if (sceneChars.length > 0) {
            const npcNameLower = npc.name.toLowerCase();
            const searchKeys = Array.isArray(npc.searchKeys) ? npc.searchKeys : [];
            inScene = sceneChars.some(c => {
                if (!c || typeof c !== 'string') return false;
                const cl = c.toLowerCase().trim();
                // Exact match OR scene char name contains NPC name as whole word (handles "Савелий Парфёнов" vs "Парфёнов")
                // Deliberately NOT using npcNameLower.includes(cl) — too greedy, causes false positives
                const exactOrContains = cl === npcNameLower || cl.includes(npcNameLower);
                // Also check search keys (lorebook keys) for alternative name forms
                const keyMatch = searchKeys.some(k => {
                    if (!k || typeof k !== 'string' || k.length < 3) return false;
                    const kl = k.toLowerCase().trim();
                    return cl === kl || cl.includes(kl);
                });
                return exactOrContains || keyMatch;
            });
        }

        const facts = Array.isArray(npc.permanentFacts) ? npc.permanentFacts : [];
        const factsBlock = facts.length
            ? facts.map(f => '  [' + (f.positive ? '+' : '-') + 'PERMANENT] ' + f.text).join('\n')
            : 'None.';

        console.log('[WildOffscreen] NPC', npc.name, '→', inScene ? '[IN SCENE]' : '[OFFSCREEN]', '| sceneChars:', sceneChars);
        return '--- NPC ' + (i + 1) + ': ' + npc.name + (inScene ? ' [IN SCENE]' : ' [OFFSCREEN]') + ' ---\n'
            + 'DESCRIPTION: ' + npc.description.slice(0, 3000) + '\n'
            + (lastLoc ? lastLoc + '\n' : '')
            + 'PERMANENT FACTS (always true, never contradict these): ' + (facts.length ? '\n' + factsBlock : 'None.') + '\n'
            + 'RECENT OFFSCREEN EVENTS (do not repeat): ' + history + '\n'
            + 'MENTIONS IN STORY (for context): ' + (npcContext || 'none') + '\n'
            + (inScene
                ? 'STATUS: THIS CHARACTER IS CURRENTLY IN THE ACTIVE SCENE. DO NOT generate offscreen events.'
                : 'EVENT REQUIREMENTS (STRICT):\n'
                    + '  Scale: ' + scaleDesc + '\n'
                    + '  Category: ' + catDesc + '\n'
                    + '  Tone: ' + impact + ' (must feel ' + (params.isPositive ? 'like a gain, relief, or positive turn' : 'like a loss, setback, or negative development') + ')\n'
                    + '  Roll: ' + params.roll + '/20 — calibrate intensity accordingly.');
    }).join('\n\n');

    // Build scene context header from parsed info-block
    let sceneHeader = '';
    if (sceneInfo) {
        const inSceneNames = sceneInfo.characters.length
            ? sceneInfo.characters.join(', ')
            : 'unknown';
        sceneHeader = '=== ACTIVE SCENE INFO (from story header) ===\n'
            + 'Date & time: ' + sceneInfo.date + (sceneInfo.time ? ' • ' + sceneInfo.time : '') + (sceneInfo.season ? ', ' + sceneInfo.season : '') + '\n'
            + 'Current location: ' + (sceneInfo.location || 'unknown') + '\n'
            + 'Characters PRESENT in this scene: ' + inSceneNames + '\n'
            + 'These characters are actively participating in the scene right now and must receive "No offscreen events. Currently in scene." with their current location.\n'
            + '===\n\n';
    }

    const userContent = (mainCharInfo ? mainCharInfo + '\n\n' : '')
        + sceneHeader
        + 'CURRENT STORY CONTEXT:\n' + (sharedChatContext || 'none') + '\n\n'
        + npcBlocks + '\n\n'
        + 'For each NPC above:\n'
        + '- If marked [IN SCENE]: write exactly: "[current scene location] | No offscreen events. Currently in scene."\n'
        + '- If marked [OFFSCREEN]: write exactly ONE sentence (15-25 words) describing what they just did or experienced independently, away from the active scene.\n'
        + 'Requirements for [OFFSCREEN] NPCs:\n'
        + '- Match the event requirements (impact/scale/type) listed for that NPC\n'
        + '- Be specific to their personality and situation\n'
        + '- Do NOT start with their name\n'
        + '- No dialogue, no poetic language\n\n'
        + 'Also determine a short location name (1-5 words) for where each OFFSCREEN NPC currently is.\n\n'
        + 'Respond with ONLY this format, one line per NPC:\n'
        + npcList.map((item, i) => 'NPC' + (i + 1) + ': [location] | [event sentence or "No offscreen events. Currently in scene."]').join('\n') + '\n'
        + 'Example offscreen: NPC1: the marketplace | She haggled bitterly over a bag of spices with an impatient merchant.\n'
        + 'Example in-scene: NPC2: Тюменское ГУВД, кабинет Парфёнова | No offscreen events. Currently in scene.';

    console.log('[WildOffscreen] Batch prompt for', npcList.length, 'NPCs, userContent length:', userContent.length);

    return [
        {
            role: 'system',
            content: 'You write brief offscreen event summaries for story characters. '
                + 'Dry, specific, one sentence per character. No names at sentence start. No dialogue. No poetic language. '
                + 'CRITICAL RULE 1: Each NPC is marked [IN SCENE] or [OFFSCREEN]. '
                + 'For [IN SCENE] characters: write exactly: "[location] | No offscreen events. Currently in scene." — no exceptions. '
                + 'For [OFFSCREEN] characters: generate one offscreen event matching the EVENT REQUIREMENTS exactly. '
                + 'CRITICAL RULE 2: Scale is MANDATORY. MINOR = trivial moment. NOTABLE = real shift in their day/situation. MAJOR = life-changing — must be genuinely significant, irreversible or deeply impactful. If you write a MAJOR event that sounds like something that happens every day, you have failed. '
                + 'CRITICAL RULE 3: Category is MANDATORY. Match the category exactly — Personal is internal/private, Relationship requires another person present, Status changes their standing, Discovery means new information, Social means group/public context. '
                + 'CRITICAL RULE 4: Do NOT downgrade the scale. If the requirement says MAJOR, write something major. Do not write a minor inconvenience and call it major. '
                + 'CRITICAL RULE 5: No repetition. Every event must be completely different from RECENT OFFSCREEN EVENTS in theme, action, and phrasing. '
                + 'CRITICAL RULE 6: Follow the exact output format. One line per NPC, no extra commentary.',
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
        if (pipeIdx > 0 && pipeIdx < 120) {
            const maybeLocation = raw.slice(0, pipeIdx).trim();
            const maybeEvent = raw.slice(pipeIdx + 1).trim();
            if (maybeLocation.length > 0 && maybeLocation.length < 100 && maybeEvent.length > 5) {
                location = maybeLocation;
                sentence = maybeEvent;
            }
        }

        // Detect "currently in scene" marker — don't treat as a real event
        const inSceneMarker = /no offscreen events|currently in scene/i.test(sentence);
        if (inSceneMarker) {
            results.push({ location, text: sentence, inScene: true });
            continue;
        }

        // Take only first sentence
        const first = sentence.match(/^[^.!?]+[.!?]/);
        if (first && first[0].length > 10) sentence = first[0].trim();

        results.push(sentence.length >= 10 ? { location, text: sentence, inScene: false } : null);
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
            const chat = ctx.chat || [];
            const lastMsgWithTime = [...chat].reverse().find(m => m.mes && /\d{4}\/\d{2}\/\d{2}/.test(m.mes));
            const timeInfo = lastMsgWithTime
                ? (lastMsgWithTime.mes.match(/(\d{4}\/\d{2}\/\d{2}[^<]*?) •/) || [])[1] || 'Unknown time'
                : 'Unknown time';
            const s = getSettings();
            return chat
                .filter(m => !m.is_system && m.mes)
                .slice(-s.maxMessages)
                .map(m => (m.is_user ? '[User]' : '[Bot]') + ' ' + m.mes.replace(/<[^>]+>/g, '').trim().slice(0, s.maxCharsPerMsg))
                .join('\n');
        } catch(e) { return ''; }
    })();

    const npcList = keys.map(k => ({ npc: npcs[k], key: k, params: rollEventParams() }));

    const sceneInfo = parseSceneInfo();
    const messages = buildBatchMessages(npcList, mainCharInfo, sharedChat, sceneInfo);
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

        // NPC is currently in scene — don't create an event, just log
        if (result.inScene) {
            console.log('[WildOffscreen]', npc.name, 'is in scene — skipping event creation');
            continue;
        }

        const event = {
            text: result.text,
            location: result.location,
            scale: params.scale.id,
            category: params.category,
            positive: params.isPositive,
            timestamp: Date.now(),
        };

        npc.events.push(event);
        if (npc.events.length > s.maxEvents) npc.events = npc.events.slice(-s.maxEvents);

        // Auto-promote MAJOR events to permanentFacts
        if (!npc.permanentFacts) npc.permanentFacts = [];
        if (params.scale.id === 'major') {
            const factText = result.text;
            const alreadyStored = npc.permanentFacts.some(f => f.text === factText);
            if (!alreadyStored) {
                npc.permanentFacts.push({
                    text: factText,
                    category: params.category,
                    positive: params.isPositive,
                    timestamp: Date.now(),
                    auto: true,
                });
                console.log('[WildOffscreen] Auto-promoted MAJOR event to permanentFacts for', npc.name);
            }
        }

        // Update last known location only for offscreen NPCs
        if (result.location && result.location !== 'unknown') {
            npc.lastLocation = result.location;
        }

        console.log('[WildOffscreen] Event for', npc.name, '@', result.location, ':', result.text);
    }
}

async function runGenerationCycle() {
    if (isGenerating) {
        console.log('[WildOffscreen] Already generating, skipping.');
        return;
    }
    const npcs = getNPCs();
    const keys = Object.keys(npcs).filter(k => npcs[k].enabled);
    if (!keys.length) return;

    isGenerating = true;
    $('#wo_status').text('Generating offscreen events…').show();

    try {
        const beforeCounts = Object.fromEntries(keys.map(k => [k, npcs[k].events.length]));

        // Figure out which NPCs are offscreen (expect events) vs in-scene (expect nothing)
        const sceneInfo = parseSceneInfo();
        const sceneChars = (sceneInfo && Array.isArray(sceneInfo.characters)) ? sceneInfo.characters : [];
        const isInScene = (npc) => sceneChars.some(c => {
            if (!c || typeof c !== 'string') return false;
            const cl = c.toLowerCase().trim();
            const nl = npc.name.toLowerCase();
            const sk = Array.isArray(npc.searchKeys) ? npc.searchKeys : [];
            return cl === nl || cl.includes(nl) || nl.includes(cl)
                || sk.some(k => k && typeof k === 'string' && cl.includes(k.toLowerCase()));
        });
        const offscreenKeys = keys.filter(k => !isInScene(npcs[k]));
        const inSceneKeys   = keys.filter(k =>  isInScene(npcs[k]));
        console.log('[WildOffscreen] Offscreen:', offscreenKeys.length, '| In scene:', inSceneKeys.length);

        await generateEventsForAllNPCs(npcs);
        const firstGenerated = offscreenKeys.filter(k => npcs[k].events.length > beforeCounts[k]).length;
        if (firstGenerated === 0 && offscreenKeys.length > 0) {
            console.log('[WildOffscreen] First attempt got 0 offscreen results, retrying...');
            await new Promise(r => setTimeout(r, 1500));
            await generateEventsForAllNPCs(npcs);
        }

        await saveNPCs(npcs);
        updateInjection();
        renderNPCList();

        const generated = offscreenKeys.filter(k => npcs[k].events.length > beforeCounts[k]).length;
        const failed = offscreenKeys.length - generated;

        if (offscreenKeys.length === 0 && inSceneKeys.length > 0) {
            toastr.info(`All ${inSceneKeys.length} NPC(s) are currently in scene — no offscreen events generated.`);
        } else if (generated === 0 && offscreenKeys.length > 0) {
            toastr.error('Generation failed. Check your connection profile and model.');
        } else if (failed > 0) {
            toastr.warning(`Generated events for ${generated}/${offscreenKeys.length} offscreen NPCs.`);
        } else {
            const inSceneNote = inSceneKeys.length ? ` (${inSceneKeys.length} in scene, skipped)` : '';
            toastr.success(`Generated events for all ${generated} offscreen NPCs.` + inSceneNote);
        }
    } catch(e) {
        console.error('[WildOffscreen] runGenerationCycle error:', e.message);
        toastr.error('Generation error: ' + e.message);
    } finally {
        isGenerating = false;
        $('#wo_status').text('').hide();
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

    // If WE triggered this generation via callAPI, ignore it to avoid re-entrant loop
    if (isGenerating) {
        console.log('[WildOffscreen] Skipping GENERATION_STARTED fired by our own API call');
        return;
    }

    try {
        const ctx = SillyTavern.getContext();
        const currentLength = (ctx.chat || []).length;
        const isReroll = currentLength === lastChatLength && currentLength > 0;
        lastChatLength = currentLength;

        if (isReroll) {
            console.log('[WildOffscreen] Reroll detected — removing last events and regenerating');
            const npcs = getNPCs();
            let removed = 0;
            for (const key of Object.keys(npcs)) {
                if (npcs[key].enabled && npcs[key].events.length > 0) {
                    npcs[key].events.pop();
                    removed++;
                }
            }
            if (removed > 0) {
                saveNPCs(npcs).then(() => {
                    renderNPCList();
                    updateInjection();
                });
                msgCounter = s.triggerEvery; // force generation on this turn
            }
        }
    } catch(e) {
        console.warn('[WildOffscreen] onGenerationStarted error:', e.message);
    }

    msgCounter++;
    if (msgCounter >= s.triggerEvery) {
        msgCounter = 0;
        // Defer to let ST finish its own generation first, then run ours
        setTimeout(() => runGenerationCycle(), 100);
    }
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


        if (npc.lastLocation) {
            evContainer.append('<div class="wo_npc_location">📍 ' + npc.lastLocation + '</div>');
        }

        // ── Permanent facts section ──────────────────────────────
        const facts = Array.isArray(npc.permanentFacts) ? npc.permanentFacts : [];
        if (facts.length) {
            evContainer.append('<div style="font-size:0.78em;font-weight:700;opacity:0.6;text-transform:uppercase;letter-spacing:0.05em;margin: 6px 0 3px 0;">📌 Permanent facts</div>');
            facts.forEach((fact, fi) => {
                const fcolor = fact.positive ? '#66bb6a' : '#ef5350';
                const autoTag = fact.auto ? ' <span style="opacity:0.4;font-size:0.85em;">(auto)</span>' : '';
                const fRow = $(`
                    <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:6px;margin-bottom:4px;padding:4px 6px;border-radius:3px;background:color-mix(in srgb, var(--SmartThemeQuoteColor) 8%, transparent);border-left:2px solid color-mix(in srgb, var(--SmartThemeQuoteColor) 40%, transparent);">
                        <div style="flex:1;font-size:0.82em;">
                            <span style="color:${fcolor};font-weight:600;">${fact.positive ? '▲' : '▼'} ${fact.category || ''}${autoTag}</span>
                            <div style="opacity:0.9;line-height:1.4;">${fact.text}</div>
                        </div>
                        <button class="wo_btn_delete_fact menu_button" data-fidx="${fi}" title="Remove permanent fact" style="padding:0px 4px;font-size:0.75em;min-width:unset;opacity:0.4;">✕</button>
                    </div>
                `);
                evContainer.append(fRow);
            });
        }

        // ── Regular events section ───────────────────────────────
        if (!npc.events.length && !facts.length) {
            evContainer.append('<div class="wo_no_events">No events yet.</div>');
        } else if (npc.events.length) {
            if (facts.length) {
                evContainer.append('<div style="font-size:0.78em;font-weight:700;opacity:0.6;text-transform:uppercase;letter-spacing:0.05em;margin: 8px 0 3px 0;">🕐 Recent events</div>');
            }
            const reversedEvents = [...npc.events].reverse();
            for (let i = 0; i < reversedEvents.length; i++) {
                const ev = reversedEvents[i];
                const originalIndex = npc.events.length - 1 - i;
                const color = ev.positive ? '#66bb6a' : '#ef5350';
                const locTag = ev.location && ev.location !== 'unknown'
                    ? '<span class="wo_event_loc">📍 ' + ev.location + '</span>'
                    : '';
                const evText = typeof ev.text === 'string' ? ev.text : String(ev.text?.text || ev.text || '');
                const isMajor = ev.scale === 'major';
                const alreadyFact = facts.some(f => f.text === evText);

                const evRow = $(`
                    <div class="wo_event" style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px;margin-bottom:6px;">
                        <div style="flex:1;">
                            <span class="wo_event_meta" style="color:${color}">${ev.positive ? '▲' : '▼'} ${ev.scale.toUpperCase()} · ${ev.category}${isMajor ? ' ⭐' : ''}</span>
                            ${locTag}
                            <div class="wo_event_text">${evText}</div>
                        </div>
                        <div style="display:flex;flex-direction:column;gap:2px;flex-shrink:0;">
                            ${alreadyFact ? '' : '<button class="wo_btn_promote_event menu_button" data-idx="' + originalIndex + '" title="Save as permanent fact" style="padding:0px 4px;font-size:0.75em;min-width:unset;opacity:0.55;">📌</button>'}
                            <button class="wo_btn_delete_event menu_button" data-idx="${originalIndex}" title="Delete this event" style="padding:0px 4px;font-size:0.75em;min-width:unset;opacity:0.4;">✕</button>
                        </div>
                    </div>
                `);
                evContainer.append(evRow);
            }
        }

        // ── Event handlers ───────────────────────────────────────
        evContainer.find('.wo_btn_delete_fact').on('click', async function (e) {
            e.stopPropagation();
            const fi = parseInt($(this).attr('data-fidx'));
            if (isNaN(fi)) return;
            const n = getNPCs();
            if (n[key] && n[key].permanentFacts) {
                n[key].permanentFacts.splice(fi, 1);
                await saveNPCs(n);
                renderNPCList();
                updateInjection();
            }
        });

        evContainer.find('.wo_btn_promote_event').on('click', async function (e) {
            e.stopPropagation();
            const idx = parseInt($(this).attr('data-idx'));
            if (isNaN(idx)) return;
            const n = getNPCs();
            if (n[key] && n[key].events && n[key].events[idx]) {
                const ev = n[key].events[idx];
                const evText = typeof ev.text === 'string' ? ev.text : String(ev.text?.text || ev.text || '');
                if (!n[key].permanentFacts) n[key].permanentFacts = [];
                if (!n[key].permanentFacts.some(f => f.text === evText)) {
                    n[key].permanentFacts.push({
                        text: evText,
                        category: ev.category,
                        positive: ev.positive,
                        timestamp: Date.now(),
                        auto: false,
                    });
                    await saveNPCs(n);
                    renderNPCList();
                    updateInjection();
                    toastr.success('Saved as permanent fact.');
                }
            }
        });

        evContainer.find('.wo_btn_delete_event').on('click', async function (e) {
            e.stopPropagation();
            const idx = parseInt($(this).attr('data-idx'));
            if (isNaN(idx)) return;
            const n = getNPCs();
            if (n[key] && n[key].events) {
                n[key].events.splice(idx, 1);
                await saveNPCs(n);
                renderNPCList();
                updateInjection();
            }
        });
        
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
    const s = getSettings();
    const html = `
    <div id="wo_panel" class="inline-drawer">
        <div class="inline-drawer-toggle inline-drawer-header">
            <b>Wild Offscreen</b>
            <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
        </div>
        <div class="inline-drawer-content">
            <label class="checkbox_label"><input type="checkbox" id="wo_toggle" ${s.enabled ? 'checked' : ''} /><span>Enable</span></label>
            <div id="wo_status" class="wo_status" style="display:none;"></div>

            <div class="wo_section_label">Current Story Date</div>
            <div id="wo_date_display" style="font-family: monospace; color: var(--SmartThemeQuoteColor); margin-bottom: 10px; font-weight: bold;">—</div>

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

            <div class="wo_section_label">Token Context Settings</div>
            <label><small>Messages history depth (how many messages to read)</small></label>
            <input type="number" id="wo_max_messages" class="text_pole" value="${s.maxMessages || 30}" />
            <label><small>Max characters per message (truncation limit)</small></label>
            <input type="number" id="wo_max_chars" class="text_pole" value="${s.maxCharsPerMsg || 2000}" />

            <hr>

            <div class="wo_section_label">Connection Profile</div>
            <div style="display:flex;gap:6px;align-items:center;">
                <select id="wo_profile_select" class="text_pole" style="flex:1;"></select>
                <input type="button" id="wo_profile_refresh" class="menu_button" value="🔄" title="Refresh profiles" style="flex-shrink:0;" />
            </div>

            <div class="wo_section_label">Event Settings</div>
            <label><small>Generate events every N messages</small></label>
            <input type="number" id="wo_trigger_every" class="text_pole" value="${s.triggerEvery}" />
            <label><small>Max stored events per NPC</small></label>
            <input type="number" id="wo_max_events" class="text_pole" value="${s.maxEvents}" />
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

    $('#wo_max_messages').val(s.maxMessages || 30);
    $('#wo_max_chars').val(s.maxCharsPerMsg || 2000);

    function extractDateFromMessage(mes) {
        if (!mes) return null;
        // Try to pull full content from the styled info div
        const divMatch = mes.match(/<div[^>]+border-left[^>]*>([\s\S]*?)<\/div>/i);
        if (divMatch) {
            const inner = divMatch[1].replace(/<[^>]+>/g, '').trim();
            if (/\d{4}\/\d{2}\/\d{2}/.test(inner)) return inner;
        }
        // Fallback: grab date + time from raw stripped text
        const raw = mes.replace(/<[^>]+>/g, '');
        const withTime = raw.match(/(\d{4}\/\d{2}\/\d{2}[^\u2022\n]*\u2022[^\u2022\n]*)/);
        if (withTime) return withTime[1].trim();
        const dateOnly = raw.match(/(\d{4}\/\d{2}\/\d{2})/);
        return dateOnly ? dateOnly[1] : null;
    }

    function updateDateDisplay() {
        try {
            const ctx = SillyTavern.getContext();
            const chat = ctx.chat || [];
            const lastMsg = [...chat].reverse().find(m => m.mes && /\d{4}\/\d{2}\/\d{2}/.test(m.mes));
            const dateStr = lastMsg ? extractDateFromMessage(lastMsg.mes) : null;
            $('#wo_date_display').text(dateStr || 'No date found in history');
        } catch(e) {
            $('#wo_date_display').text('—');
        }
    }

    updateDateDisplay();

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
    $('#wo_profile_select').on('change', function () { s.connectionProfile = this.value; saveSettingsDebounced(); });
    $('#wo_profile_refresh').on('click', () => { refreshProfileSelect(); toastr.info('Connection profiles refreshed.'); });
    
    $('#wo_max_messages').on('input', function() { s.maxMessages = parseInt(this.value) || 30; saveSettingsDebounced(); });
    $('#wo_max_chars').on('input', function() { s.maxCharsPerMsg = parseInt(this.value) || 2000; saveSettingsDebounced(); });

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
                        const chat = ctx.chat || [];
                        const _s = getSettings();
                        return chat
                            .filter(m => !m.is_system && m.mes)
                            .slice(-_s.maxMessages)
                            .map(m => (m.is_user ? '[User]' : '[Bot]') + ' ' + m.mes.replace(/<[^>]+>/g, '').trim().slice(0, _s.maxCharsPerMsg))
                            .join('\n');
                    } catch(e) { return ''; }
                })();
                const _sceneInfo = parseSceneInfo();
                const msgs = buildBatchMessages(npcList, mainInfo, sharedChat, _sceneInfo);
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

    // CHARACTER_MESSAGE_RENDERED fires after the bot finishes writing — safe to count here.
    // This avoids the re-entrant loop that GENERATION_STARTED caused (it fires during our own callAPI too).
    eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, () => {
        updateDateDisplay();
        if (isGenerating) return; // our own API call, ignore

        const s = getSettings();
        if (!s.enabled) return;

        try {
            const ctx = SillyTavern.getContext();
            const currentLength = (ctx.chat || []).length;
            const isReroll = currentLength === lastChatLength && currentLength > 0;
            lastChatLength = currentLength;

            if (isReroll) {
                console.log('[WildOffscreen] Reroll detected — removing last events');
                const npcs = getNPCs();
                let removed = 0;
                for (const key of Object.keys(npcs)) {
                    if (npcs[key].enabled && npcs[key].events.length > 0) {
                        npcs[key].events.pop();
                        removed++;
                    }
                }
                if (removed > 0) {
                    saveNPCs(npcs).then(() => { renderNPCList(); updateInjection(); });
                }
                // Force generation this turn regardless of counter
                msgCounter = s.triggerEvery;
            }
        } catch(e) {
            console.warn('[WildOffscreen] CHARACTER_MESSAGE_RENDERED error:', e.message);
        }

        msgCounter++;
        if (msgCounter >= s.triggerEvery) {
            msgCounter = 0;
            runGenerationCycle();
        }
    });

    eventSource.on(event_types.USER_MESSAGE_RENDERED, () => {
        updateDateDisplay();
    });

    eventSource.on(event_types.CHAT_CHANGED, () => {
        msgCounter = 0;
        lastChatLength = 0;
        setTimeout(() => {
            try {
                const ctx = SillyTavern.getContext();
                lastChatLength = (ctx.chat || []).length;
            } catch(e) {}
            renderNPCList();
            updateInjection();
            updateDateDisplay();
            $('#wo_book_info').text('Bot: ' + getBotKey());
        }, 200);
    });

    updateInjection();
});