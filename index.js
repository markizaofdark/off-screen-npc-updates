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
    maxMessages: 30,
    maxCharsPerMsg: 2000,
    enabled: true,
    triggerEvery: 5,
    maxEvents: 7,
    injectMaxMessages: 0,
    connectionProfile: '',
    maxTokens: 200,
    outputLanguage: 'en',
    scanPosition: 'before_char',
};

const LANGUAGE_INSTRUCTION = {
    'en': 'Write in English.',
    'ru': 'Write in Russian (на русском языке).',
    'uk': 'Write in Ukrainian (українською мовою).',
};

const SCALE = [
    { min: 1,  max: 8,  id: 'minor',   label: 'MINOR'   },
    { min: 9,  max: 16, id: 'notable', label: 'NOTABLE' },
    { min: 17, max: 20, id: 'major',   label: 'MAJOR'   },
];

// ── Offscreen event pools ──────────────────────────────────
// Архетипы личных событий NPC по масштабу и категории.
// Модель получает архетип и адаптирует его под конкретного персонажа.

const EVENT_POOLS = {
    minor: {
        Personal: {
            positive: [
                'found a small pleasure in an otherwise unremarkable day',
                'finally got around to something they had been putting off for weeks',
                'woke up feeling unexpectedly rested and clear-headed',
                'allowed themselves a minor indulgence without guilt',
                'noticed something small about themselves they had not noticed before',
                'completed a private routine that gave them quiet satisfaction',
                'spent time alone in a way that felt restorative rather than isolating',
                'came across something that reminded them of a better period of their life',
            ],
            negative: [
                'could not shake a low mood without any clear reason',
                'was reminded of something they would rather forget',
                'made a small mistake they will be quietly replaying for days',
                'slept badly and it colored the whole day',
                'found themselves unable to concentrate on something that usually comes easily',
                'felt a familiar anxiety return over something minor',
                'lost something small but meaningful to them',
                'spent more time alone than they intended and felt the weight of it',
            ],
        },
        Relationship: {
            positive: [
                'had a brief but warm exchange with someone they see regularly',
                'received a small, unexpected gesture of kindness from someone',
                'cleared up a minor tension with someone without it becoming a real conversation',
                'remembered someone fondly and let themselves sit with it',
                'was asked for their opinion and felt genuinely heard',
                'ran into someone from their past under pleasant circumstances',
                'shared a moment of unplanned honesty with someone they trust',
                'felt unexpectedly close to someone during an ordinary interaction',
            ],
            negative: [
                'had an interaction that left a faintly wrong feeling they cannot name',
                'said something slightly off and noticed it only afterward',
                'felt overlooked by someone whose attention matters to them',
                'ran into someone they have been avoiding',
                'had a message go unanswered long enough to mean something',
                'felt the distance between themselves and someone close grow a little wider',
                'witnessed something between two others that made them uncomfortable',
                'realized they had misread someone they thought they knew well',
            ],
        },
        Status: {
            positive: [
                'managed a small financial worry that had been nagging at them',
                'received a minor but genuine compliment on their work',
                'got something repaired or sorted that had been broken for too long',
                'found a practical solution to an inconvenience they had been living around',
                'was recognized for something small but it felt good',
                'had an administrative task finally come through after delays',
                'received something they were owed without having to ask again',
                'gained a small practical advantage through no particular effort',
            ],
            negative: [
                'an unexpected expense arrived at a bad time',
                'something they relied on broke or stopped working',
                'a minor bureaucratic obstacle turned into something tedious',
                'received feedback on their work that stung more than it should have',
                'found themselves behind on something they thought was under control',
                'a small but relied-upon arrangement fell through',
                'lost a minor privilege or convenience without warning',
                'a task they had planned took much longer than expected and threw off the day',
            ],
        },
        Discovery: {
            positive: [
                'stumbled onto a piece of information that answered a small lingering question',
                'overheard something that made a confusing situation make more sense',
                'found something they had forgotten they owned, and it was useful',
                'noticed a pattern they had been missing for a while',
                'came across a resource, place or idea that felt genuinely useful',
                'learned something small about someone that made them easier to read',
                'realized a past assumption was slightly wrong, and the correction was a relief',
                'encountered something that gave them a new way to think about an old problem',
            ],
            negative: [
                'found out something minor that they would have preferred not to know',
                'noticed a detail that made something previously comfortable feel uncertain',
                'overheard something not meant for them that now they cannot unknow',
                'discovered a small error they had made that went unnoticed — until now',
                'learned something about someone that did not fit the image they had built',
                'came across information that reopened something they thought was settled',
                'realized they had been operating on a wrong assumption for longer than they thought',
                'found evidence of something they had been telling themselves was not happening',
            ],
        },
        Social: {
            positive: [
                'found themselves in a group situation that was better than expected',
                'was included in something they had not expected to be invited to',
                'navigated a social obligation without it costing them much',
                'found unexpected common ground with someone in a group setting',
                'left a social situation feeling more at ease than when they arrived',
                'was seen doing something well in front of people who mattered',
                'had a brief but pleasant exchange in a public setting',
                'found the crowd or atmosphere of a place unexpectedly agreeable',
            ],
            negative: [
                'endured a social obligation that drained more than expected',
                'said something in a group that landed poorly and they felt it',
                'found themselves on the outside of a dynamic they did not fully understand',
                'was put on the spot in a way they were not prepared for',
                'witnessed something in a public setting that left them unsettled',
                'was subjected to an opinion or behavior they could not easily challenge',
                'left a social situation with the vague feeling of having performed badly',
                'felt their status within a group shift slightly in the wrong direction',
            ],
        },
    },

    notable: {
        Personal: {
            positive: [
                'made a decision about their own life that they had been avoiding for weeks',
                'confronted a habit or pattern and actually changed something about it',
                'experienced a genuine shift in how they see themselves or their situation',
                'allowed themselves to want something they had been denying for too long',
                'recovered from something that had been affecting them more than they admitted',
                'reached a private resolution that gave them a sense of direction',
                'had an experience that cracked open something they had kept sealed',
                'took a meaningful step toward something that matters to them',
            ],
            negative: [
                'had a crisis of confidence that shook something they thought was settled',
                'confronted something about themselves they had been successfully avoiding',
                'relapsed into a pattern they thought they had moved past',
                'experienced a loss of motivation that does not feel temporary',
                'made a personal decision under pressure that they are not sure was right',
                'realized they have been lying to themselves about something important',
                'felt something close to breaking point over something others might call minor',
                'went through something alone that they should not have had to go through alone',
            ],
        },
        Relationship: {
            positive: [
                'had a genuine conversation with someone that changed how they see each other',
                'repaired a relationship that had been silently deteriorating',
                'crossed a threshold of closeness with someone that cannot be uncrossed',
                'told someone something true that they had been holding back',
                'was forgiven for something by someone whose forgiveness matters',
                'finally asked for help from someone and was not let down',
                'reconnected with someone they had drifted from in a way that felt real',
                'realized the depth of a relationship that they had been taking for granted',
            ],
            negative: [
                'had a fight with someone important that left real damage behind',
                'said something they cannot take back to someone who matters',
                'discovered that a relationship they trusted had a crack running through it',
                'felt betrayed by someone in a way they will not easily forget',
                'ended or stepped back from a connection that had become too costly',
                'realized that someone they relied on is not who they thought',
                'watched a relationship slide toward something worse without knowing how to stop it',
                'was forced to choose between two people or loyalties and made the choice',
            ],
        },
        Status: {
            positive: [
                'received unexpected recognition that changed how they are perceived in their environment',
                'secured a material improvement in their situation that had felt out of reach',
                'gained a meaningful degree of autonomy or freedom they did not have before',
                'resolved a financial or practical problem that had been a background source of stress',
                'was offered an opportunity that genuinely changes their options',
                'gained the trust or backing of someone whose support carries real weight',
                'got out of an obligation or arrangement that had been limiting them',
                'achieved something in their work or responsibilities that they are actually proud of',
            ],
            negative: [
                'lost something material or practical that will take time and effort to recover from',
                'had their position, standing, or credibility damaged in their environment',
                'encountered a financial or logistical problem they cannot easily absorb',
                'found themselves locked into an obligation that narrows their options',
                'failed at something that mattered and the failure was visible to others',
                'lost the support or backing of someone whose opinion carries weight',
                'was passed over for something they deserved and felt the injustice of it',
                'had a practical arrangement that underpinned their stability fall apart',
            ],
        },
        Discovery: {
            positive: [
                'uncovered information that reframes a situation they had been navigating wrongly',
                'found evidence that someone they doubted is actually trustworthy',
                'learned something that resolves a question that has been quietly eating at them',
                'discovered a capability in themselves they did not know was there',
                'came across a piece of truth that makes a difficult situation workable',
                'found out something about their past that explains more than they expected',
                'learned something that shifts their understanding of someone important to them',
                'received information that opens a door they thought was permanently closed',
            ],
            negative: [
                'found out something about someone they trusted that they cannot reconcile',
                'uncovered information that makes a situation much more complicated than it appeared',
                'discovered they have been deceived, and it was not accidental',
                'learned something about themselves they were not ready to know',
                'found out about something that happened without their knowledge that affects them directly',
                'discovered a truth that closes off an option they were counting on',
                'came across evidence of something that forces them to re-examine the recent past',
                'learned something that makes it impossible to continue as if they did not know',
            ],
        },
        Social: {
            positive: [
                'navigated a difficult group situation in a way that raised how others see them',
                'became part of a social circle or community that offers something they have been missing',
                'was publicly supported by someone in a way that changed the room',
                'managed to shift a social dynamic that had been working against them',
                'was trusted with something by a group that signals their acceptance',
                'helped someone publicly in a way that cost them something and earned real respect',
                'had a social reputation repaired after a period of quiet damage',
                'forged a connection in a group setting that has real future potential',
            ],
            negative: [
                'was publicly embarrassed or undermined in a way that will be remembered',
                'lost standing within a group or community they were part of',
                'found themselves on the wrong side of a social conflict without intending to be',
                'was excluded or edged out of something they relied on socially',
                'had a private matter become public within their social environment',
                'was associated with something or someone in a way that damaged how they are seen',
                'watched a social environment they depended on fracture around them',
                'became the focus of group judgment in a way that is hard to recover from quickly',
            ],
        },
    },

    major: {
        Personal: {
            positive: [
                'experienced something that fundamentally changed how they understand themselves',
                'made an irreversible choice about their own life that they have been circling for years',
                'escaped something that had been defining and limiting them for a long time',
                'came through a crisis that forced genuine change and emerged different on the other side',
                'had a moment of clarity about who they are and what they actually want',
                'finally let go of something they had been carrying that was costing them everything',
                'chose themselves in a situation where they had always chosen otherwise before',
                'survived something that would have broken an earlier version of them',
            ],
            negative: [
                'reached a breaking point that has been building for longer than anyone knew',
                'made a decision in a moment of crisis that permanently altered the shape of their life',
                'lost something central to who they are or how they see themselves',
                'suffered something that will leave a mark they will carry for years',
                'collapsed under the weight of something they had been managing alone',
                'did something they cannot take back and will have to live with',
                'had the version of themselves they showed the world shatter in front of people who mattered',
                'discovered that something they built their life around is not what they believed it was',
            ],
        },
        Relationship: {
            positive: [
                'committed to someone or something in a way that is real and irreversible',
                'ended a relationship that was slowly destroying them and felt the relief of it',
                'forgave someone for something significant and felt themselves change because of it',
                'told someone the most important true thing they have never said and was not destroyed by it',
                'formed a bond with someone that redefines what they thought connection could feel like',
                'was chosen by someone in a way that changed what they believe they deserve',
                'repaired something that everyone including them had written off as finished',
                'found out that someone has loved or supported them in ways they never knew',
            ],
            negative: [
                'lost someone important from their life in a way that does not have a clean ending',
                'was betrayed by someone at the exact depth where it does the most damage',
                'ended something that had been central to their life and felt the full weight of it',
                'discovered that a relationship they depended on was built on something false',
                'said or did something in a relationship that cannot be forgiven or undone',
                'watched someone they love make a choice that separates them',
                'was left by someone and it reached parts of them they did not know were still open',
                'had to cut someone out of their life to survive it and is not sure they did the right thing',
            ],
        },
        Status: {
            positive: [
                'gained access to something — money, power, freedom, opportunity — that changes their options permanently',
                'achieved something in their field or life that redefines how they and others see what they are capable of',
                'escaped a material or legal situation that had them trapped',
                'was given a position of trust or authority that opens a genuinely new chapter',
                'received something — inheritance, recognition, offer — that restructures their circumstances',
                'resolved a long-running practical crisis in a way that actually holds',
                'attained a degree of stability or security they have not had in years',
                'was publicly recognized in a way that changes their standing in a permanent and meaningful way',
            ],
            negative: [
                'lost their livelihood, housing, or another material foundation of their life',
                'received a diagnosis, legal judgment, or official finding that changes everything going forward',
                'had their reputation destroyed in an environment where reputation is everything',
                'lost a position they had worked for and the identity that came with it',
                'found themselves in financial or legal trouble that does not have a simple resolution',
                'had something they built taken from them in a way that feels definitive',
                'was stripped of something — a role, a right, a resource — that they depended on',
                'fell from a standing they worked years to reach and cannot easily reconstruct',
            ],
        },
        Discovery: {
            positive: [
                'found out something that rewrites a significant portion of their personal history',
                'learned a truth that dissolves a source of guilt or shame they have carried for years',
                'discovered something that vindicates a choice they have been second-guessing',
                'found out they have been loved, protected, or valued in ways they never understood',
                'learned something that turns an enemy or adversary into something more complicated',
                'uncovered something that gives them leverage or safety they have never had before',
                'discovered that something they mourned is not as lost as they believed',
                'came across a truth that closes a chapter they could never quite finish',
            ],
            negative: [
                'discovered a truth about someone central to their life that cannot be reconciled with who they thought that person was',
                'found out something about their past that reframes things they thought they understood',
                'learned they have been deceived in something fundamental and for a long time',
                'uncovered something that makes them complicit in something they did not choose',
                'discovered a truth that makes a relationship, identity, or belief impossible to maintain',
                'found out something is happening — or has happened — that they cannot protect themselves or others from now that they know',
                'learned something that requires them to act and the action will cost them',
                'came across a truth that closes off the version of the future they were working toward',
            ],
        },
        Social: {
            positive: [
                'became a figure of genuine trust or authority within a community or group',
                'was publicly defended or championed in a way that shifted a social landscape around them',
                'found belonging in a community after a long period of being outside one',
                'had their social standing restored or elevated after a period of damage',
                'was instrumental in resolving a conflict within their group and gained lasting credibility for it',
                'forged an alliance or coalition that gives them real collective power',
                'was accepted into a circle or institution that meaningfully changes their access and options',
                'did something publicly that will be remembered and associated with them long-term',
            ],
            negative: [
                'was publicly exposed, condemned, or cast out from a community they depended on',
                'became a scapegoat in a social conflict in a way that is hard to disprove or escape',
                'had a private failure or secret become the defining public fact about them',
                'was abandoned by a group at the moment they most needed collective support',
                'watched a social structure they were part of collapse and were caught in the wreckage',
                'was made an example of in front of people whose opinion shapes their world',
                'lost a network or community that had been their primary source of support and identity',
                'was involved in a public incident that will follow them for a long time',
            ],
        },
    },
};

const CATEGORIES = Object.keys(EVENT_POOLS.minor);

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

function getChatKey() {
    try {
        const ctx = SillyTavern.getContext();
        // ST stores current chat filename in ctx.getCurrentChatId() or ctx.chatId
        const chatId = (typeof ctx.getCurrentChatId === 'function' ? ctx.getCurrentChatId() : null)
            || ctx.chatId
            || ctx.selected_group
            || (ctx.chat?.length ? 'chat_' + ctx.chat[0]?.send_date : null)
            || 'default';
        return String(chatId);
    } catch(e) { return 'default'; }
}

/**
 * Storage layout in extension_settings[EXT].npcData:
 * {
 *   [botKey]: {
 *     __npcs: { [name]: { name, description, enabled, searchKeys, lorebookName, entryUid } },
 *     [chatKey]: { [name]: { events[], permanentFacts[], lastLocation } }
 *   }
 * }
 * NPCs (identity) are per-bot. Events+facts are per-bot+chat.
 */

function getNPCStore() {
    const s = getSettings();
    const botKey = getBotKey();
    if (!s.npcData) s.npcData = {};
    if (!s.npcData[botKey]) s.npcData[botKey] = { __npcs: {} };
    if (!s.npcData[botKey].__npcs) s.npcData[botKey].__npcs = {};
    return s.npcData[botKey];
}

function getChatStore() {
    const store = getNPCStore();
    const chatKey = getChatKey();
    if (!store[chatKey]) store[chatKey] = {};
    return store[chatKey];
}

/** Returns merged NPC objects: identity from __npcs + runtime data from chatStore */
function getNPCs() {
    const store = getNPCStore();
    const chatStore = getChatStore();
    const merged = {};
    for (const [name, npc] of Object.entries(store.__npcs)) {
        const runtime = chatStore[name] || {};
        merged[name] = {
            ...npc,
            events: runtime.events || [],
            permanentFacts: runtime.permanentFacts || [],
            lastLocation: runtime.lastLocation || null,
            pendingIntro: npc.pendingIntro ?? false,
            notes: npc.notes || '',
            lorebookDescription: npc.lorebookDescription || npc.description || '',
        };
    }
    return merged;
}

async function saveNPCs(npcs) {
    const s = getSettings();
    const botKey = getBotKey();
    const chatKey = getChatKey();
    if (!s.npcData) s.npcData = {};
    if (!s.npcData[botKey]) s.npcData[botKey] = { __npcs: {} };
    if (!s.npcData[botKey].__npcs) s.npcData[botKey].__npcs = {};
    if (!s.npcData[botKey][chatKey]) s.npcData[botKey][chatKey] = {};

    for (const [name, npc] of Object.entries(npcs)) {
        // Save identity (no events/facts/location)
        s.npcData[botKey].__npcs[name] = {
            name: npc.name,
            description: npc.description,
            notes: npc.notes || '',
            enabled: npc.enabled,
            searchKeys: npc.searchKeys || [],
            lorebookName: npc.lorebookName || '',
            lorebookDescription: npc.lorebookDescription || npc.description || '',
            entryUid: npc.entryUid ?? null,
            pendingIntro: npc.pendingIntro ?? false,
        };
        // Save runtime (events/facts/location) per chat
        s.npcData[botKey][chatKey][name] = {
            events: npc.events || [],
            permanentFacts: npc.permanentFacts || [],
            lastLocation: npc.lastLocation || null,
        };
    }
    saveSettingsDebounced();
}

/** Clear events+facts+location for all NPCs in current chat, keep identity */
async function deleteNPC(name) {
    const s = getSettings();
    const botKey = getBotKey();
    const chatKey = getChatKey();
    if (!s.npcData?.[botKey]) return;
    // Remove from identity store
    if (s.npcData[botKey].__npcs) delete s.npcData[botKey].__npcs[name];
    // Remove from all chat stores for this bot
    for (const ck of Object.keys(s.npcData[botKey])) {
        if (ck === '__npcs') continue;
        if (s.npcData[botKey][ck]?.[name]) delete s.npcData[botKey][ck][name];
    }
    saveSettingsDebounced();
}

async function clearChatData() {
    const s = getSettings();
    const botKey = getBotKey();
    const chatKey = getChatKey();
    if (s.npcData?.[botKey]?.[chatKey]) {
        delete s.npcData[botKey][chatKey];
    }
    saveSettingsDebounced();
}

// ── NPC entry detection ────────────────────────────────────

function getEntryPosition(entry) {
    const pos = entry.position ?? entry.extensions?.position ?? entry.insertion_position ?? null;
    if (pos === 0 || pos === 'before_char') return 'before_char';
    if (pos === 1 || pos === 'after_char')  return 'after_char';
    return null;
}

function isNPCEntry(entry, mode) {
    // mode: 'before_char' (default) or 'after_char'
    const pos = getEntryPosition(entry);
    if (mode === 'after_char') {
        return pos === 'after_char';
    }
    // default: before_char OR has 'character' keyword
    const keys = entry.key || entry.keys || [];
    const keyArr = Array.isArray(keys) ? keys : [keys];
    const hasCharKw = keyArr.some(k => typeof k === 'string' && k.toLowerCase().trim() === 'character');
    return pos === 'before_char' || hasCharKw;
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
    const s = getSettings();
    const mode = s.scanPosition || 'before_char';
    console.log('[WildOffscreen] Books found:', bookNames, '| scanPosition:', mode);

    const npcs = [];
    for (const bookName of bookNames) {
        const entries = await fetchBookEntries(bookName);
        console.log(`[WildOffscreen] "${bookName}": ${entries.length} entries`);
        for (const entry of entries) {
            if (!isNPCEntry(entry, mode)) continue;
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
    const s = getSettings();
    const mode = s.scanPosition || 'before_char';
    const found = [];
    for (const e of entries) {
        if (!e || typeof e !== 'object') continue;
        if (!isNPCEntry(e, mode)) continue;
        const info = extractNPCInfo(e, '');
        if (info) found.push(info);
    }
    return found;
}

function registerNPCs(scanned) {
    const npcs = getNPCs();
    let added = 0;
    for (const { name, description, searchKeys, lorebookName, entryUid } of scanned) {
        if (!npcs[name]) {
            npcs[name] = { name, description, lorebookDescription: description, notes: '', searchKeys: searchKeys || [], lorebookName: lorebookName || '', entryUid: entryUid ?? null, enabled: true, events: [], permanentFacts: [], pendingIntro: false };
            added++;
        } else {
            npcs[name].description = description;
            npcs[name].searchKeys = searchKeys || npcs[name].searchKeys || [];
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

async function callAPI(messages, npcCount) {
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
        max_tokens: Math.max(400, (npcCount || 4) * 120),
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

function getArchetypeForParams(params) {
    return pickArchetype(params.scale.id, params.category, params.isPositive) || 'something unexpected happened';
}

function getMainCharInfo() {
    try {
        const ctx = SillyTavern.getContext();

        // Bot character
        const char = ctx.characters?.[ctx.characterId];
        const botName = char?.name || '';
        const botDesc = [char?.description, char?.personality, char?.scenario]
            .filter(Boolean).join('\n').trim().slice(0, 2000);
        const botBlock = botName ? 'MAIN CHARACTER (bot): ' + botName + '\n' + botDesc : '';

        // User persona — ST exposes it via ctx.name1 (display name) and
        // ctx.personas / power_user.personas for the full description
        let userBlock = '';
        try {
            const userName = ctx.name1 || '';
            // Active persona description: try ctx.persona first, then power_user
            let userDesc = '';
            const pu = ctx.powerUser || window.power_user || {};
            if (pu.personas && pu.active_persona) {
                const activePersona = pu.personas[pu.active_persona];
                if (activePersona?.description) userDesc = activePersona.description.trim().slice(0, 1000);
            }
            // Fallback: some ST versions expose it directly
            if (!userDesc && ctx.persona) userDesc = String(ctx.persona).trim().slice(0, 1000);

            if (userName || userDesc) {
                userBlock = 'USER CHARACTER: ' + (userName || 'User')
                    + (userDesc ? '\n' + userDesc : '');
            }
        } catch(e) { /* persona not available */ }

        return [botBlock, userBlock].filter(Boolean).join('\n\n');
    } catch (e) { return ''; }
}

// ── Date normalization ────────────────────────────────────────────────────

const MONTH_MAP = {
    // Russian
    'январь':1,'января':1,'jan':1,'january':1,
    'февраль':2,'февраля':2,'feb':2,'february':2,
    'март':3,'марта':3,'mar':3,'march':3,
    'апрель':4,'апреля':4,'apr':4,'april':4,
    'май':5,'мая':5,'may':5,
    'июнь':6,'июня':6,'jun':6,'june':6,
    'июль':7,'июля':7,'jul':7,'july':7,
    'август':8,'августа':8,'aug':8,'august':8,
    'сентябрь':9,'сентября':9,'sep':9,'september':9,
    'октябрь':10,'октября':10,'oct':10,'october':10,
    'ноябрь':11,'ноября':11,'nov':11,'november':11,
    'декабрь':12,'декабря':12,'dec':12,'december':12,
};

/**
 * Normalize a raw date string that may have word months.
 * "2008/Ноябрь/12" → "2008/11/12"
 * "2008/11/12" → unchanged
 */
function normalizeDateStr(str) {
    if (!str) return str;
    return str.replace(
        /(\d{4})[\/]([Ѐ-ӿa-zA-Z]+)[\/](\d{1,2})/g,
        (_, year, month, day) => {
            const num = MONTH_MAP[month.toLowerCase()];
            if (!num) return _;
            return year + '/' + String(num).padStart(2, '0') + '/' + String(day).padStart(2, '0');
        }
    );
}

/** Test if a string contains any date-like pattern (numeric or word month) */
function hasDatePattern(str) {
    if (!str) return false;
    if (/\d{4}\/\d{2}\/\d{2}/.test(str)) return true;
    // word month: 2008/Ноябрь/12 or 2008/November/12
    return /(\d{4})[\/]([Ѐ-ӿa-zA-Z]{3,})[\/](\d{1,2})/.test(str);
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
        const lastMsg = [...chat].reverse().find(m => m.mes && hasDatePattern(m.mes));
        if (!lastMsg) return null;

        let raw = null;
        // Try styled div first
        const divMatch = lastMsg.mes.match(/<div[^>]+border-left[^>]*?>([\s\S]*?)<\/div>/i);
        if (divMatch) {
            const inner = normalizeDateStr(divMatch[1].replace(/<[^>]+>/g, '').trim());
            if (/\d{4}\/\d{2}\/\d{2}/.test(inner)) raw = inner;
        }
        // Fallback: strip all tags and grab the first line with a date
        if (!raw) {
            const stripped = normalizeDateStr(lastMsg.mes.replace(/<[^>]+>/g, ''));
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

// ── Infoblock-based NPC scene detection ───────────────────────────────────

/**
 * Parse characters list from a single message's infoblock.
 * Returns array of character names, or [] if no infoblock found.
 */
function parseInfoblockChars(mes) {
    if (!mes || !hasDatePattern(mes)) return [];
    try {
        let raw = null;
        const divMatch = mes.match(/<div[^>]+border-left[^>]*?>([\s\S]*?)<\/div>/i);
        if (divMatch) {
            raw = normalizeDateStr(divMatch[1].replace(/<[^>]+>/g, '').trim());
        }
        if (!raw) {
            const stripped = normalizeDateStr(mes.replace(/<[^>]+>/g, ''));
            const lineMatch = stripped.match(/.*\d{4}\/\d{2}\/\d{2}.*/);
            if (lineMatch) raw = lineMatch[0].trim();
        }
        if (!raw) return [];
        const parts = raw.split(/\s*[\u2022•]\s*/);
        // parts[3] = characters
        const charPart = (parts[3] || '').trim();
        return charPart ? charPart.split(',').map(s => s.trim()).filter(Boolean) : [];
    } catch(e) { return []; }
}

/**
 * Check if an NPC appears in a message's infoblock character list.
 * Exact match or infoblock name contains NPC name (handles full name vs surname).
 */
function npcInInfoblock(npc, mes) {
    const chars = parseInfoblockChars(mes);
    if (!chars.length) return false;
    const npcLower = npc.name.toLowerCase();
    return chars.some(c => {
        const cl = c.toLowerCase().trim();
        return cl === npcLower || cl.includes(npcLower);
    });
}

// ── Chat context ───────────────────────────────────────────

function getChatContextForNPC(npc, maxMessages = 30, maxCharsPerMsg = 3000) {
    const npcObj = typeof npc === 'string' ? { name: npc } : npc;
    const npcName = npcObj.name;

    try {
        const ctx = SillyTavern.getContext();
        const chat = ctx.chat || [];
        const nonSystem = chat.filter(m => !m.is_system && m.mes);

        // Find messages where this NPC appears in the infoblock character list
        const withNPC = nonSystem.filter(m => npcInInfoblock(npcObj, m.mes));

        let selected;
        if (withNPC.length > 0) {
            // Use messages where NPC was in scene (most relevant context)
            selected = withNPC.slice(-maxMessages);
        } else {
            // Fallback: last N messages (NPC has no scene appearances yet)
            selected = nonSystem.slice(-maxMessages);
        }

        const cleanMsg = (m) => m.mes.replace(/<[^>]+>/g, '').trim();
        const text = selected
            .map(m => (m.is_user ? '[User]' : '[Bot]') + ' ' + cleanMsg(m).slice(0, maxCharsPerMsg).trim())
            .join('\n');

        return { text, debug: { npc: npcName, sceneAppearances: withNPC.length, usedMessages: selected.length, fallback: withNPC.length === 0 } };
    } catch (e) {
        console.warn('[WildOffscreen] getChatContextForNPC error:', e.message);
        return { text: '', debug: { npc: npcName, error: e.message } };
    }
}

// ── Prompt building ────────────────────────────────────────

// Pick a random archetype from the pool for this NPC's event
function pickArchetype(scaleId, category, isPositive) {
    const pool = EVENT_POOLS[scaleId]?.[category];
    if (!pool) return null;
    const list = isPositive ? pool.positive : pool.negative;
    return list[Math.floor(Math.random() * list.length)];
}

const SCALE_GUIDANCE = {
    'minor':   'MINOR — a small, forgettable moment. Everyday life. Nothing changes permanently.',
    'notable': 'NOTABLE — a real shift in their week or situation. Something they will remember. Actual change, not just a mood.',
    'major':   'MAJOR — life-altering. Irreversible or deeply significant. Health, relationships, livelihood, identity. NOT a slightly unusual day.',
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
        const historyEvents = npc.events.slice(-7);
        const history = historyEvents.length
            ? historyEvents.map((e, hi) => {
                const prefix = hi === historyEvents.length - 1 ? '  [latest] ' : '  [' + (hi + 1) + '] ';
                return prefix + e.text;
            }).join('\n')
            : 'None yet.';
        const impact = params.isPositive ? 'POSITIVE' : 'NEGATIVE';
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

        const notesBlock = npc.notes ? 'CURRENT NOTES (override lorebook if contradicts): ' + npc.notes + '\n' : '';

        console.log('[WildOffscreen] NPC', npc.name, '→', inScene ? '[IN SCENE]' : '[OFFSCREEN]');
        return '--- NPC ' + (i + 1) + ': ' + npc.name + (inScene ? ' [IN SCENE]' : ' [OFFSCREEN]') + ' ---\n'
            + 'DESCRIPTION: ' + npc.description.slice(0, 3000) + '\n'
            + notesBlock
            + (lastLoc ? 'LAST KNOWN LOCATION: ' + npc.lastLocation + '\n' : '')
            + 'PERMANENT FACTS (always true, never contradict these): ' + (facts.length ? '\n' + factsBlock : 'None.') + '\n'
            + 'OFFSCREEN HISTORY (chronological, [latest] is most recent):\n'
            + history + '\n'
            + 'Use this as continuity context — build naturally on what has already happened. Do not repeat the same events or themes.\n'
            + 'MENTIONS IN STORY (for context): ' + (npcContext || 'none') + '\n'
            + (inScene
                ? 'STATUS: THIS CHARACTER IS CURRENTLY IN THE ACTIVE SCENE. DO NOT generate offscreen events.'
                : 'EVENT ARCHETYPE: ' + getArchetypeForParams(params) + '\n'
                    + 'SCALE: ' + SCALE_GUIDANCE[params.scale.id] + '\n'
                    + 'TONE: ' + impact + ' — must feel ' + (params.isPositive ? 'like a gain, relief, or something opening up.' : 'like a loss, setback, or something closing down.') + '\n'
                    + 'Write ONE sentence (15-30 words) that applies this archetype to THIS specific character — their personality, situation, relationships, and context. Be concrete and specific to them, not generic.');
    }).join('\n\n');

    // Build pending intro instructions for manually added NPCs
    const pendingIntros = npcList.filter(item => item.npc.pendingIntro);
    let introBlock = '';
    if (pendingIntros.length > 0) {
        const names = pendingIntros.map(item => item.npc.name).join(', ');
        introBlock = '=== PENDING NPC INTRODUCTION ===\n'
            + 'The following NPC(s) need to be introduced into the story: ' + names + '.\n'
            + 'This does NOT mean right now in this generation. It means: at the next naturally fitting moment in the narrative — when the scene, location, or situation makes their appearance believable and unforced — weave them in organically. Do not force it if the moment is wrong. Match the setting and tone.\n'
            + '===\n\n';
    }

    // Build scene context header from parsed info-block
    let sceneHeader = '';
    if (sceneInfo) {
        const inSceneNames = sceneInfo.characters.length
            ? sceneInfo.characters.join(', ')
            : 'unknown';
        const timeOfDay = sceneInfo.time
            ? (parseInt(sceneInfo.time) < 6 ? 'night' : parseInt(sceneInfo.time) < 12 ? 'morning' : parseInt(sceneInfo.time) < 18 ? 'afternoon' : parseInt(sceneInfo.time) < 22 ? 'evening' : 'night')
            : null;
        sceneHeader = '=== ACTIVE SCENE INFO (from story header) ===\n'
            + 'Date: ' + sceneInfo.date + (sceneInfo.time ? ' | Time: ' + sceneInfo.time + (timeOfDay ? ' (' + timeOfDay + ')' : '') : '') + '\n'
            + 'Current location: ' + (sceneInfo.location || 'unknown') + '\n'
            + 'Characters PRESENT in this scene: ' + inSceneNames + '\n'
            + 'These characters are actively participating in the scene right now and must receive "No offscreen events. Currently in scene." with their current location.\n'
            + (timeOfDay ? 'NOTE: It is currently ' + timeOfDay + '. Generated events must be plausible for this time of day.\n' : '')
            + '===\n\n';
    }

    const userContent = (mainCharInfo ? mainCharInfo + '\n\n' : '')
        + introBlock
        + sceneHeader
        + 'CURRENT STORY CONTEXT:\n' + (sharedChatContext || 'none') + '\n\n'
        + npcBlocks + '\n\n'
        + 'For each NPC above:\n'
        + '- If marked [IN SCENE]: write exactly: "[current scene location] | in-scene | No offscreen events. Currently in scene."\n'
        + '- If marked [OFFSCREEN]: adapt the EVENT ARCHETYPE to this specific character and write ONE concrete sentence (15-30 words).\n'
        + 'Requirements for [OFFSCREEN] NPCs:\n'
        + '- Apply the archetype to their specific personality, relationships, and situation — not generically\n'
        + '- Match the SCALE (minor = trivial moment, notable = real shift in their situation, major = life-altering and irreversible)\n'
        + '- Match the TONE (positive = something opens up or improves, negative = something closes down or hurts)\n'
        + '- Do NOT start with their name. No dialogue. No poetic language.\n\n'
        + 'Also self-report: a short location (1-5 words) and the actual scale of what you wrote (minor/notable/major).\n\n'
        + 'Respond with ONLY this format, one line per NPC:\n'
        + npcList.map((item, i) => 'NPC' + (i + 1) + ': [location] | [minor/notable/major] | [event sentence]').join('\n') + '\n'
        + 'Example offscreen: NPC1: городской рынок | minor | Bargained longer than usual over fabric and left without buying anything.\n'
        + 'Example major: NPC2: больница | major | Was told the results came back positive and sat in the corridor for an hour unable to move.\n'
        + 'Example in-scene: NPC3: Тюменское ГУВД, кабинет Парфёнова | in-scene | No offscreen events. Currently in scene.\n'
        + 'IMPORTANT: exactly three pipe-separated fields per line. No extra text after the sentence.';

    console.log('[WildOffscreen] Batch prompt for', npcList.length, 'NPCs, userContent length:', userContent.length);

    return [
        {
            role: 'system',
            content: 'You write brief offscreen event summaries for supporting characters in a collaborative story. '
                + 'You are given the main bot character, the user character (player), and a list of NPCs. '
                + 'NPCs are secondary characters whose lives continue offscreen while the main scene unfolds. '
                + (LANGUAGE_INSTRUCTION[getSettings().outputLanguage] || LANGUAGE_INSTRUCTION.en) + ' '
                + 'Dry, specific, one sentence per character. No names at sentence start. No dialogue. No poetic language. '
                + 'RULE 1: Each NPC is marked [IN SCENE] or [OFFSCREEN]. '
                + '[IN SCENE] = write exactly: "location | in-scene | No offscreen events. Currently in scene." '
                + '[OFFSCREEN] = adapt the EVENT ARCHETYPE to this specific character and write one concrete sentence. '
                + 'RULE 2: The archetype is a direction, not a script. Translate it into something specific to this person — their life, job, relationships, habits, fears. '
                + 'RULE 3: Scale is self-reported by you in the second field. Be honest — if what you wrote is minor, say minor. If it is genuinely life-altering, say major. Do not inflate or deflate. '
                + 'RULE 4: Use OFFSCREEN HISTORY as continuity — the new event should feel like a natural next step in this character\'s ongoing life. Do not repeat themes or actions verbatim, but cause-and-effect is welcome. '
                + 'RULE 5: Exactly three pipe-separated fields per line. Nothing else.',
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

        // Strip any trailing model metadata
        raw = raw.replace(/\s*\*\(Scale:[^)]*\)\*/g, '').trim();
        raw = raw.replace(/\s*\[OFFSCREEN\]|\s*\[IN SCENE\]/gi, '').trim();

        // Split on pipes — expect: location | scale | sentence
        const pipes = raw.split('|').map(p => p.trim());

        let location = 'unknown';
        let reportedScale = null;
        let sentence = raw;

        if (pipes.length >= 3) {
            location = pipes[0] || 'unknown';
            const scalePart = pipes[1].toLowerCase();
            if (/in-scene|in scene/.test(scalePart)) {
                results.push({ location, text: pipes.slice(2).join('|').trim(), inScene: true, reportedScale: 'in-scene' });
                continue;
            }
            reportedScale = /\bminor\b/.test(scalePart) ? 'minor'
                          : /\bnotable\b/.test(scalePart) ? 'notable'
                          : /\bmajor\b/.test(scalePart) ? 'major'
                          : null;
            sentence = pipes.slice(2).join('|').trim();
        } else if (pipes.length === 2) {
            // Fallback: old 2-field format location | sentence
            location = pipes[0];
            sentence = pipes[1];
        }

        // Detect in-scene by text even if format was off
        if (/no offscreen events|currently in scene/i.test(sentence)) {
            results.push({ location, text: sentence, inScene: true, reportedScale: 'in-scene' });
            continue;
        }

        // Take only first sentence
        const first = sentence.match(/^[^.!?]+[.!?]/);
        if (first && first[0].length > 10) sentence = first[0].trim();

        results.push(sentence.length >= 10 ? { location, text: sentence, inScene: false, reportedScale } : null);
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
            const lastMsgWithTime = [...chat].reverse().find(m => m.mes && hasDatePattern(m.mes));
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

    const sceneInfo = parseSceneInfo();
    const storyDate = sceneInfo ? [sceneInfo.date, sceneInfo.time].filter(Boolean).join(' ') : null;
    const sceneCharsForFilter = (sceneInfo && Array.isArray(sceneInfo.characters)) ? sceneInfo.characters : [];

    // Skip in-scene NPCs entirely — no need to send them to API
    const isInSceneCheck = (npc) => sceneCharsForFilter.some(c => {
        if (!c || typeof c !== 'string') return false;
        const cl = c.toLowerCase().trim();
        const nl = npc.name.toLowerCase();
        const sk = Array.isArray(npc.searchKeys) ? npc.searchKeys : [];
        return cl === nl || cl.includes(nl) || sk.some(k => k && typeof k === 'string' && cl.includes(k.toLowerCase()));
    });

    const offscreenKeys = keys.filter(k => !isInSceneCheck(npcs[k]));
    const skippedInScene = keys.filter(k => isInSceneCheck(npcs[k]));
    if (skippedInScene.length) console.log('[WildOffscreen] Skipping in-scene NPCs (no API call):', skippedInScene);

    if (!offscreenKeys.length) {
        console.log('[WildOffscreen] All NPCs in scene, nothing to generate.');
        return;
    }

    const npcList = offscreenKeys.map(k => ({ npc: npcs[k], key: k, params: rollEventParams() }));

    const messages = buildBatchMessages(npcList, mainCharInfo, sharedChat, sceneInfo);
    const rawText = await callAPI(messages, npcList.length);
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

        // NPC is currently in scene — do not create an event, just log
        if (result.inScene) {
            console.log('[WildOffscreen]', npc.name, 'is in scene — skipping event creation');
            continue;
        }

        const event = {
            text: result.text,
            location: result.location,
            scale: result.reportedScale || params.scale.id,
            category: params.category,
            positive: params.isPositive,
            timestamp: Date.now(),
            storyDate: storyDate || null,
        };

        npc.events.push(event);
        if (npc.events.length > s.maxEvents) npc.events = npc.events.slice(-s.maxEvents);

        // Auto-promote if model self-reported this as MAJOR
        if (!npc.permanentFacts) npc.permanentFacts = [];
        if (result.reportedScale === 'major') {
            const alreadyStored = npc.permanentFacts.some(f => f.text === result.text);
            if (!alreadyStored) {
                npc.permanentFacts.push({
                    text: result.text,
                    category: params.category,
                    positive: params.isPositive,
                    timestamp: Date.now(),
                    storyDate: storyDate || null,
                    auto: true,
                });
                console.log('[WildOffscreen] Auto-promoted self-reported MAJOR to permanentFacts:', npc.name);
            }
        }

        // Update last known location only for offscreen NPCs
        if (result.location && result.location !== 'unknown') {
            npc.lastLocation = result.location;
        }

        console.log('[WildOffscreen] Event for', npc.name, '@', result.location, ':', result.text);
    }
}

async function generateForSingleNPC(npcName) {
    if (isGenerating) { toastr.warning('Already generating, please wait.'); return; }
    const npcs = getNPCs();
    const npc = npcs[npcName];
    if (!npc || !npc.enabled) return;

    isGenerating = true;
    $('#wo_status').text('Generating for ' + npcName + '…').show();

    try {
        const sceneInfo = parseSceneInfo();
        const storyDate = sceneInfo ? [sceneInfo.date, sceneInfo.time].filter(Boolean).join(' ') : null;
        const sceneCharsForFilter = (sceneInfo && Array.isArray(sceneInfo.characters)) ? sceneInfo.characters : [];
        const inScene = sceneCharsForFilter.some(c => {
            if (!c || typeof c !== 'string') return false;
            const cl = c.toLowerCase().trim();
            return cl === npcName.toLowerCase() || cl.includes(npcName.toLowerCase());
        });

        if (inScene) { toastr.info(npcName + ' is currently in scene — no offscreen events.'); return; }

        const mainCharInfo = getMainCharInfo();
        const sharedChat = (() => {
            try {
                const ctx = SillyTavern.getContext();
                const s = getSettings();
                return (ctx.chat || [])
                    .filter(m => !m.is_system && m.mes)
                    .slice(-s.maxMessages)
                    .map(m => (m.is_user ? '[User]' : '[Bot]') + ' ' + m.mes.replace(/<[^>]+>/g, '').trim().slice(0, s.maxCharsPerMsg))
                    .join('\n');
            } catch(e) { return ''; }
        })();

        const params = rollEventParams();
        const npcList = [{ npc, key: npcName, params }];
        const messages = buildBatchMessages(npcList, mainCharInfo, sharedChat, sceneInfo);
        const rawText = await callAPI(messages, 1);
        if (!rawText) { toastr.error('No response from API.'); return; }

        const parsed = parseBatchResponse(rawText, 1);
        const result = parsed[0];
        if (!result || result.inScene) { toastr.warning('No event generated.'); return; }

        const s = getSettings();
        const event = {
            text: result.text,
            location: result.location,
            scale: result.reportedScale || params.scale.id,
            category: params.category,
            positive: params.isPositive,
            timestamp: Date.now(),
            storyDate: storyDate || null,
        };
        npc.events.push(event);
        if (npc.events.length > s.maxEvents) npc.events = npc.events.slice(-s.maxEvents);
        if (!npc.permanentFacts) npc.permanentFacts = [];
        if (result.reportedScale === 'major') {
            if (!npc.permanentFacts.some(f => f.text === result.text)) {
                npc.permanentFacts.push({ text: result.text, category: params.category, positive: params.isPositive, timestamp: Date.now(), storyDate: storyDate || null, auto: true });
            }
        }
        if (result.location && result.location !== 'unknown') npc.lastLocation = result.location;

        const allNpcs = getNPCs();
        allNpcs[npcName] = npc;
        await saveNPCs(allNpcs);
        renderNPCList();
        updateInjection();
        toastr.success('Event generated for ' + npcName + '.');
    } catch(e) {
        toastr.error('Error: ' + e.message);
    } finally {
        isGenerating = false;
        $('#wo_status').text('').hide();
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
    const s2 = getSettings();
    const activeIntros = s2.activeIntros || {};
    const npcsAll = Object.values(npcs);

    // Strong one-shot intro (button was pressed)
    const activeIntroNames = npcsAll.filter(n => n.pendingIntro && activeIntros[n.name]).map(n => n.name);
    // Passive background intro (just exists, waiting)
    const passiveIntroNames = npcsAll.filter(n => n.pendingIntro && !activeIntros[n.name]).map(n => n.name);

    let introNote = '';
    if (activeIntroNames.length) {
        introNote += '\n[INTRODUCE NOW: ' + activeIntroNames.join(', ') + ' — this character should appear in the current scene. Find a natural, unforced way to bring them in that fits the setting and current situation. Do not make it awkward or abrupt.]';
    }
    if (passiveIntroNames.length) {
        introNote += '\n[PENDING: ' + passiveIntroNames.join(', ') + ' — exists in this world, introduce naturally when the moment fits.]';
    }

    return '[OFF-SCREEN NPC UPDATES — use when character enters scene. Do NOT generate this block yourself.]\n'
        + lines.join('\n') + '\n[/OFF-SCREEN NPC UPDATES]'
        + introNote;
}

function estimateTokens(text) {
    // Rough estimate: ~4 chars per token for mixed Russian/English
    return Math.ceil(text.length / 4);
}

function updateInjection() {
    const s = getSettings();
    const text = s.enabled ? buildInjectionText(getNPCs(), s.injectMaxMessages) : '';
    setExtensionPrompt(EXT, text, INJECTION_POSITION, 0, false, 0);
    // Update token counter in UI
    const tokens = text ? estimateTokens(text) : 0;
    $('#wo_token_count').text(tokens > 0 ? '~' + tokens + ' tokens injected' : 'nothing injected');
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
            // Reroll detected — generation will be triggered by CHARACTER_MESSAGE_RENDERED
            // after the new message arrives. Just force the counter here.
            msgCounter = s.triggerEvery;
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
                <span class="wo_npc_name">${npc.name}${npc.pendingIntro ? ' <span class="wo_intro_badge">NEW</span>' : ''}</span>
                <span class="wo_npc_count">${npc.lastLocation ? '<i class="fa-solid fa-location-dot" style="font-size:0.8em;margin-right:3px;"></i>' : ''}${count} event${count !== 1 ? 's' : ''}</span>
                <div class="wo_npc_actions">
                    ${npc.pendingIntro ? '<button class="wo_btn_introduce menu_button wo_btn_introduce_pulse" title="Introduce into scene"><i class="fa-solid fa-door-open"></i></button>' : ''}
                    <button class="wo_btn_gen_one menu_button" title="Generate event for this NPC only"><i class="fa-solid fa-bolt"></i></button>
                    <button class="wo_btn_toggle menu_button">${npc.enabled ? '<i class="fa-solid fa-pause"></i>' : '<i class="fa-solid fa-play"></i>'}</button>
                    <button class="wo_btn_clear menu_button" title="Clear events"><i class="fa-solid fa-trash-can"></i></button>
                    <button class="wo_btn_delete menu_button" title="Remove NPC"><i class="fa-solid fa-xmark"></i></button>
                </div>
            </div>
            <div class="wo_npc_events" style="display:none;"></div>
        </div>`);
        const evContainer = card.find('.wo_npc_events');


        if (npc.lastLocation) {
            evContainer.append('<div class="wo_npc_location"><i class="fa-solid fa-location-dot"></i> ' + npc.lastLocation + '</div>');
        }

        // Notes field
        const notesVal = npc.notes || '';
        const notesRow = $('<div class="wo_notes_row"></div>');
        const notesInput = $('<textarea class="wo_notes_input text_pole" placeholder="Notes (always sent to AI)..." rows="2"></textarea>').val(notesVal);
        let notesTimer = null;
        notesInput.on('input', function() {
            clearTimeout(notesTimer);
            notesTimer = setTimeout(async () => {
                const s = getSettings();
                const botKey = getBotKey();
                if (s.npcData?.[botKey]?.__npcs?.[key]) {
                    s.npcData[botKey].__npcs[key].notes = notesInput.val().trim();
                    saveSettingsDebounced();
                }
            }, 600);
        });
        notesRow.append(notesInput);
        evContainer.append(notesRow);

        // Edit description
        const hasCustomDesc = npc.lorebookDescription && npc.description !== npc.lorebookDescription;
        const descRow = $('<div class="wo_desc_row"></div>');
        const descToggle = $('<button class="wo_btn_desc_edit menu_button" style="width:100%;font-size:0.8em;margin-bottom:4px;opacity:0.6;"><i class="fa-solid fa-pen-to-square"></i> ' + (hasCustomDesc ? 'Description (edited)' : 'Edit description') + '</button>');
        const descArea = $('<textarea class="wo_desc_input text_pole" rows="4" style="display:none;resize:vertical;"></textarea>').val(npc.description);
        const descActions = $('<div style="display:none;gap:4px;" class="wo_actions wo_desc_actions"></div>');
        const descSave = $('<button class="menu_button" style="flex:1;font-size:0.8em;"><i class="fa-solid fa-floppy-disk"></i> Save</button>');
        const descReset = $('<button class="menu_button" style="flex:1;font-size:0.8em;opacity:0.6;" title="Restore lorebook description"><i class="fa-solid fa-rotate-left"></i> Reset</button>');
        descActions.append(descSave).append(descReset);
        descToggle.on('click', () => { descArea.slideToggle(100); descActions.slideToggle(100); });
        descSave.on('click', async () => {
            const s = getSettings();
            const botKey = getBotKey();
            if (s.npcData?.[botKey]?.__npcs?.[key]) {
                s.npcData[botKey].__npcs[key].description = descArea.val().trim();
                saveSettingsDebounced();
                renderNPCList();
                toastr.success('Description saved.');
            }
        });
        descReset.on('click', async () => {
            const s = getSettings();
            const botKey = getBotKey();
            if (s.npcData?.[botKey]?.__npcs?.[key]) {
                const lb = s.npcData[botKey].__npcs[key].lorebookDescription || '';
                s.npcData[botKey].__npcs[key].description = lb;
                saveSettingsDebounced();
                renderNPCList();
                toastr.success('Description reset to lorebook.');
            }
        });
        descRow.append(descToggle).append(descArea).append(descActions);
        evContainer.append(descRow);

        // ── Permanent facts section ──────────────────────────────
        const facts = Array.isArray(npc.permanentFacts) ? npc.permanentFacts : [];
        if (facts.length) {
            evContainer.append('<div style="font-size:0.78em;font-weight:700;opacity:0.6;text-transform:uppercase;letter-spacing:0.05em;margin: 6px 0 3px 0;"><i class="fa-solid fa-thumbtack"></i> Permanent facts</div>');
            facts.forEach((fact, fi) => {
                const fcolor = fact.positive ? '#66bb6a' : '#ef5350';
                const autoTag = '';
                const fRow = $(`
                    <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:6px;margin-bottom:4px;padding:4px 6px;border-radius:3px;background:color-mix(in srgb, var(--SmartThemeQuoteColor) 8%, transparent);border-left:2px solid color-mix(in srgb, var(--SmartThemeQuoteColor) 40%, transparent);">
                        <div style="flex:1;font-size:0.82em;">
                            <span style="color:${fcolor};font-weight:600;">${fact.positive ? '<i class="fa-solid fa-caret-up"></i>' : '<i class="fa-solid fa-caret-down"></i>'} ${fact.category || ''}${autoTag}${fact.storyDate ? ' <span style="opacity:0.4;font-weight:400;font-size:0.85em;">· ' + fact.storyDate + '</span>' : ''}</span>
                            <div style="opacity:0.9;line-height:1.4;">${fact.text}</div>
                        </div>
                        <button class="wo_btn_delete_fact menu_button" data-fidx="${fi}" title="Remove permanent fact" style="padding:0px 4px;font-size:0.75em;min-width:unset;opacity:0.4;"><i class="fa-solid fa-xmark"></i></button>
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
                evContainer.append('<div style="font-size:0.78em;font-weight:700;opacity:0.6;text-transform:uppercase;letter-spacing:0.05em;margin: 8px 0 3px 0;"><i class="fa-solid fa-clock-rotate-left"></i> Recent events</div>');
            }
            const reversedEvents = [...npc.events].reverse();
            for (let i = 0; i < reversedEvents.length; i++) {
                const ev = reversedEvents[i];
                const originalIndex = npc.events.length - 1 - i;
                const color = ev.positive ? '#66bb6a' : '#ef5350';
                const locTag = ev.location && ev.location !== 'unknown'
                    ? '<span class="wo_event_loc"><i class="fa-solid fa-location-dot"></i> ' + ev.location + '</span>'
                    : '';
                const evText = typeof ev.text === 'string' ? ev.text : String(ev.text?.text || ev.text || '');
                const isMajor = ev.scale === 'major';
                const alreadyFact = facts.some(f => f.text === evText);

                const evRow = $(`
                    <div class="wo_event" style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px;margin-bottom:6px;">
                        <div style="flex:1;">
                            <span class="wo_event_meta" style="color:${color}">${ev.positive ? '<i class="fa-solid fa-caret-up"></i>' : '<i class="fa-solid fa-caret-down"></i>'} ${ev.scale.toUpperCase()} · ${ev.category}${isMajor ? ' <i class="fa-solid fa-star" style="font-size:0.8em;color:#ffa726;"></i>' : ''}${ev.storyDate ? ' <span style="opacity:0.45;font-weight:400;font-size:0.9em;">· ' + ev.storyDate + '</span>' : ''}</span>
                            ${locTag}
                            <div class="wo_event_text">${evText}</div>
                        </div>
                        <div style="display:flex;flex-direction:column;gap:2px;flex-shrink:0;">
                            ${alreadyFact ? '' : '<button class="wo_btn_promote_event menu_button" data-idx="' + originalIndex + '" title="Save as permanent fact" style="padding:0px 4px;font-size:0.75em;min-width:unset;opacity:0.55;"><i class=\"fa-solid fa-thumbtack\"></i></button>'}
                            <button class="wo_btn_delete_event menu_button" data-idx="${originalIndex}" title="Delete this event" style="padding:0px 4px;font-size:0.75em;min-width:unset;opacity:0.4;"><i class="fa-solid fa-xmark"></i></button>
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
                        storyDate: ev.storyDate || null,
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
        card.find('.wo_btn_gen_one').on('click', async (e) => {
            e.stopPropagation();
            await generateForSingleNPC(key);
        });

        card.find('.wo_btn_introduce').on('click', async (e) => {
            e.stopPropagation();
            const s = getSettings();
            const botKey = getBotKey();
            if (!s.npcData?.[botKey]?.__npcs?.[key]) return;
            const npcData = s.npcData[botKey].__npcs[key];
            // One-shot: inject a strong intro instruction into the next generation
            // Store it so buildInjectionText can pick it up
            if (!s.activeIntros) s.activeIntros = {};
            s.activeIntros[key] = true;
            saveSettingsDebounced();
            toastr.info(`Introduction cued for ${key}. It will happen at the next fitting moment.`);
            renderNPCList();
        });

        card.find('.wo_btn_toggle').on('click', async () => {
            const s = getSettings();
            const botKey = getBotKey();
            if (s.npcData?.[botKey]?.__npcs?.[key]) {
                s.npcData[botKey].__npcs[key].enabled = !s.npcData[botKey].__npcs[key].enabled;
                saveSettingsDebounced();
                renderNPCList(); updateInjection();
            }
        });
        card.find('.wo_btn_clear').on('click', async () => {
            if (!confirm(`Clear all events for ${key}?`)) return;
            const s = getSettings();
            const botKey = getBotKey();
            const chatKey = getChatKey();
            if (s.npcData?.[botKey]?.[chatKey]?.[key]) {
                s.npcData[botKey][chatKey][key].events = [];
                s.npcData[botKey][chatKey][key].permanentFacts = [];
                s.npcData[botKey][chatKey][key].lastLocation = null;
                saveSettingsDebounced();
            }
            renderNPCList(); updateInjection();
        });
        card.find('.wo_btn_delete').on('click', async () => {
            if (!confirm(`Remove ${key} from tracking?`)) return;
            await deleteNPC(key);
            renderNPCList(); updateInjection();
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
            <div id="wo_token_count" class="wo_status" style="opacity:0.5;font-style:normal;font-size:0.78em;"></div>

            <!-- ── Section: Characters ── -->
            <div class="wo_accordion">
                <div class="wo_accordion_header" data-target="wo_sec_chars">
                    <span><i class="fa-solid fa-users"></i> Characters</span>
                    <i class="fa-solid fa-chevron-down wo_acc_icon"></i>
                </div>
                <div class="wo_accordion_body" id="wo_sec_chars">
                    <div class="wo_section_label" style="margin-top:6px;">Current Story Date</div>
                    <div id="wo_date_display">—</div>

                    <div id="wo_npc_list" class="wo_npc_list"></div>

                    <div class="wo_actions" style="margin-top:6px;">
                        <button id="wo_generate_now" class="menu_button"><i class="fa-solid fa-bolt"></i> Generate Now</button>
                        <button id="wo_scan" class="menu_button"><i class="fa-solid fa-magnifying-glass"></i> Scan Lorebook</button>
                    </div>
                    <div class="wo_actions" style="margin-top:4px;">
                        <button id="wo_clear_all_events" class="menu_button"><i class="fa-solid fa-eraser"></i> Clear All Events</button>
                        <button id="wo_delete_all_npcs" class="menu_button wo_btn_danger"><i class="fa-solid fa-trash-can"></i> Remove All</button>
                    </div>
                </div>
            </div>

            <!-- ── Section: Lorebook & Tokens ── -->
            <div class="wo_accordion">
                <div class="wo_accordion_header" data-target="wo_sec_lore">
                    <span><i class="fa-solid fa-book"></i> Lorebook & Context</span>
                    <i class="fa-solid fa-chevron-down wo_acc_icon"></i>
                </div>
                <div class="wo_accordion_body" id="wo_sec_lore" style="display:none;">
                    <div id="wo_book_info" class="wo_book_info" style="margin-top:6px;">—</div>
                    <label style="margin-top:4px;"><small>Scan entries at position</small></label>
                    <select id="wo_scan_position" class="text_pole" style="margin-bottom:6px;">
                        <option value="before_char">before_char</option>
                        <option value="after_char">after_char</option>
                    </select>
                    <div class="wo_section_label">Token Context</div>
                    <label><small>Messages history depth</small></label>
                    <input type="number" id="wo_max_messages" class="text_pole" value="${s.maxMessages || 30}" />
                    <label><small>Max characters per message</small></label>
                    <input type="number" id="wo_max_chars" class="text_pole" value="${s.maxCharsPerMsg || 2000}" />
                    <div class="wo_section_label">Generation</div>
                    <label><small>Generate events every N messages (counts both bot and user messages)</small></label>
                    <input type="number" id="wo_trigger_every" class="text_pole" value="${s.triggerEvery}" />
                    <label><small>Max stored events per NPC</small></label>
                    <input type="number" id="wo_max_events" class="text_pole" value="${s.maxEvents}" />
                </div>
            </div>

            <!-- ── Section: Add NPC ── -->
            <div class="wo_accordion">
                <div class="wo_accordion_header" data-target="wo_sec_add">
                    <span><i class="fa-solid fa-user-plus"></i> Add NPC manually</span>
                    <i class="fa-solid fa-chevron-down wo_acc_icon"></i>
                </div>
                <div class="wo_accordion_body" id="wo_sec_add" style="display:none;">
                    <input type="text" id="wo_manual_name" class="text_pole" placeholder="Name" style="margin-top:6px;margin-bottom:4px;" />
                    <textarea id="wo_manual_desc" class="text_pole" placeholder="Description (optional)" rows="3" style="resize:vertical;margin-bottom:4px;"></textarea>
                    <button id="wo_manual_add" class="menu_button" style="width:100%;"><i class="fa-solid fa-user-plus"></i> Add NPC</button>
                </div>
            </div>

            <!-- ── Section: API ── -->
            <div class="wo_accordion">
                <div class="wo_accordion_header" data-target="wo_sec_api">
                    <span><i class="fa-solid fa-plug"></i> API & Language</span>
                    <i class="fa-solid fa-chevron-down wo_acc_icon"></i>
                </div>
                <div class="wo_accordion_body" id="wo_sec_api" style="display:none;">
                    <div class="wo_section_label" style="margin-top:6px;">Output Language</div>
                    <div class="wo_lang_row">
                        <button class="wo_lang_btn menu_button" data-lang="en">EN</button>
                        <button class="wo_lang_btn menu_button" data-lang="ru">RU</button>
                        <button class="wo_lang_btn menu_button" data-lang="uk">UK</button>
                    </div>
                    <div class="wo_section_label">Connection Profile</div>
                    <div style="display:flex;gap:6px;align-items:center;">
                        <select id="wo_profile_select" class="text_pole" style="flex:1;"></select>
                        <button id="wo_profile_refresh" class="menu_button" title="Refresh profiles" style="flex-shrink:0;"><i class="fa-solid fa-rotate"></i></button>
                    </div>
                </div>
            </div>

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
            const lastMsg = [...chat].reverse().find(m => m.mes && hasDatePattern(m.mes));
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

    // Accordion toggles
    $('.wo_accordion_header').on('click', function() {
        const target = $(this).data('target');
        const body = $('#' + target);
        const icon = $(this).find('.wo_acc_icon');
        body.slideToggle(150);
        icon.toggleClass('wo_acc_open');
    });

    // Bulk: clear all events (keep NPCs and facts)
    $('#wo_clear_all_events').on('click', async () => {
        if (!confirm('Clear all events for all NPCs in this chat? Permanent facts will be kept.')) return;
        const s = getSettings();
        const botKey = getBotKey();
        const chatKey = getChatKey();
        const chatStore = s.npcData?.[botKey]?.[chatKey];
        if (chatStore) {
            for (const name of Object.keys(chatStore)) {
                if (chatStore[name]) {
                    chatStore[name].events = [];
                    chatStore[name].lastLocation = null;
                }
            }
            saveSettingsDebounced();
        }
        renderNPCList(); updateInjection();
        toastr.success('All events cleared.');
    });

    // Bulk: remove all NPCs entirely
    $('#wo_delete_all_npcs').on('click', async () => {
        if (!confirm('Remove ALL NPCs from tracking? This cannot be undone.')) return;
        const s = getSettings();
        const botKey = getBotKey();
        if (s.npcData?.[botKey]) {
            s.npcData[botKey].__npcs = {};
            // Also clear all chat stores
            for (const ck of Object.keys(s.npcData[botKey])) {
                if (ck !== '__npcs') delete s.npcData[botKey][ck];
            }
            saveSettingsDebounced();
        }
        renderNPCList(); updateInjection();
        toastr.success('All NPCs removed.');
    });

    // Language buttons
    function updateLangButtons() {
        const lang = getSettings().outputLanguage || 'en';
        $('.wo_lang_btn').each(function() {
            const active = $(this).data('lang') === lang;
            $(this).toggleClass('wo_lang_active', active);
        });
    }
    updateLangButtons();
    $('.wo_lang_btn').on('click', function() {
        const s = getSettings();
        s.outputLanguage = $(this).data('lang');
        saveSettingsDebounced();
        updateLangButtons();
    });

    $('#wo_scan_position').val(s.scanPosition || 'before_char');
    $('#wo_scan_position').on('change', function () { s.scanPosition = this.value; saveSettingsDebounced(); });

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
                $('#wo_book_info').html(bookNames.length ? `<i class="fa-solid fa-book"></i> ${bookNames.join(', ')} — 0 NPCs` : 'No lorebook attached');
            } else {
                const { npcs, added } = registerNPCs(found);
                await saveNPCs(npcs); renderNPCList(); updateInjection();
                $('#wo_book_info').html(`<i class="fa-solid fa-book"></i> ${bookNames.join(', ')} — ${found.length} NPCs`);
                toastr.success(`Scan complete: ${found.length} NPCs found, ${added} newly added.`);
            }
        } catch (e) { toastr.error('Scan failed: ' + e.message); }
        $('#wo_status').hide();
    });
    $('#wo_manual_add').on('click', async () => {
        const name = $('#wo_manual_name').val().trim();
        if (!name) { toastr.warning('Enter a name for the NPC.'); return; }
        const desc = $('#wo_manual_desc').val().trim();
        const npcs = getNPCs();
        if (npcs[name]) {
            toastr.warning(`"${name}" is already registered.`);
            return;
        }
        npcs[name] = { name, description: desc, enabled: true, events: [], permanentFacts: [], pendingIntro: true };
        await saveNPCs(npcs);
        renderNPCList();
        updateInjection();
        $('#wo_manual_name').val('');
        $('#wo_manual_desc').val('');
        toastr.success(`"${name}" added.`);
    });

    $('#wo_generate_now').on('click', async () => {
        if (!getConnectionProfiles().length) {
            toastr.error('No ST Connection Profiles found. Create one in SillyTavern settings first.');
            return;
        }
        await runGenerationCycle();
    });

    
    // CHARACTER_MESSAGE_RENDERED fires after the bot finishes writing — safe to count here.
    // This avoids the re-entrant loop that GENERATION_STARTED caused (it fires during our own callAPI too).
    eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, async () => {
        updateDateDisplay();

        // Auto-clear pendingIntro if NPC appeared in infoblock; clear activeIntros (one-shot)
        try {
            const ctx = SillyTavern.getContext();
            const lastMsg = (ctx.chat || []).slice(-1)[0];
            if (lastMsg?.mes) {
                const s = getSettings();
                const botKey = getBotKey();
                const npcsIdentity = s.npcData?.[botKey]?.__npcs || {};
                let changed = false;
                for (const [name, npc] of Object.entries(npcsIdentity)) {
                    if (npc.pendingIntro && npcInInfoblock({ name }, lastMsg.mes)) {
                        npcsIdentity[name].pendingIntro = false;
                        if (s.activeIntros) delete s.activeIntros[name];
                        changed = true;
                        toastr.success(`${name} has entered the scene!`);
                        console.log('[WildOffscreen] pendingIntro cleared for', name);
                    } else if (s.activeIntros?.[name]) {
                        // One-shot fired but NPC didn't appear yet — clear active flag anyway
                        delete s.activeIntros[name];
                        changed = true;
                    }
                }
                if (changed) { saveSettingsDebounced(); renderNPCList(); }
            }
        } catch(e) {}

        if (isGenerating) return; // our own API call, ignore

        const s = getSettings();
        if (!s.enabled) return;

        try {
            const ctx = SillyTavern.getContext();
            const currentLength = (ctx.chat || []).length;
            const isReroll = currentLength === lastChatLength && currentLength > 0;
            lastChatLength = currentLength;

            if (isReroll) {
                console.log('[WildOffscreen] Reroll detected — removing last events (permanentFacts untouched)');
                const npcs = getNPCs();
                let removed = 0;
                for (const key of Object.keys(npcs)) {
                    if (npcs[key].enabled && npcs[key].events.length > 0) {
                        npcs[key].events.pop();
                        // permanentFacts are deliberately NOT touched on reroll
                        removed++;
                    }
                }
                if (removed > 0) {
                    await saveNPCs(npcs);
                    renderNPCList();
                    updateInjection();
                }
                // Force generation this turn
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

    let _lastBotKey = getBotKey();
    let _lastChatKey = getChatKey();

    eventSource.on(event_types.CHAT_CHANGED, () => {
        msgCounter = 0;
        lastChatLength = 0;
        setTimeout(async () => {
            try {
                const ctx = SillyTavern.getContext();
                lastChatLength = (ctx.chat || []).length;
            } catch(e) {}

            const newBotKey  = getBotKey();
            const newChatKey = getChatKey();
            const sameBotNewChat = newBotKey === _lastBotKey && newChatKey !== _lastChatKey;

            if (sameBotNewChat) {
                // New chat with same character — check if this chatKey has any stored data
                const s = getSettings();
                const hasExistingData = !!(s.npcData?.[newBotKey]?.[newChatKey]);
                if (!hasExistingData) {
                    // Genuinely new chat — clear all runtime data
                    await clearChatData();
                    toastr.info('New chat detected — NPC events cleared. Characters retained.');
                }
                // If hasExistingData — returning to an old chat, restore silently
            }

            _lastBotKey  = newBotKey;
            _lastChatKey = newChatKey;

            renderNPCList();
            updateInjection();
            updateDateDisplay();
            $('#wo_book_info').html('Bot: ' + getBotKey());
        }, 200);
    });

    updateInjection();
});