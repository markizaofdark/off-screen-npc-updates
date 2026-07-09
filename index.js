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
    sceneMode: 'infoblock',   // 'infoblock' | 'text'
    infoblockKeywordScan: false, // infoblock mode: also scan recent messages by keywords
    keywordScanDepth: 2,      // how many bot messages to scan (both modes)
    textModeDepth: 2,         // kept for compatibility, mirrors keywordScanDepth in text mode
    minutesPerExchange: 5,    // minutes added per user+bot exchange in text mode
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
                'cooked or made something with their hands and felt briefly content',
                'caught themselves smiling at something they normally would have overlooked',
                'tidied a small corner of their space and felt the difference immediately',
                'had a moment of unexpected calm in the middle of a stressful stretch',
                'stumbled onto something that matched an old private interest they had nearly forgotten',
                'got through a task they had been dreading and felt lighter afterward',
                'permitted themselves to do nothing for a while without feeling guilty about it',
                'noticed their body feeling better than usual and appreciated it without overthinking it',
                'found something small to look forward to before the day was out',
                'let themselves sit with a good memory instead of pushing it aside',
                'resolved a minor internal conflict they had been carrying all week',
                'finished something small and felt that it was actually enough',
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
                'caught themselves in a habit they thought they had broken',
                'felt the gap between who they are and who they intended to be more sharply than usual',
                'got through the day but could not say what made it worth getting through',
                'found that something they usually enjoy left them flat',
                'snapped at themselves internally in a way they found hard to justify',
                'ran out of something they depended on at the wrong moment',
                'ended the day with the sense that they had missed something without knowing what',
                'felt physically worn down in a way that seemed out of proportion to the day',
                'kept returning in their mind to something small they should have done differently',
                'noticed a worry they thought was gone had quietly come back',
                'let time pass doing nothing and felt worse for it afterward',
                'could not fully explain why today felt harder than yesterday',
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
                'made someone laugh and felt the particular warmth of having done that',
                'was thought of by someone when they did not expect to be',
                'held a door open for a stranger and exchanged a look that meant something small',
                'had a conversation that went slightly longer than planned because neither of them wanted it to end',
                'received a message that arrived at exactly the right time',
                'did a small favor for someone and did not think about it again',
                'picked up where they left off with someone as if no time had passed',
                'found that someone remembered a detail about them that they had mentioned only once',
                'helped someone with something minor and felt genuinely useful',
                'said something that someone needed to hear, without knowing it at the time',
                'was met with patience they had not expected from someone',
                'spent a brief moment with someone and left feeling slightly less alone',
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
                'wanted to reach out to someone and talked themselves out of it',
                'left an interaction feeling like they had given more than they received',
                'was corrected in front of someone whose opinion matters to them',
                'caught a flicker of something in someone else\'s expression that they could not quite read',
                'made a small promise they are not sure they will keep',
                'felt obligated to someone in a way that chafed',
                'realized too late that they had said the wrong thing to the wrong person',
                'found that a relationship they had been neglecting had quietly shifted',
                'was kind to someone who did not deserve it and resented themselves slightly for it',
                'ended a call or conversation feeling more alone than before it started',
                'noticed someone pulling back and did not know whether to follow or let them go',
                'waited for something — a word, a sign, an acknowledgment — that did not come',
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
                'found something they had lost and had written off',
                'finished a task ahead of the time they had allotted for it',
                'managed their resources more carefully than usual and noticed the difference',
                'got access to something small they had been waiting on',
                'solved a recurring practical problem in a way that actually held',
                'had a piece of work go smoothly when they had expected it not to',
                'received a small token of acknowledgment for something they had put effort into',
                'cleared a minor obligation that had been sitting on the edge of their attention',
                'found an easier way to do something they had been doing the hard way',
                'finished a day\'s responsibilities without anything falling through the cracks',
                'had a modest but unexpected material improvement in their situation',
                'got through a logistical tangle with less pain than anticipated',
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
                'spent money they had not planned to and felt the tightness of it',
                'had a routine disrupted in a way that cost them more time than the thing itself was worth',
                'was given additional responsibility without any acknowledgment of the burden',
                'discovered they had forgotten something they should not have',
                'dealt with a piece of technology or equipment that refused to cooperate',
                'had a completed task revert or be undone through no fault of their own',
                'was made to wait for something that should not have taken this long',
                'realized they were further behind than they had estimated',
                'had a small plan for the day fail before they had properly started',
                'lost access to something they needed at an inconvenient moment',
                'received less than they had reasonably expected',
                'ended the day with one more unfinished thing than they had started with',
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
                'found a route or shortcut or method they had not known about',
                'overheard something in passing that clarified something they had been quietly wondering',
                'came across an account or story that resonated in a way they did not expect',
                'learned something about a place or object that added texture to what had been familiar',
                'noticed something in their environment they had walked past a hundred times without seeing',
                'picked up a skill or piece of knowledge almost by accident',
                'found confirmation for something they had only suspected before',
                'learned something small about their own body or mind that was useful rather than alarming',
                'discovered that something they had dismissed out of hand was worth a second look',
                'came across an old note or record of their own that reminded them of something worth keeping',
                'found that a question they had given up on had a simple answer they had not tried',
                'learned something that reframed a trivial irritation as something more understandable',
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
                'learned something that made a familiar situation feel slightly less safe',
                'found out that something they had trusted turned out to have a flaw',
                'noticed something off about a place or person they had always taken for granted',
                'came across something that confirmed a suspicion they had hoped was unfounded',
                'discovered they had missed something obvious that others had not',
                'learned something that recontextualized a past interaction in an unflattering light',
                'found out they had been the last to know about something',
                'overheard a version of events that made them question their own memory',
                'stumbled onto something they were not supposed to see and could not unsee it',
                'realized something they had said was less private than they thought',
                'learned something that made a past decision look worse than it had at the time',
                'came across information that made a current situation feel more fragile than before',
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
                'was welcomed somewhere without having to work for it',
                'managed to be useful to a group in a way that was noticed',
                'found that an event they had been dreading turned out to be tolerable',
                'was introduced to someone new under comfortable circumstances',
                'witnessed something in a public space that reminded them people can be decent',
                'got a small laugh from a group and felt the warmth of it',
                'was given credit for something in front of others and accepted it without deflecting',
                'left a gathering having said exactly the right amount and no more',
                'found themselves in the right room at the right moment without having planned it',
                'was included in an inside reference by a group, which meant something',
                'observed something happening around them and felt part of it rather than separate from it',
                'navigated a mixed social group without taking on anyone else\'s tensions',
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
                'spent time around people and came away feeling more alone than before',
                'was talked over in a group and it was not worth making a point of',
                'watched someone else receive the credit for something they had also contributed to',
                'had to smile at something they found offensive and disliked themselves for it',
                'felt conspicuous in a crowd in a way that had nothing to do with anyone else',
                'overcommitted to a social obligation they already knew they would regret',
                'was the only one in a room who did not know something everyone else seemed to know',
                'had to maintain a version of themselves they were tired of maintaining',
                'left before they wanted to or stayed longer than was good for them',
                'felt the particular loneliness of being in a group and not belonging to it',
                'was the recipient of someone else\'s misplaced frustration and absorbed it without complaint',
                'came away from a social encounter having learned that someone thought less of them than they had assumed',
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
                'finally said no to something they had always said yes to, and it held',
                'got honest with themselves about something they had been softening for a long time',
                'did something for themselves they had been putting off for someone else\'s sake',
                'broke a routine that was keeping them stuck and felt the change immediately',
                'found something worth working toward that they had not had before',
                'came through a difficult stretch and noticed they were still standing',
                'recognized something about themselves that others had tried to tell them for years',
                'gave themselves permission to grieve something they had been pretending to be over',
                'acted on an instinct they usually suppress and it turned out to be right',
                'let themselves be seen in a way they usually control carefully',
                'finished something long unfinished and felt the particular weight of it lift',
                'accepted something they cannot change and stopped spending energy against it',
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
                'watched themselves repeat a mistake and could not stop it in time',
                'lost confidence in something that had always been a source of it',
                'reached the end of a coping strategy that no longer works',
                'felt like the version of themselves they are now is a step back from who they were',
                'had to face something about their situation that they had been calling temporary',
                'caught themselves in a lie they had been telling themselves for long enough to believe it',
                'felt the weight of choices they cannot take back settling on them more heavily than usual',
                'noticed that their inner life has become very quiet in a way that worries them',
                'reached a point where keeping going requires more effort than usual and they are not sure why',
                'acknowledged to themselves that they need help and do not know where to get it',
                'felt genuinely afraid of something in their own future for the first time in a while',
                'lost the thread of who they are when they are not performing for others',
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
                'received honesty from someone that hurt and helped in equal measure',
                'made a commitment to someone in a way that changed the nature of what they share',
                'found in someone an unexpected witness to something they had never told anyone',
                'was defended by someone in a moment when they could not defend themselves',
                'had a fight with someone that cleared the air instead of damaging it',
                'realized that someone has been carrying something for them without being asked',
                'found that a relationship they had given up on still had something left in it',
                'was chosen, in a moment of decision, by someone who could have chosen otherwise',
                'experienced a moment of genuine understanding with someone who usually misunderstands them',
                'found that someone knows them better than they realized and that this is a comfort',
                'let someone in past a boundary they usually hold and did not regret it',
                'discovered a shared history with someone that reframes what they already knew about each other',
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
                'found out they had been confided in by the wrong person about the wrong thing',
                'realized that someone who cares about them is hurting because of something they did',
                'watched a relationship they had tried to save decide it did not want to be saved',
                'felt the particular loneliness of being misunderstood by someone who knows them well',
                'was let down by someone at a moment when it cost more than usual',
                'had to be the one to end something and carry the weight of having done it',
                'discovered that a version of themselves exists in someone else\'s mind that they cannot correct',
                'lost something in a relationship that will not come back even if everything else does',
                'realized that they have been the difficult one in a dynamic they had understood differently',
                'was told something true about themselves by someone who did not intend it as a kindness',
                'found that a relationship they had thought was mutual was not',
                'had to hold themselves together in front of someone who was the reason they were falling apart',
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
                'had a run of competence that changed how they are seen where it counts',
                'got through a high-stakes situation that required them to perform and they did',
                'found a way to convert something they are good at into something that benefits them materially',
                'was given a chance by someone who did not have to give it',
                'cleared a debt — financial, social, or moral — that had been weighing on them',
                'established themselves in a context where they had previously been uncertain',
                'had work they did alone get recognized by someone who mattered',
                'gained access to a resource or network that changes what is possible for them',
                'moved from a position of dependency to one of slightly more control',
                'was trusted with something important enough that the trust itself changed how they carry themselves',
                'received something concrete that proved they are further along than they thought',
                'found that an investment of time or effort paid off in a way they could not have predicted',
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
                'was outmaneuvered by someone in a context where it cost them something real',
                'found themselves in a position that requires them to ask for something and they hate having to ask',
                'had a run of poor performance at the worst possible moment',
                'discovered that a resource they counted on is no longer available to them',
                'had their competence questioned in front of the wrong people',
                'lost ground they had worked hard to gain and do not see a clear way to get it back',
                'found that a plan that seemed solid has a hole in it that others have noticed',
                'received less than they were owed and had no good way to press for it',
                'realized their current situation is more precarious than they had allowed themselves to acknowledge',
                'had something they had been building come apart faster than it had gone together',
                'lost an advantage they had taken for granted until it was gone',
                'found themselves on the wrong side of a decision they had no part in making',
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
                'found out that a fear they had been carrying was based on incomplete information',
                'discovered that something they assumed was working against them has actually been working for them',
                'learned something that retroactively makes sense of a long stretch of confusion',
                'found out that someone they dismissed was right about something significant',
                'uncovered a pattern in their own history that shows them something useful about themselves',
                'received confirmation that something they believed in privately was not wrong',
                'found out that a situation they thought they had no power over has more give in it than they thought',
                'learned something that turns an apparent loss into something more complicated',
                'discovered that they had been given more credit than they knew',
                'found a piece of information that, quietly and without drama, changes what they will do next',
                'learned something about a person from their past that lets them release something they had been holding',
                'came across a truth that simplifies something they had made very complicated',
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
                'found out that they misread something important for long enough to cause damage',
                'discovered that a version of a situation they had been given was shaped to leave things out',
                'learned that someone they trusted had access to something they thought was private',
                'came across information that collapses the distance between a fear and a reality',
                'found out they were wrong about something in a way that implicates more than just that one thing',
                'learned something that makes a past kindness they received feel different in retrospect',
                'discovered that someone had made a decision about them without consulting them',
                'found out that something they let slide turned into something that did not resolve itself',
                'came across evidence that one of their assumptions has been actively wrong for some time',
                'learned something that makes the next necessary conversation unavoidable',
                'found out they have been on the wrong side of something and cannot pretend otherwise',
                'discovered that a truth they had been given was only part of the story and the rest is worse',
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
                'found that a group they had been peripheral to had quietly made space for them',
                'demonstrated something about themselves in public that they had never had a chance to before',
                'was the person who held a group together at a moment when it could have fractured',
                'received acknowledgment from a group for something they had done without expectation',
                'found that their presence in a room was noticed in the right way at the right time',
                'was given information or access that signals they are more trusted than they realized',
                'managed a public moment with enough grace that it changed how people positioned themselves toward them',
                'was included in a conversation at a level they had not been before',
                'helped resolve something between others in a way that made them central without making them the story',
                'found that their standing in a group had quietly improved while they were not watching it',
                'earned something from a community that cannot be bought or performed into existence',
                'was the person in a group who said the thing that needed to be said and was not punished for it',
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
                'was made the subject of a story being told about them that they have no way to correct',
                'watched someone else take up space in a group that had previously been theirs',
                'found that a loyalty they demonstrated was not returned when they needed it',
                'said something in a group that was taken in the wrong direction and cannot be unsaid',
                'discovered that their absence from something was interpreted in a way they did not intend',
                'was put in a position by someone else that made them look bad without any recourse',
                'found that a group they had invested in had limits to how far it would go for them',
                'was used as an example in a way that was technically fair but still stung',
                'learned that something they did in a social context had reached further than they realized',
                'had their credibility questioned in a group setting and had insufficient ground to recover it immediately',
                'found that a misunderstanding about them within a group has taken on a life of its own',
                'was the last to understand a shift in a social dynamic that everyone else had already adjusted to',
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
                'became, in some irreversible way, more themselves than they had previously been allowed to be',
                'crossed through a threshold they had been standing at the edge of for years and did not turn back',
                'discovered that they are capable of something they had genuinely believed was beyond them',
                'freed themselves from a version of their own story that no longer fits',
                'made peace with something they had been at war with for so long it had become part of how they moved',
                'decided something about the shape of their future that cannot be undecided',
                'found, at last, something they can build around',
                'did the thing they were most afraid to do and found out the fear was the worst part',
                'accepted a truth about themselves that changes what is possible for them',
                'walked away from something that was familiar and toward something that is true',
                'reached the other side of a long and serious internal reckoning',
                'became someone who has been through something real, and knows it',
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
                'came apart in a way they are not sure they can put back together the same way',
                'reached the end of something they had thought was permanent and found it was not',
                'faced a truth about themselves that closes off a story they had been living inside',
                'found out what they are like when everything stops working at once',
                'lost the version of the future they had been organizing their present around',
                'did damage to their own life that will require years to undo, if it can be undone',
                'discovered that the worst thing they feared about themselves may have been true',
                'had to witness themselves fail at something that mattered more than anything they said it did',
                'fell in a way that was not dramatic but was definitive',
                'found out who they are when there is no one watching and did not like the answer',
                'crossed a line they cannot pretend they did not know was there',
                'became someone who has lost something that cannot be replaced and will have to keep living anyway',
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
                'let someone matter to them in a way they had been refusing to allow for a long time',
                'was witnessed at their worst by someone who stayed anyway',
                'gave someone something they cannot take back and found it was the right thing to give',
                'had a relationship become something so different from what it was that it is almost a new thing',
                'found, in another person, something they had stopped believing was findable',
                'made a sacrifice for someone that cost them seriously and does not regret it',
                'was loved in a way that healed something they had not told anyone was broken',
                'built something with someone that will outlast the moment',
                'changed how they relate to people because one person showed them it could be different',
                'received from someone the one thing they had needed for a long time and not known how to ask for',
                'had something between two people become something that belongs to both of them now',
                'discovered that one person, in the right circumstances, can restructure what you believe is possible',
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
                'found out that a person who shaped them did not know them at all',
                'lost the one relationship they had believed was immune to the things that end relationships',
                'was loved wrongly by someone for long enough that it changed how they receive love',
                'watched something that had been the center of their life become a thing they used to have',
                'found out that the version of them someone fell in love with was not the one they have become',
                'discovered that they had been the substitute for something they did not know they were competing with',
                'had the worst of themselves confirmed by someone who had promised to see the best',
                'realized too late that they had treated someone as permanent when that person was already leaving',
                'lost someone in a way that was not a fight or a decision but a slow drift they could not stop',
                'was present for the exact moment when something between two people became unrepairable',
                'found out what it means to have mattered to someone and still not have been enough',
                'had to become the person who remains after someone else was the one who left',
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
                'moved from a position of significant vulnerability to one of real footing',
                'obtained something that gives them a form of protection they have never had before',
                'was elevated to a position they did not believe they would reach within this lifetime',
                'had their circumstances change in a way that removes a constraint they had organized their whole life around',
                'was given the kind of opportunity that does not come twice',
                'acquired something — tangible or otherwise — that changes the calculus of their future',
                'reached a material position that makes the thing they most feared no longer quite as possible',
                'was proven right in a public and consequential way',
                'got out from under something that had defined the limits of everything else',
                'received backing from a direction that removes the central obstacle they have been facing',
                'secured a future for themselves or someone they love that had been genuinely uncertain',
                'arrived, by some combination of effort and circumstance, somewhere they had been trying to reach for a long time',
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
                'found out that the thing that was supposed to be secure was not',
                'lost access to something that had been underwriting the rest of their life',
                'had something collapse that they had been assured would hold',
                'was made to account, publicly, for something that is now beyond accounting for',
                'found out that a legal, financial, or institutional reality is not what they had been told it was',
                'had their options reduced, rapidly and definitively, to fewer than they have had in years',
                'discovered that the thing they had been working toward is no longer available to them',
                'found themselves at the beginning of a loss whose full extent they cannot yet see',
                'lost ground that cannot be recovered the way it was taken',
                'had a system that was designed to protect them fail when it mattered most',
                'found that the cost of something they did is arriving all at once',
                'was removed from something — forcibly or structurally — in a way they cannot contest',
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
                'found out that a wrong done to them was not forgotten by everyone who witnessed it',
                'learned something that gives them back a piece of their own story they thought was gone',
                'discovered a truth that makes forgiveness, if they want it, genuinely possible',
                'found out something that retroactively explains a significant portion of their suffering',
                'learned something that changes who they believe they are in ways they will need time to absorb',
                'uncovered a truth about where they come from that changes how they understand their own shape',
                'received information that clarifies something they had carried as a private wound for years',
                'found out that they were not wrong about something they had been made to doubt for a long time',
                'learned something that reframes the worst thing that happened to them as not entirely what it seemed',
                'discovered that someone they had counted out still exists in their life in a form that matters',
                'came across a truth that makes the future, for the first time in a while, feel genuinely open',
                'found out something that proves a version of events they had been the only one to remember',
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
                'found out that a foundational thing they believed about their own life was not true',
                'discovered that someone they trusted made decisions about them that they had no knowledge of',
                'learned something that cannot be unknown and whose knowing changes what they are responsible for',
                'found out that a version of a story has been in circulation for years and it is not theirs',
                'came across evidence that changes the meaning of something they thought they had already reckoned with',
                'discovered that the person they have been trying to become was built on a false understanding',
                'found out that they are not the only one something was done to',
                'learned something that makes a decision they cannot revisit look completely different',
                'discovered that what they believed was a past they had left behind was still present somewhere in their life',
                'found out something that means the thing they are most afraid of is more likely than they had told themselves',
                'came across a truth that forces them to choose between knowing and being able to function as if they do not',
                'learned something that makes it impossible to see a significant part of their life the same way again',
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
                'became, in a community that matters to them, the kind of person others organize themselves around',
                'was given a role in a group that changes what is possible for them in every direction',
                'found belonging where they had expected to remain peripheral and it changed what they believed about themselves',
                'acted in a public moment in a way that will define how they are understood for a long time',
                'created something with others that none of them could have made alone and that will outlast the moment',
                'was the person who said or did the thing that changed the direction of something larger than themselves',
                'was trusted with a responsibility by a community that requires them to become something larger than what they have been',
                'emerged from a public crisis with more standing than they had going in',
                'was seen doing something real, in public, that aligned completely with who they actually are',
                'built a reputation in a place where reputation is the material from which everything else is made',
                'found that a community they had doubted would have them made permanent space for them',
                'became the kind of person in a social world who is named when someone needs to know who to trust',
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
                'had their name become attached to something they cannot fully separate themselves from',
                'lost a social world they had built over years in a matter of days',
                'was publicly held responsible for something whose origins were more complicated than the story that spread',
                'found that the community they had trusted most was the one least willing to stand with them when it mattered',
                'was made into a symbol of something they did not choose and cannot control',
                'had the thing they had done privately become the thing they are known for',
                'found out that their removal from a group was discussed and decided before they had any idea it was coming',
                'was cut from something by consensus in a way that made the isolation total',
                'had a version of themselves circulate in public that bears just enough resemblance to the truth to be impossible to deny',
                'lost the social capital they had spent years building in a moment they cannot fully account for',
                'was publicly associated with a failure or wrongdoing in a way that others will not quickly separate from their name',
                'found out what it means to be outside a community that once felt like the definition of where they belonged',
            ],
        },
    },
};

const CATEGORIES = Object.keys(EVENT_POOLS.minor);

// ── State ──────────────────────────────────────────────────

let msgCounter = 0;
let lastChatLength = 0;  // tracks chat size to detect rerolls
let lastBotMessageId = null; // tracks last bot message to detect rerolls accurately
let isGenerating = false; // guard against re-entrant generation
let lastProcessedMsgId = null; // deduplicate MESSAGE_RECEIVED + CHARACTER_MESSAGE_RENDERED

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
        const chatId = (typeof ctx.getCurrentChatId === 'function' ? ctx.getCurrentChatId() : null)
            || ctx.chatId
            || ctx.selected_group;
        if (chatId) { console.log('[WildOffscreen] getChatKey →', String(chatId)); return String(chatId); }
        const firstMsg = ctx.chat?.[0];
        if (firstMsg?.send_date) { const k = 'chat_' + String(firstMsg.send_date); console.log('[WildOffscreen] getChatKey fallback →', k); return k; }
        console.log('[WildOffscreen] getChatKey → default');
        return 'default';
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

// ── Internal time (text mode) ──────────────────────────

function getInternalTime() {
    const s = getSettings();
    const botKey = getBotKey();
    const chatKey = getChatKey();
    const raw = s.npcData?.[botKey]?.[chatKey]?.__internalTime;
    return raw || null; // { date: 'YYYY/MM/DD', time: 'HH:MM' } or null
}

function saveInternalTime(dateStr, timeStr) {
    const s = getSettings();
    const botKey = getBotKey();
    const chatKey = getChatKey();
    if (!s.npcData) s.npcData = {};
    if (!s.npcData[botKey]) s.npcData[botKey] = { __npcs: {} };
    if (!s.npcData[botKey][chatKey]) s.npcData[botKey][chatKey] = {};
    s.npcData[botKey][chatKey].__internalTime = { date: dateStr, time: timeStr };
    saveSettingsDebounced();
}

function advanceInternalTime() {
    const s = getSettings();
    const current = getInternalTime();
    if (!current) return null;

    const minutes = s.minutesPerExchange || 5;
    const [h, m] = current.time.split(':').map(Number);
    const totalMin = h * 60 + m + minutes;
    const newH = Math.floor(totalMin / 60) % 24;
    const newM = totalMin % 60;
    // Handle day rollover simply — keep same date (for simplicity, days don't advance)
    const newTime = String(newH).padStart(2, '0') + ':' + String(newM).padStart(2, '0');
    saveInternalTime(current.date, newTime);
    return { date: current.date, time: newTime };
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

async function saveNPCsPartial(npcs) {
    // Save only the provided NPCs without touching others in storage
    const s = getSettings();
    const botKey = getBotKey();
    const chatKey = getChatKey();
    if (!s.npcData) s.npcData = {};
    if (!s.npcData[botKey]) s.npcData[botKey] = { __npcs: {} };
    if (!s.npcData[botKey].__npcs) s.npcData[botKey].__npcs = {};
    if (!s.npcData[botKey][chatKey]) s.npcData[botKey][chatKey] = {};
    for (const [name, npc] of Object.entries(npcs)) {
        // Only update runtime data (events/facts/location) — don't touch identity
        s.npcData[botKey][chatKey][name] = {
            events: npc.events || [],
            permanentFacts: npc.permanentFacts || [],
            lastLocation: npc.lastLocation || null,
        };
        // Also update identity fields that may have changed
        if (s.npcData[botKey].__npcs[name]) {
            s.npcData[botKey].__npcs[name].pendingIntro = npc.pendingIntro ?? false;
        }
    }
    console.log('[WildOffscreen] saveNPCsPartial | keys:', Object.keys(npcs), '| chatKey:', chatKey);
    saveSettingsDebounced();
}

async function saveNPCs(npcs) {
    const s = getSettings();
    const botKey = getBotKey();
    const chatKey = getChatKey();
    const eventCounts = Object.fromEntries(Object.entries(npcs).map(([k,v]) => [k, v.events?.length || 0]));
    console.log('[WildOffscreen] saveNPCs | chatKey:', chatKey, '| eventCounts:', eventCounts, '| caller:', new Error().stack.split('\n')[2]?.trim());
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
    updateDateDisplay();
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
// Parse a lorebook key that may be a /regex/flags string
function parseKeyAsRegex(key) {
    const m = key.match(/^\/(.+)\/([gimsuy]*)$/);
    if (!m) return null;
    try { return new RegExp(m[1], m[2] || 'i'); } catch(e) { return null; }
}

function npcInInfoblock(npc, mes) {
    const chars = parseInfoblockChars(mes);
    if (!chars.length) return false;

    const charsText = chars.join(', ');
    const npcLower  = npc.name.toLowerCase();

    const directMatch = chars.some(c => {
        const cl = c.toLowerCase().trim();
        return cl === npcLower || cl.includes(npcLower);
    });
    if (directMatch) return true;

    const keys = Array.isArray(npc.searchKeys) ? npc.searchKeys : [];
    for (const key of keys) {
        if (!key || typeof key !== 'string') continue;
        const rx = parseKeyAsRegex(key);
        if (rx) {
            if (rx.test(charsText)) return true;
        } else {
            if (key.length >= 2 && charsText.toLowerCase().includes(key.toLowerCase())) return true;
        }
    }
    return false;
}

/**
 * Text-mode scene detection: check if NPC is mentioned in the last N bot messages.
 * Uses name + searchKeys (plain and regex) against raw message text.
 */
function npcInRecentMessages(npc, depth) {
    try {
        const ctx = SillyTavern.getContext();
        const chat = ctx.chat || [];
        // Get last `depth` bot messages
        const botMsgs = [...chat].reverse().filter(m => !m.is_user && !m.is_system && m.mes).slice(0, depth);
        if (!botMsgs.length) return false;

        const npcLower = npc.name.toLowerCase();
        const keys = Array.isArray(npc.searchKeys) ? npc.searchKeys : [];
        const nameParts = npc.name.trim().split(/\s+/).filter(p => p.length > 2);

        for (const msg of botMsgs) {
            const text = msg.mes.replace(/<[^>]+>/g, '').toLowerCase();

            // Direct name match
            if (text.includes(npcLower)) return true;

            // Name parts
            if (nameParts.some(p => text.includes(p.toLowerCase()))) return true;

            // Search keys
            for (const key of keys) {
                if (!key || typeof key !== 'string') continue;
                const rx = parseKeyAsRegex(key);
                if (rx) { if (rx.test(text)) return true; }
                else if (key.length >= 2 && text.includes(key.toLowerCase())) return true;
            }
        }
        return false;
    } catch(e) { return false; }
}

// ── Chat context ───────────────────────────────────────────

function getChatContextForNPC(npc, maxMessages = 30, maxCharsPerMsg = 3000) {
    const npcObj = typeof npc === 'string' ? { name: npc } : npc;
    const npcName = npcObj.name;

    try {
        const ctx = SillyTavern.getContext();
        const chat = ctx.chat || [];
        const nonSystem = chat.filter(m => !m.is_system && m.mes);

        // Find messages where this NPC appears — infoblock or text scan depending on mode
        const _ctxMode = getSettings().sceneMode || 'infoblock';
        const withNPC = nonSystem.filter(m => {
            if (_ctxMode === 'text') return npcInRecentMessages(npcObj, 999); // scan all for context
            return npcInInfoblock(npcObj, m.mes);
        });

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
        const s2 = getSettings();
        const sceneChars = (sceneInfo && Array.isArray(sceneInfo.characters)) ? sceneInfo.characters : [];
        const searchKeys = Array.isArray(npc.searchKeys) ? npc.searchKeys : [];
        if (s2.sceneMode === 'text') {
            // Text mode: check if NPC appears in recent bot messages
            inScene = npcInRecentMessages(npc, s2.keywordScanDepth || s2.textModeDepth || 2);
            console.log('[WildOffscreen] TEXT MODE — NPC', npc.name, '→', inScene ? 'IN SCENE' : 'OFFSCREEN');
        } else if (sceneChars.length > 0) {
            // Infoblock mode: direct name match, + optional keyword scan
            const npcNameLower = npc.name.toLowerCase();
            const directMatch = sceneChars.some(c => {
                if (!c || typeof c !== 'string') return false;
                const cl = c.toLowerCase().trim();
                return cl === npcNameLower || cl.includes(npcNameLower);
            });
            const kwMatch = s2.infoblockKeywordScan && !directMatch
                ? npcInRecentMessages(npc, s2.keywordScanDepth || 2)
                : false;
            inScene = directMatch || kwMatch;
            console.log('[WildOffscreen] INFOBLOCK MODE — NPC', npc.name, '→', inScene ? 'IN SCENE' : 'OFFSCREEN',
                '| direct:', directMatch, 'keyword:', kwMatch);
        } else {
            console.log('[WildOffscreen] INFOBLOCK MODE — no sceneChars found, NPC', npc.name, '→ OFFSCREEN (no infoblock parsed)');
        } // end infoblock mode

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

    // In text mode, build a minimal sceneInfo substitute (no infoblock)
    const _bsMode = getSettings().sceneMode || 'infoblock';
    if (_bsMode === 'text' && !sceneInfo) {
        const it = getInternalTime();
        if (it) {
            // sceneInfo stays null — no character list, time comes from internal clock
            // We'll inject time into sceneHeader manually below
        }
    }

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
    if (sceneInfo && _bsMode === 'infoblock') {
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
    } else if (_bsMode === 'text') {
        const it = getInternalTime();
        if (it) {
            const th = parseInt(it.time);
            const tod = th < 6 ? 'night' : th < 12 ? 'morning' : th < 18 ? 'afternoon' : th < 22 ? 'evening' : 'night';
            sceneHeader = '=== SCENE TIME INFO ===\n'
                + 'Current date: ' + it.date + ' | Time: ' + it.time + ' (' + tod + ')\n'
                + 'NOTE: It is currently ' + tod + '. Generated events must be plausible for this time of day.\n'
                + 'Characters in scene are determined by recent story context — NPCs mentioned in the last messages are considered present.\n'
                + '===\n\n';
        }
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
        + 'YOUR RESPONSE MUST USE EXACTLY THIS FORMAT — no deviations:\n'
        + npcList.map((item, i) => 'NPC' + (i + 1) + ': [location] | [minor/notable/major] | [sentence]').join('\n') + '\n\n'
        + 'CRITICAL: Use NPC1, NPC2, NPC3... labels. Do NOT use character names as labels. Do NOT add any text before or after.\n'
        + 'Example:\n'
        + 'NPC1: городской рынок | minor | Bargained longer than usual over fabric and left without buying anything.\n'
        + 'NPC2: больница | major | Was told the results came back positive and sat unable to move.\n'
        + 'NPC3: Тюменское ГУВД, кабинет Парфёнова | in-scene | No offscreen events. Currently in scene.';

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
function parseBatchResponse(text, count, npcList) {
    const results = [];
    for (let i = 1; i <= count; i++) {
        // Primary: match NPC1:, NPC2: etc.
        let regex = new RegExp('NPC' + i + '[:\s]+(.+?)(?=NPC' + (i + 1) + '[:\s]|$)', 'si');
        let match = text.match(regex);

        // Fallback: if NPC label not found, try matching by character name
        if (!match && npcList && npcList[i - 1]) {
            const npcName = npcList[i - 1].npc.name.split(' ')[0]; // first name/word
            const nameRegex = new RegExp(
                '(?:^|\n)' + npcName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') +
                '[:\s]+(.+?)(?=\n[A-ZА-ЯЁ][^\n]*[:\s]|$)',
                'si'
            );
            match = text.match(nameRegex);
            if (match) console.log('[WildOffscreen] Fallback name match for NPC' + i + ' (' + npcName + ')');
        }

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
    const _sm = getSettings();
    console.log('[WildOffscreen] sceneMode:', _sm.sceneMode, '| sceneCharsForFilter:', sceneCharsForFilter);
    const isInSceneCheck = (npc) => {
        if (_sm.sceneMode === 'text') {
            const r = npcInRecentMessages(npc, _sm.textModeDepth || 2);
            console.log('[WildOffscreen] isInSceneCheck TEXT', npc.name, '→', r);
            return r;
        }
        // Infoblock mode: ONLY match against characters explicitly listed in the infoblock
        // Search keys are NOT used here — they are for lorebook scanning, not scene detection
        const nl = npc.name.toLowerCase();
        const result = sceneCharsForFilter.some(c => {
            const cl = (c || '').toLowerCase().trim();
            return cl === nl || cl.includes(nl);
        });
        console.log('[WildOffscreen] isInSceneCheck INFOBLOCK', npc.name, '→', result, '| sceneChars:', sceneCharsForFilter);
        return result;
    };

    const offscreenKeys = keys.filter(k => !isInSceneCheck(npcs[k]));
    const skippedInScene = keys.filter(k => isInSceneCheck(npcs[k]));
    console.log('[WildOffscreen] offscreenKeys:', offscreenKeys, '| skippedInScene:', skippedInScene);

    if (!offscreenKeys.length) {
        console.log('[WildOffscreen] All NPCs in scene, nothing to generate.');
        return 'all_in_scene';
    }

    const npcList = offscreenKeys.map(k => ({ npc: npcs[k], key: k, params: rollEventParams() }));

    const messages = buildBatchMessages(npcList, mainCharInfo, sharedChat, sceneInfo);
    const rawText = await callAPI(messages, npcList.length);
    console.log('[WildOffscreen] Batch response:', rawText?.slice(0, 500));

    if (!rawText) return;

    const parsed = parseBatchResponse(rawText, npcList.length, npcList);
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

    // Save only the NPCs that were modified (offscreen ones)
    // Do NOT save in-scene NPCs — their data in `npcs` is stale snapshot
    // and would overwrite any data saved between snapshot and now
    const modifiedNpcs = {};
    for (const { npc, key } of npcList) {
        modifiedNpcs[key] = npc;
    }
    if (Object.keys(modifiedNpcs).length > 0) {
        await saveNPCsPartial(modifiedNpcs);
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
        // Snapshot event counts before generation
        const beforeCounts = Object.fromEntries(keys.map(k => [k, npcs[k].events.length]));

        // generateEventsForAllNPCs handles in-scene filtering and saving internally
        const result = await generateEventsForAllNPCs(npcs);

        // If it returned 'all_in_scene', nothing to do
        if (result === 'all_in_scene') {
            toastr.info('All active NPCs are currently in scene — no offscreen events generated.');
            updateInjection(); renderNPCList();
            return;
        }

        // Re-fetch and check results
        let npcsAfter = getNPCs();
        const newEventKeys = keys.filter(k => npcsAfter[k] && (npcsAfter[k].events.length || 0) > (beforeCounts[k] || 0));

        if (newEventKeys.length === 0) {
            console.log('[WildOffscreen] First attempt got 0 results, retrying...');
            await new Promise(r => setTimeout(r, 1500));
            await generateEventsForAllNPCs(getNPCs());
            npcsAfter = getNPCs();
        }

        updateInjection();
        renderNPCList();

        const generated = keys.filter(k => npcsAfter[k] && (npcsAfter[k].events.length || 0) > (beforeCounts[k] || 0)).length;
        console.log('[WildOffscreen] Generated events for', generated, '/', keys.length, 'active NPCs');

        if (generated === 0) {
            toastr.error('Generation failed. Check your connection profile and model.');
        } else if (generated < keys.length) {
            toastr.warning(`Generated events for ${generated}/${keys.length} NPCs.`);
        } else {
            toastr.success(`Generated events for all ${generated} NPCs.`);
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
        // Inject only last event to keep context size small
        const last = npc.events[npc.events.length - 1];
        const evLoc = last && last.location && last.location !== loc ? ' @' + last.location : '';
        const evLine = last ? '  [' + (last.positive ? '+' : '-') + last.scale.toUpperCase() + evLoc + '] ' + last.text : '  —';
        return npc.name + ' (' + loc + '): ' + evLine.trim();
    });
    const s2 = getSettings();
    const activeIntros = s2.activeIntros || {};
    const npcsAll = Object.values(npcs);

    // forceIntro: any NPC (new or existing) with activeIntros flag
    const forceIntroNPCs = npcsAll.filter(n => activeIntros[n.name]);
    // pendingIntro passive: new NPCs waiting for natural introduction
    const passiveIntroNames = npcsAll.filter(n => n.pendingIntro && !activeIntros[n.name]).map(n => n.name);

    let introNote = '';
    if (forceIntroNPCs.length) {
        introNote += '\n\n[SCENE DIRECTION — REQUIRED]\n'
            + 'Introduce the following character(s) into this response: '
            + forceIntroNPCs.map(n => n.name).join(', ') + '.\n'
            + 'They must appear or be directly referenced in this message — not hinted at, not delayed.\n'
            + 'The introduction must feel natural and fit the current location, time, and tone.\n';

        for (const npc of forceIntroNPCs) {
            const desc = (npc.lorebookDescription || npc.description || '').trim();
            if (desc) {
                introNote += '\nCharacter: ' + npc.name + '\n' + desc + '\n';
            }
        }
        introNote += '[END SCENE DIRECTION]';
    }
    if (passiveIntroNames.length) {
        introNote += '\n[Note: ' + passiveIntroNames.join(', ') + ' exist in this world and may be introduced when the moment fits naturally.]';
    }

    return '[OFF-SCREEN NPC UPDATES]\n'
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

function populateEditSelect() {
    const npcs = getNPCs();
    const sel = $('#wo_edit_npc_select');
    if (!sel.length) return;
    const current = sel.val();
    sel.empty().append('<option value="">— select NPC —</option>');
    Object.keys(npcs).forEach(name => {
        sel.append($('<option>').val(name).text(name));
    });
    if (current && npcs[current]) sel.val(current);
    else { $('#wo_edit_npc_panel').hide(); }
}

function renderNPCList() {
    const npcs = getNPCs();
    const container = $('#wo_npc_list');

    // Remember which cards are currently open before re-render
    const openCards = new Set();
    container.find('.wo_npc_card').each(function() {
        if ($(this).find('.wo_npc_events').is(':visible')) {
            openCards.add($(this).data('name'));
        }
    });

    container.empty();
    const keys = Object.keys(npcs);
    if (!keys.length) {
        container.append('<div class="wo_empty">No NPCs registered. Scan or load a lorebook.</div>');
        return;
    }
    for (const key of keys) {
        const npc = npcs[key];
        const count = npc.events.length;
        const activeIntrosNow = getSettings().activeIntros || {};
        const card = $(`
        <div class="wo_npc_card ${npc.enabled ? '' : 'wo_npc_disabled'}" data-name="${key}">
            <div class="wo_npc_header">
                <span class="wo_npc_name">${npc.name}${npc.pendingIntro ? ' <span class="wo_intro_badge">NEW</span>' : ''}</span>
                <span class="wo_npc_count">${npc.lastLocation ? '<i class="fa-solid fa-location-dot" style="font-size:0.8em;margin-right:3px;"></i>' : ''}${count} event${count !== 1 ? 's' : ''}</span>
                <div class="wo_npc_actions">
                    <button class="wo_btn_introduce menu_button ${(npc.pendingIntro || activeIntrosNow[key]) ? 'wo_btn_introduce_pulse' : ''}" title="${activeIntrosNow[key] ? 'Cancel introduction (cued)' : 'Cue introduction into next scene'}"><i class="fa-solid fa-door-open"></i></button>
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
                            <div class="wo_event_text wo_event_editable" data-idx="${originalIndex}" contenteditable="true" spellcheck="false" title="Click to edit">${evText}</div>
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

        // Save edited event text on blur
        evContainer.find('.wo_event_editable').on('blur', async function () {
            const idx = parseInt($(this).attr('data-idx'));
            if (isNaN(idx)) return;
            const newText = $(this).text().trim();
            if (!newText) return;
            const n = getNPCs();
            if (n[key] && n[key].events && n[key].events[idx]) {
                if (n[key].events[idx].text === newText) return; // no change
                n[key].events[idx].text = newText;
                await saveNPCs(n);
                updateInjection();
                // Don't re-render — just save silently, cursor stays in place
            }
        }).on('keydown', function (e) {
            if (e.key === 'Enter') {
                e.preventDefault();
                $(this).blur(); // save on Enter
            }
            if (e.key === 'Escape') {
                // Restore original text and blur
                const idx = parseInt($(this).attr('data-idx'));
                const n = getNPCs();
                if (!isNaN(idx) && n[key]?.events?.[idx]) {
                    $(this).text(n[key].events[idx].text);
                }
                $(this).blur();
            }
        });
        
        card.find('.wo_npc_header').on('click', function (e) {
            if ($(e.target).closest('.wo_npc_actions').length) return;
            evContainer.slideToggle(150);
        });
        card.find('.wo_btn_introduce').on('click', async (e) => {
            e.stopPropagation();
            const s = getSettings();
            if (!s.activeIntros) s.activeIntros = {};
            if (s.activeIntros[key]) {
                // Already cued — cancel it
                delete s.activeIntros[key];
                saveSettingsDebounced();
                updateInjection();
                renderNPCList();
                toastr.info(`Introduction cancelled for ${key}.`);
            } else {
                s.activeIntros[key] = true;
                // Update lastChatLength so next message doesn't trigger false reroll
                try {
                    const ctx = SillyTavern.getContext();
                    lastChatLength = (ctx.chat || []).length;
                    const lm = (ctx.chat || []).slice(-1)[0];
                    if (lm && !lm.is_user) lastBotMessageId = (lm.mes || '').slice(0, 80);
                } catch(e) {}
                saveSettingsDebounced();
                updateInjection();
                renderNPCList();
                toastr.info(`Introduction cued for ${key}. Character info will be sent to the model.`);
            }
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
        // Restore open state if this card was open before re-render
        if (openCards.has(key)) {
            card.find('.wo_npc_events').show();
        }

        container.append(card);
    }
    // Refresh edit select to reflect current NPC list
    if ($('#wo_edit_npc_select').length) populateEditSelect();
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
                    <div class="wo_section_label" style="margin-top:6px;">Scene Detection Mode</div>
                    <div class="wo_lang_row" id="wo_scene_mode_row">
                        <button class="wo_scene_mode_btn menu_button" data-mode="infoblock">Info Block</button>
                        <button class="wo_scene_mode_btn menu_button" data-mode="text">Text Scan</button>
                    </div>

                    <div class="wo_section_label">Current Story Date &amp; Time</div>
                    <div id="wo_date_display"></div>

                    <!-- Text mode time controls -->
                    <div id="wo_time_controls" style="display:none;">
                        <div style="display:flex;gap:6px;margin-top:4px;align-items:center;">
                            <input type="text" id="wo_time_date" class="text_pole" placeholder="YYYY/MM/DD" style="flex:1;" />
                            <input type="text" id="wo_time_hhmm" class="text_pole" placeholder="HH:MM" style="width:70px;flex-shrink:0;" />
                            <button id="wo_time_set" class="menu_button" style="flex-shrink:0;" title="Set time"><i class="fa-solid fa-check"></i></button>
                        </div>
                        <div style="font-size:0.78em;opacity:0.5;margin-top:3px;">Auto +<input type="number" id="wo_minutes_per_exchange" class="text_pole" style="width:44px;display:inline;padding:1px 4px;font-size:1em;" /> min per exchange</div>
                    </div>

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
                    <div id="wo_book_info" class="wo_book_info" style="margin-top:6px;"></div>
                    <label style="margin-top:4px;"><small>Scan entries at position</small></label>
                    <select id="wo_scan_position" class="text_pole" style="margin-bottom:6px;">
                        <option value="before_char">before_char</option>
                        <option value="after_char">after_char</option>
                    </select>
                    <div class="wo_section_label">Scene Detection (Info Block mode)</div>
                    <label class="checkbox_label">
                        <input type="checkbox" id="wo_keyword_scan" ${s.infoblockKeywordScan ? 'checked' : ''} />
                        <span>Also scan recent messages by keywords</span>
                    </label>
                    <label><small>Messages to scan for keywords</small></label>
                    <input type="number" id="wo_keyword_depth" class="text_pole" value="${s.keywordScanDepth || 2}" min="1" max="20" />
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

            <!-- ── Section: NPC Management ── -->
            <div class="wo_accordion">
                <div class="wo_accordion_header" data-target="wo_sec_add">
                    <span><i class="fa-solid fa-users-gear"></i> NPC Management</span>
                    <i class="fa-solid fa-chevron-down wo_acc_icon"></i>
                </div>
                <div class="wo_accordion_body" id="wo_sec_add" style="display:none;">

                    <div class="wo_section_label" style="margin-top:6px;">Add new NPC</div>
                    <input type="text" id="wo_manual_name" class="text_pole" placeholder="Name" style="margin-bottom:4px;" />
                    <textarea id="wo_manual_desc" class="text_pole" placeholder="Description (optional)" rows="3" style="resize:vertical;margin-bottom:4px;"></textarea>
                    <button id="wo_manual_add" class="menu_button" style="width:100%;"><i class="fa-solid fa-user-plus"></i> Add NPC</button>

                    <div class="wo_section_label" style="margin-top:12px;">Edit existing NPC</div>
                    <select id="wo_edit_npc_select" class="text_pole" style="margin-bottom:6px;">
                        <option value="">— select NPC —</option>
                    </select>
                    <div id="wo_edit_npc_panel" style="display:none;">
                        <label><small>Notes <span style="opacity:0.5;">(always sent to AI, overrides lorebook if contradicts)</span></small></label>
                        <textarea id="wo_edit_notes" class="text_pole" placeholder="e.g. currently pregnant, in conflict with Parfyonov..." rows="2" style="resize:vertical;margin-bottom:6px;"></textarea>
                        <label><small>Description</small></label>
                        <textarea id="wo_edit_desc" class="text_pole" rows="5" style="resize:vertical;margin-bottom:4px;"></textarea>
                        <div class="wo_actions">
                            <button id="wo_edit_save" class="menu_button"><i class="fa-solid fa-floppy-disk"></i> Save</button>
                            <button id="wo_edit_reset" class="menu_button" style="opacity:0.6;" title="Restore lorebook description"><i class="fa-solid fa-rotate-left"></i> Reset desc</button>
                        </div>
                    </div>

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
            const s = getSettings();
            if (s.sceneMode === 'text') {
                const it = getInternalTime();
                if (it) {
                    $('#wo_date_display').text(it.date + ' • ' + it.time);
                } else {
                    $('#wo_date_display').text('No time set — enter below');
                }
                return;
            }
            const ctx = SillyTavern.getContext();
            const chat = ctx.chat || [];
            const lastMsg = [...chat].reverse().find(m => m.mes && hasDatePattern(m.mes));
            const dateStr = lastMsg ? extractDateFromMessage(lastMsg.mes) : null;
            $('#wo_date_display').text(dateStr || '');
        } catch(e) {
            $('#wo_date_display').text('');
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

    // Scene mode buttons
    function updateSceneModeButtons() {
        const mode = getSettings().sceneMode || 'infoblock';
        $('.wo_scene_mode_btn').each(function() {
            $(this).toggleClass('wo_lang_active', $(this).data('mode') === mode);
        });
        if (mode === 'text') {
            $('#wo_time_controls').show();
            $('#wo_minutes_per_exchange').val(getSettings().minutesPerExchange || 5);
        } else {
            $('#wo_time_controls').hide();
        }
        updateDateDisplay();
    }
    updateSceneModeButtons();

    $('.wo_scene_mode_btn').on('click', function() {
        const s = getSettings();
        s.sceneMode = $(this).data('mode');
        saveSettingsDebounced();
        updateSceneModeButtons();
    });

    $('#wo_time_set').on('click', () => {
        const dateVal = $('#wo_time_date').val().trim();
        const timeVal = $('#wo_time_hhmm').val().trim();
        if (!dateVal || !timeVal) { toastr.warning('Enter both date and time.'); return; }
        if (!/^\d{4}\/\d{2}\/\d{2}$/.test(dateVal)) { toastr.warning('Date must be YYYY/MM/DD'); return; }
        if (!/^\d{2}:\d{2}$/.test(timeVal)) { toastr.warning('Time must be HH:MM'); return; }
        saveInternalTime(dateVal, timeVal);
        updateDateDisplay();
        toastr.success('Time set to ' + dateVal + ' ' + timeVal);
    });

    $('#wo_minutes_per_exchange').on('input', function() {
        const s = getSettings();
        s.minutesPerExchange = parseInt(this.value) || 5;
        saveSettingsDebounced();
    });

    // Pre-fill time inputs from current internal time if set
    function refreshTimeInputs() {
        const it = getInternalTime();
        if (it) {
            $('#wo_time_date').val(it.date);
            $('#wo_time_hhmm').val(it.time);
        }
    }
    refreshTimeInputs();

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

    $('#wo_keyword_scan').on('change', function () { s.infoblockKeywordScan = this.checked; saveSettingsDebounced(); });
    $('#wo_keyword_depth').on('input', function () { s.keywordScanDepth = parseInt(this.value) || 2; saveSettingsDebounced(); });
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

    // Edit NPC panel
    populateEditSelect();

    $('#wo_edit_npc_select').on('change', function() {
        const name = this.value;
        if (!name) { $('#wo_edit_npc_panel').hide(); return; }
        const npcs = getNPCs();
        const npc = npcs[name];
        if (!npc) return;
        $('#wo_edit_notes').val(npc.notes || '');
        $('#wo_edit_desc').val(npc.description || '');
        $('#wo_edit_npc_panel').show();
    });

    $('#wo_edit_save').on('click', async () => {
        const name = $('#wo_edit_npc_select').val();
        if (!name) return;
        const s = getSettings();
        const botKey = getBotKey();
        if (!s.npcData?.[botKey]?.__npcs?.[name]) return;
        s.npcData[botKey].__npcs[name].notes = $('#wo_edit_notes').val().trim();
        s.npcData[botKey].__npcs[name].description = $('#wo_edit_desc').val().trim();
        saveSettingsDebounced();
        renderNPCList();
        populateEditSelect();
        toastr.success('NPC updated.');
    });

    $('#wo_edit_reset').on('click', async () => {
        const name = $('#wo_edit_npc_select').val();
        if (!name) return;
        const s = getSettings();
        const botKey = getBotKey();
        if (!s.npcData?.[botKey]?.__npcs?.[name]) return;
        const lb = s.npcData[botKey].__npcs[name].lorebookDescription || '';
        s.npcData[botKey].__npcs[name].description = lb;
        $('#wo_edit_desc').val(lb);
        saveSettingsDebounced();
        renderNPCList();
        toastr.success('Description reset to lorebook.');
    });

    // Refresh edit select when NPC list changes
    const _origRenderNPCList = renderNPCList;

    $('#wo_generate_now').on('click', async () => {
        if (!getConnectionProfiles().length) {
            toastr.error('No ST Connection Profiles found. Create one in SillyTavern settings first.');
            return;
        }
        await runGenerationCycle();
    });

    
    // Shared handler for bot message — called by both CHARACTER_MESSAGE_RENDERED and MESSAGE_RECEIVED
    // Uses lastProcessedMsgId to deduplicate (both events can fire for same message)
    async function onBotMessageDone() {
        // Advance internal time in text mode (once per bot message = one exchange)
        if (getSettings().sceneMode === 'text' && getInternalTime()) {
            advanceInternalTime();
        }
        updateDateDisplay();

        // Auto-clear pendingIntro if NPC appeared in infoblock or recent messages
        try {
            const ctx = SillyTavern.getContext();
            const lastMsg = (ctx.chat || []).slice(-1)[0];

            // Deduplicate: skip if already processed this message
            const msgId = lastMsg?.send_date + '_' + (lastMsg?.mes?.length || 0);
            if (msgId === lastProcessedMsgId) return;
            lastProcessedMsgId = msgId;

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
                    } else if (s.activeIntros?.[name]) {
                        delete s.activeIntros[name];
                        changed = true;
                    }
                }
                if (changed) { saveSettingsDebounced(); renderNPCList(); }
            }
        } catch(e) {}

        if (isGenerating) return;

        const s = getSettings();
        if (!s.enabled) return;

        try {
            const ctx = SillyTavern.getContext();
            const currentLength = (ctx.chat || []).length;

            // Reroll = same length AND last bot message content changed
            const lastMsg = (ctx.chat || []).slice(-1)[0];
            const lastMsgIsBot = lastMsg && !lastMsg.is_user && !lastMsg.is_system;
            const currentMsgId = lastMsgIsBot ? (lastMsg.mes || '').slice(0, 80) : null;

            const lengthUnchanged = currentLength === lastChatLength && currentLength > 0;
            const contentChanged = currentMsgId !== null && currentMsgId !== lastBotMessageId;
            const isReroll = lengthUnchanged && contentChanged && lastBotMessageId !== null;

            lastChatLength = currentLength;
            if (currentMsgId) lastBotMessageId = currentMsgId;

            if (isReroll) {
                console.log('[WildOffscreen] Reroll confirmed — content changed, removing last events');
                const npcs = getNPCs();
                let removed = 0;
                for (const key of Object.keys(npcs)) {
                    if (!npcs[key].enabled || !npcs[key].events.length) continue;
                    const lastEvent = npcs[key].events[npcs[key].events.length - 1];
                    npcs[key].events.pop();
                    // Also remove auto-promoted fact that matches this event (if any)
                    if (lastEvent && npcs[key].permanentFacts) {
                        const factIdx = npcs[key].permanentFacts.findIndex(
                            f => f.auto && f.text === lastEvent.text
                        );
                        if (factIdx !== -1) npcs[key].permanentFacts.splice(factIdx, 1);
                    }
                    removed++;
                }
                if (removed > 0) {
                    await saveNPCs(npcs);
                    renderNPCList();
                    updateInjection();
                }
                msgCounter = s.triggerEvery;
            } else if (lengthUnchanged && !contentChanged && lastBotMessageId !== null) {
                console.log('[WildOffscreen] Same message seen again — skipping');
                return;
            }
        } catch(e) {
            console.warn('[WildOffscreen] onBotMessageDone error:', e.message);
        }

        msgCounter++;
        console.log('[WildOffscreen] msgCounter:', msgCounter, '/', s.triggerEvery);
        if (msgCounter >= s.triggerEvery) {
            msgCounter = 0;
            runGenerationCycle();
        }
    }

    // Two events for redundancy — whichever fires first processes, second is deduped
    eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, onBotMessageDone);
    eventSource.on(event_types.MESSAGE_RECEIVED, onBotMessageDone);

    eventSource.on(event_types.USER_MESSAGE_RENDERED, () => {
        updateDateDisplay();
    });

    let _lastBotKey = getBotKey();
    let _lastChatKey = getChatKey();

    eventSource.on(event_types.CHAT_CHANGED, () => {
        msgCounter = 0;
        lastChatLength = 0;
        lastBotMessageId = null;
        setTimeout(async () => {
            try {
                const ctx = SillyTavern.getContext();
                lastChatLength = (ctx.chat || []).length;
            } catch(e) {}

            const newBotKey  = getBotKey();
            const newChatKey = getChatKey();
            const chatChanged = newChatKey !== _lastChatKey || newBotKey !== _lastBotKey;

            if (chatChanged) {
                const s = getSettings();
                // Returning to old chat = has stored NPC data (excluding only __internalTime)
                const chatStore = s.npcData?.[newBotKey]?.[newChatKey] || {};
                const hasExistingData = Object.keys(chatStore).some(k => k !== '__internalTime');

                if (!hasExistingData) {
                    await clearChatData();
                    toastr.info('New chat — NPC events cleared. Characters retained.');
                }
            }

            _lastBotKey  = newBotKey;
            _lastChatKey = newChatKey;

            renderNPCList();
            updateInjection();
            updateSceneModeButtons();
            updateDateDisplay();
            if (typeof refreshTimeInputs === 'function') refreshTimeInputs();
            $('#wo_book_info').html('Bot: ' + getBotKey());
        }, 300);
    });

    updateInjection();
});