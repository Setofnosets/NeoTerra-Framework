/**
 * Render the six Neo Terra prompt blocks from a WorldState.
 *
 * The renderer is pure: it reads state through selectors, never mutates it,
 * and never touches the DOM or SillyTavern globals. Static map coordinates are
 * intentionally absent — the map panel owns the image and its nodes; prompt
 * context only needs names, control, and live state.
 */

import { applyContentGate } from '../core/content-gate.js';
import { DEFAULT_SETTINGS } from '../core/defaults.js';
import { isClockHeld } from '../core/world-clock.js';
import { buildRegistryIndex } from '../data/registry.js';
import { buildNewspaperView } from '../data/newsroom.js';
import { buildDomainView } from '../data/domain.js';
import {
    selectOpenBeats,
    selectPlayerView,
    selectPresentCast,
} from '../state/selectors.js';
import {
    BLOCK_PRIORITY,
    applyTokenBudget,
    estimateTokens,
} from './budget.js';
import { buildCastProfiles } from './worldbook.js';

export const BLOCK_HEADINGS = Object.freeze({
    scene: '[NEOTERRA_SCENE]',
    cast: '[NEOTERRA_CAST]',
    player: '[NEOTERRA_PLAYER]',
    combat: '[NEOTERRA_COMBAT]',
    world: '[NEOTERRA_WORLD]',
    continuity: '[NEOTERRA_CONTINUITY]',
    lore: '[NEOTERRA_LORE]',
    pacing: '[NEOTERRA_PACING]',
    news: '[NEOTERRA_NEWS]',
    domain: '[NEOTERRA_DOMAIN]',
});

export const BLOCK_ORDER = Object.freeze(Object.keys(BLOCK_HEADINGS));

function isObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function characterName(state, characterId) {
    if (characterId === 'player' && state?.player?.identity !== 'canon') {
        return state?.player?.displayName ?? 'The Player';
    }
    const character = state?.characters?.[characterId];
    return character?.displayName ?? character?.charId ?? characterId;
}

function factionName(state, factionId) {
    if (!factionId) {
        return null;
    }
    return state?.factions?.[factionId]?.name ?? factionId;
}

function formatResource(resource) {
    if (!isObject(resource)) {
        return null;
    }
    const current = Number(resource.current);
    const max = Number(resource.max);
    if (!Number.isFinite(current) || !Number.isFinite(max)) {
        return null;
    }
    return `${Math.round(current)}/${Math.round(max)}`;
}

function firstSentence(text, maxLength = 180) {
    const value = String(text ?? '').trim();
    if (value.length === 0) {
        return '';
    }
    const match = value.match(/^.*?[.!?](?:\s|$)/);
    const sentence = (match ? match[0] : value).trim();
    return sentence.length > maxLength ? `${sentence.slice(0, maxLength - 1)}…` : sentence;
}

function makeBlock(id, lines, settings) {
    const body = (lines ?? []).filter((line) => typeof line === 'string' && line.length > 0).join('\n');
    if (body.length === 0) {
        return null;
    }
    const gateLevel = settings.__gateLevel ?? 'full';
    const limits = settings.__limits ?? {};
    const context = settings.__gateContext ?? {};
    const gated = applyContentGate(body, gateLevel, limits, context);
    if (gated.trim().length === 0) {
        return null;
    }
    return {
        id,
        heading: BLOCK_HEADINGS[id],
        body: gated,
        priority: BLOCK_PRIORITY[id] ?? 99,
    };
}

function renderScene(state, settings) {
    const scene = state?.scene ?? {};
    const location = state?.locations?.[scene.locationId] ?? null;
    const lines = [];

    if (location) {
        const district = location.district ? ` — ${location.district}` : '';
        lines.push(`Location: ${location.name ?? location.id}${district}`);
        const control = factionName(state, location.factionId);
        if (control || location.status) {
            const status = location.status ? ` (${location.status})` : '';
            lines.push(`Control: ${control ?? 'unclaimed'}${status}`);
        }
    }

    const date = state?.meta?.inGameDate;
    const time = state?.meta?.timeOfDay;
    const frozen = isClockHeld(state);
    if (date || time) {
        const suffix = frozen ? ' (time frozen)' : '';
        lines.push(`Time: ${[date, time].filter(Boolean).join(', ')}${suffix}`);
    } else if (frozen) {
        lines.push('Time: (time frozen)');
    }

    const present = Array.isArray(scene.present) ? scene.present : [];
    if (present.length > 0) {
        lines.push(`Present: ${present.map((id) => characterName(state, id)).join(', ')}`);
    }

    // The encounter is derived state written by the scene flow. It belongs in
    // the scene block so the model knows who is hostile without a new block.
    // A record from another location (a failed cast refresh) is ignored.
    const encounter = isObject(scene.encounter)
        && (typeof scene.encounter.locationId !== 'string'
            || scene.encounter.locationId === scene.locationId)
        ? scene.encounter
        : null;
    if (encounter) {
        const hostileIds = Array.isArray(encounter.characterIds) ? encounter.characterIds : [];
        if (hostileIds.length > 0) {
            lines.push(`Encounter: ${hostileIds.map((id) => characterName(state, id)).join(', ')}`);
        }
        const threats = Array.isArray(encounter.threatNames) ? encounter.threatNames : [];
        if (threats.length > 0) {
            lines.push(`Threats here: ${threats.join(', ')}`);
        }
    }

    if (typeof scene.framing === 'string' && scene.framing.trim().length > 0) {
        lines.push(`Framing: ${scene.framing.trim()}`);
    }

    if (lines.length === 0) {
        return null;
    }
    return makeBlock('scene', lines, settings);
}

function renderCast(state, options, settings, tokenBudget) {
    const present = selectPresentCast(state).filter(
        (character) => character.controlledBy !== 'player',
    );
    if (present.length === 0) {
        return null;
    }

    const registryIndex = options.registry
        ? buildRegistryIndex(options.registry)
        : options.registryIndex ?? null;
    const profiles = buildCastProfiles(present, {
        registryIndex,
        getLocation: (locationId) => state?.locations?.[locationId] ?? null,
        maxTokens: tokenBudget.characterProfile ?? DEFAULT_SETTINGS.tokenBudget.characterProfile,
        totalTokens: tokenBudget.cast,
        gateLevel: settings.__gateLevel,
        limits: settings.__limits,
    });

    const lines = profiles
        .map((profile) => profile.text)
        .filter((text) => typeof text === 'string' && text.length > 0);
    if (lines.length === 0) {
        return null;
    }
    return makeBlock('cast', lines, settings);
}

function renderPlayer(state, settings) {
    const player = selectPlayerView(state);
    if (!player || !isObject(state?.player)) {
        return null;
    }
    const character = player.character ?? state.player;
    const lines = [];

    const displayName = player.displayName || character.displayName;
    if (displayName) {
        lines.push(`Name: ${displayName}`);
        lines.push(`Player card: ${displayName} (address the player as ${displayName})`);
    }
    const identity = player.identity === 'canon'
        ? `canon (${player.characterId ?? 'unknown'})`
        : 'custom persona';
    lines.push(`Identity: ${identity}`);
    if (state.playerRole) {
        lines.push(`Role: ${state.playerRole}`);
    }
    if (character.formId) {
        lines.push(`Form: ${character.formId}`);
    }
    if (character.status) {
        lines.push(`Status: ${character.status}`);
    }
    const stamina = formatResource(character.stamina);
    const willpower = formatResource(character.willpower);
    if (stamina || willpower) {
        lines.push(`Resources: stamina ${stamina ?? '—'}; willpower ${willpower ?? '—'}`);
    }
    if (isObject(character.corruption)
        && (Number(character.corruption.stage) > 0 || Number(character.corruption.progress) > 0)) {
        lines.push(`Corruption: stage ${character.corruption.stage ?? 0} (${character.corruption.progress ?? 0}%)`);
    }
    if (character.agenda) {
        lines.push(`Agenda: ${character.agenda}`);
    }
    if (Array.isArray(character.goals) && character.goals.length > 0) {
        const combined = character.goals.join(', ');
        const budget = Math.max(80, 240 - (character.agenda?.length ?? 0) - 'Goals: '.length);
        lines.push(`Goals: ${combined.length > budget ? `${combined.slice(0, budget - 1).trimEnd()}…` : combined}`);
    }
    if (character.outfit) {
        lines.push(`Outfit: ${character.outfit}`);
    }
    if (character.appearance) {
        lines.push(`Appearance: ${character.appearance}`);
    }
    if (player.personaNotes) {
        lines.push(`Persona: ${player.personaNotes}`);
    }
    const guest = state?.flags?.guestCharacter ?? null;
    if (guest?.characterId) {
        lines.push(
            `Non-canon guest: ${guest.characterId} belongs to ${guest.homeSeasonId ?? 'another season'} `
            + `and is visiting ${state?.seasonId ?? 'this season'}.`,
        );
        lines.push(
            'Treat the era and home-season mismatch as real: no future knowledge, no canon foresight, '
            + 'and beats that depend on this character adapt instead of failing.',
        );
    }
    if (lines.length === 0) {
        return null;
    }
    return makeBlock('player', lines, {
        ...settings,
        __gateContext: {
            isPlayer: true,
            characterId: player.identity === 'canon' ? player.characterId : null,
        },
    });
}

function combatParticipantEntry(state, characterId) {
    if (characterId === 'player' && state?.player?.identity !== 'canon') {
        return isObject(state?.player) ? state.player : null;
    }
    return state?.characters?.[characterId] ?? null;
}

function formatMargin(value) {
    const number = Number(value);
    if (!Number.isFinite(number)) {
        return '—';
    }
    return number >= 0 ? `+${number}` : String(number);
}

function renderCombat(state, settings) {
    const combat = isObject(state?.scene?.combat) ? state.scene.combat : null;
    if (!combat && state?.meta?.inCombat !== true) {
        return null;
    }
    const active = combat ?? {};
    const participants = Array.isArray(active.participants) ? active.participants : [];
    const sides = isObject(active.sides) ? active.sides : {};
    const round = Number.isInteger(active.round) ? active.round : 0;
    const maxRounds = Number.isInteger(active.maxRounds) ? active.maxRounds : 8;
    const lines = [];

    const kind = active.kind ?? 'skirmish';
    const stakes = typeof active.stakes === 'string' && active.stakes.length > 0
        ? ` — stakes: ${active.stakes}`
        : '';
    lines.push(`Conflict: ${kind}${stakes}`);
    if (typeof active.intent === 'string' && active.intent.length > 0) {
        lines.push(`Intent: ${active.intent}`);
    }
    lines.push(`Round: ${round}/${maxRounds}`);

    if (participants.length > 0) {
        lines.push('Participants:');
        for (const participantId of participants) {
            const entry = combatParticipantEntry(state, participantId);
            const side = sides[participantId] ? `side ${sides[participantId]}` : 'side unknown';
            const name = characterName(state, participantId);
            const status = entry?.status ?? 'active';
            const stamina = formatResource(entry?.stamina) ?? '—';
            const willpower = formatResource(entry?.willpower) ?? '—';
            lines.push(`- ${side}: ${name} — ${status}, stamina ${stamina}, willpower ${willpower}`);
        }
    }

    const actions = Array.isArray(active.actions) ? active.actions : [];
    const last = actions.length > 0 ? actions[actions.length - 1] : null;
    if (isObject(last)) {
        const actor = characterName(state, last.actorId);
        const target = last.targetId ? ` → ${characterName(state, last.targetId)}` : '';
        lines.push(
            `Last action: ${actor} — ${last.action ?? 'unknown'}${target}, risk ${last.risk ?? 'unknown'}, tier ${last.tier ?? 'unknown'}, margin ${formatMargin(last.margin)}`,
        );
        if (typeof last.contract === 'string' && last.contract.length > 0) {
            lines.push(`Outcome contract: ${last.contract}`);
        }
    }
    lines.push('Describe only the resolved result. Do not decide outcomes, invent numbers, or add HP/damage.');
    return makeBlock('combat', lines, settings);
}

function renderWorld(state, settings) {
    const lines = [];
    const factions = Object.values(state?.factions ?? {}).filter(isObject);
    if (factions.length > 0) {
        lines.push('Factions:');
        for (const faction of factions) {
            const facts = [
                faction.side,
                Number.isFinite(faction.influence) ? `influence ${faction.influence}` : null,
                faction.status,
            ].filter(Boolean).join(', ');
            lines.push(`- ${faction.name ?? faction.id}${facts ? ` — ${facts}` : ''}`);
            if (Array.isArray(faction.goals) && faction.goals.length > 0) {
                lines.push(`  Goals: ${faction.goals.join('; ')}`);
            }
        }
    }

    const threats = Array.isArray(state?.threats) ? state.threats.filter(isObject) : [];
    if (threats.length > 0) {
        lines.push('Threats:');
        for (const threat of threats) {
            const stages = Array.isArray(threat.stages) ? threat.stages : [];
            const stageIndex = Number.isFinite(threat.stage) ? threat.stage : 0;
            const stageLabel = stages[stageIndex] ? `: ${stages[stageIndex]}` : '';
            const stageText = stages.length > 0
                ? `stage ${Math.min(stageIndex + 1, stages.length)}/${stages.length}${stageLabel}`
                : null;
            const facts = [
                threat.rank,
                threat.status,
                stageText,
                Number.isFinite(threat.progress) ? `${threat.progress}%` : null,
            ].filter(Boolean).join(', ');
            lines.push(`- ${threat.name ?? threat.id} — ${facts}`);
            if (threat.agenda) {
                lines.push(`  Agenda: ${threat.agenda}`);
            }
        }
    }

    const events = Array.isArray(state?.recentEvents) ? state.recentEvents : [];
    const headlines = events
        .slice(-3)
        .map((event) => event?.headline ?? event?.summary)
        .filter((value) => typeof value === 'string' && value.length > 0);
    if (headlines.length > 0) {
        lines.push('Headlines:');
        for (const headline of headlines) {
            lines.push(`- ${headline}`);
        }
    }

    if (lines.length === 0) {
        return null;
    }
    return makeBlock('world', lines, settings);
}

function renderContinuity(state, settings) {
    const ending = isObject(state?.ending) ? state.ending : { status: 'none' };
    const badEnds = Object.entries(state?.badEnds ?? {});
    if (ending.status === 'none' && badEnds.length === 0) {
        return null;
    }

    const lines = [];
    if (ending.status && ending.status !== 'none') {
        const path = ending.path ? `, path: ${ending.path}` : '';
        lines.push(`Ending: ${ending.status}${path}`);
        if (ending.firedTurn !== undefined && ending.firedTurn !== null) {
            lines.push(`Ending fired at turn ${ending.firedTurn}`);
        }
    }
    if (state?.arc && state.arc !== 'season') {
        lines.push(`Arc: ${state.arc}`);
    }
    if (badEnds.length > 0) {
        lines.push('Bad ends:');
        for (const [characterId, record] of badEnds) {
            const name = characterName(state, characterId);
            const cause = record?.cause ? ` — ${record.cause}` : '';
            lines.push(`- ${name}: ${record?.type ?? 'unknown'}${cause}`);
            const epilogue = firstSentence(record?.epilogueText);
            if (epilogue) {
                lines.push(`  ${epilogue}`);
            }
        }
    }
    return makeBlock('continuity', lines, settings);
}

const PACING_BLOCK_LEVELS = Object.freeze(['nudge', 'cut', 'stalled']);

/**
 * Advisory pacing directive. It never carries state or outcomes: only the
 * already-persisted analysis facts plus a "move the scene" instruction.
 */
function renderPacing(state, settings) {
    const pacing = isObject(state?.flags?.pacing) ? state.flags.pacing : null;
    if (!pacing || !PACING_BLOCK_LEVELS.includes(pacing.level)) {
        return null;
    }
    if (settings?.pacing?.enabled === false) {
        return null;
    }
    const endingStatus = state?.ending?.status;
    if (endingStatus === 'epilogue' || endingStatus === 'ended') {
        return null;
    }
    if (state?.meta?.inCombat === true || isObject(state?.scene?.combat)) {
        return null;
    }

    const held = isClockHeld(state) || pacing.held === true;
    const lines = [];
    const reasons = Array.isArray(pacing.reasons)
        ? pacing.reasons.filter((reason) => typeof reason === 'string' && reason.length > 0)
        : [];
    for (const reason of reasons.slice(0, 2)) {
        lines.push(reason);
    }
    if (held) {
        const alreadyExplains = reasons.some((reason) => /time is frozen/i.test(reason));
        if (!alreadyExplains) {
            lines.push('Time is frozen in this scene.');
        }
        lines.push('Directive: stay in the moment. Do not cut forward, skip time, or move the player; the player decides when to release time.');
    } else {
        lines.push(`Pacing level: ${pacing.level}.`);
        lines.push('Directive: on your next reply, cut forward in time, raise a threat development, or break a stalled exchange. Do not invent outcomes, decide player actions, or move the player.');
    }
    return makeBlock('pacing', lines, settings);
}

function renderNews(state, settings) {
    const view = buildNewspaperView(state, settings);
    const latest = view.latest;
    if (!view.enabled || !latest) {
        return null;
    }
    const lines = [
        `Edition: ${latest.masthead} — ${latest.dateline}`,
    ];
    if (latest.date) {
        lines.push(`Date: ${latest.date}`);
    }
    for (const headline of (latest.headlines ?? []).slice(0, 2)) {
        lines.push(`- ${headline.title}${headline.section ? ` [${headline.section}]` : ''}`);
    }
    return makeBlock('news', lines, settings);
}

/**
 * Villain-POV domain framing. Only the season's authored `domain` block can
 * activate it; hero seasons and Sandbox render nothing.
 */
function renderDomain(state, options, settings) {
    const view = buildDomainView({
        state,
        season: options.season ?? null,
        registry: options.registry ?? options.registryIndex ?? null,
    });
    if (!view.active) {
        return null;
    }
    const lines = [`Domain: ${view.wonderland.name}`];
    if (view.wonderland.description) {
        lines.push(view.wonderland.description);
    }
    if (view.knights.length > 0) {
        lines.push('Knights:');
        for (const knight of view.knights.slice(0, 4)) {
            const facts = [
                knight.active ? 'on duty' : 'latent',
                knight.locationName ?? 'location unknown',
                `corruption ${knight.corruptionStage}`,
                `affinity ${knight.affinity}`,
            ].join(', ');
            lines.push(`- ${knight.name} — ${facts}`);
        }
    }
    const spread = Object.entries(view.corruptionSpread.byStage ?? {})
        .sort(([a], [b]) => Number(a) - Number(b))
        .map(([stage, count]) => `stage ${stage}: ${count}`);
    if (spread.length > 0) {
        lines.push(`Corruption: ${spread.join(', ')}`);
    }
    const counts = view.territory.counts ?? {};
    lines.push(
        `Territory: ${counts.controlled ?? 0} controlled, ${counts.contested ?? 0} contested, `
        + `${counts.hostile ?? 0} hostile of ${counts.districts ?? 0} districts`
        + (view.territory.headquartersName ? `; seat: ${view.territory.headquartersName}` : ''),
    );
    if (view.resistance.length > 0) {
        lines.push('Resistance:');
        for (const threat of view.resistance.slice(0, 3)) {
            const stage = threat.stageCount > 0
                ? ` (stage ${threat.stageIndex + 1}/${threat.stageCount})`
                : '';
            lines.push(`- ${threat.name} — ${threat.stageLabel}${stage}, ${threat.progress}%`);
        }
    }
    lines.push('The player rules this domain as its villain. Treat the player as the city\'s antagonist; the resistance is the danger, not the protagonist.');
    return makeBlock('domain', lines, settings);
}

function renderLore(state, options, settings) {
    const lines = [];
    const beats = selectOpenBeats(state, options.season).slice(0, 3);
    if (beats.length > 0) {
        lines.push('Open story beats:');
        for (const beat of beats) {
            lines.push(`- [${beat.act ?? 'open'}] ${beat.title ?? beat.id}${beat.description ? ` — ${beat.description}` : ''}`);
            if (beat.deadlineConsequence) {
                lines.push(`  If missed: ${beat.deadlineConsequence}`);
            }
        }
    }

    const present = new Set(selectPresentCast(state).map((character) => character.charId));
    const relationships = (Array.isArray(state?.relationships) ? state.relationships : [])
        .filter((relationship) => present.has(relationship.a) || present.has(relationship.b));
    if (relationships.length > 0) {
        lines.push('Relationships:');
        for (const relationship of relationships) {
            const a = characterName(state, relationship.a);
            const b = characterName(state, relationship.b);
            const facts = [
                relationship.type,
                Number.isFinite(relationship.affinity) ? `affinity ${relationship.affinity}` : null,
                Number.isFinite(relationship.tension) ? `tension ${relationship.tension}` : null,
            ].filter(Boolean).join(', ');
            lines.push(`- ${a} ↔ ${b}${facts ? ` — ${facts}` : ''}${relationship.notes ? `: ${relationship.notes}` : ''}`);
        }
    }

    const extra = Array.isArray(options.loreEntries) ? options.loreEntries : [];
    if (extra.length > 0) {
        lines.push('Lore:');
        for (const entry of extra) {
            if (typeof entry === 'string' && entry.length > 0) {
                lines.push(`- ${entry}`);
            } else if (isObject(entry)) {
                const title = entry.title ?? entry.name ?? entry.id;
                const content = entry.content ?? entry.text ?? entry.description;
                if (title || content) {
                    lines.push(`- ${[title, content].filter(Boolean).join(': ')}`);
                }
            }
        }
    }

    if (lines.length === 0) {
        return null;
    }
    return makeBlock('lore', lines, settings);
}

function blockEnabled(settings, options, id) {
    const fromOptions = options?.blocks?.[id];
    if (typeof fromOptions === 'boolean') {
        return fromOptions;
    }
    const fromSettings = settings?.context?.blocks?.[id];
    if (typeof fromSettings === 'boolean') {
        return fromSettings;
    }
    return true;
}

/**
 * Render the Neo Terra context blocks.
 *
 * @param {object} state WorldState
 * @param {{
 *   settings?: object,
 *   season?: object|null,
 *   registry?: object|null,
 *   registryIndex?: object|null,
 *   loreEntries?: Array<string|object>,
 *   gateLevel?: string,
 *   limits?: object,
 *   tokenBudget?: object,
 *   blocks?: Record<string, boolean>,
 * }} [options]
 * @returns {{
 *   blocks: Array<{id: string, heading: string, body: string, text: string, tokens: number}>,
 *   text: string,
 *   tokens: number,
 *   totalTokens: number,
 *   dropped: string[],
 *   truncated: string[],
 *   gateLevel: string,
 * }}
 */
export function renderContext(state, options = {}) {
    const settings = options.settings ?? DEFAULT_SETTINGS;
    if (!isObject(state) || settings.context?.enabled === false) {
        return {
            blocks: [],
            text: '',
            tokens: 0,
            totalTokens: 0,
            dropped: [],
            truncated: [],
            gateLevel: options.gateLevel ?? settings.contentGate ?? 'full',
        };
    }

    const gateLevel = options.gateLevel ?? settings.contentGate ?? 'full';
    const limits = options.limits ?? settings.contentLimits ?? {};
    const renderSettings = {
        ...settings,
        __gateLevel: gateLevel,
        __limits: limits,
        __gateContext: {},
    };
    const tokenBudget = options.tokenBudget ?? settings.tokenBudget ?? DEFAULT_SETTINGS.tokenBudget;

    const candidates = [
        renderScene(state, renderSettings),
        renderCast(state, options, renderSettings, tokenBudget),
        renderPlayer(state, renderSettings),
        renderCombat(state, renderSettings),
        renderWorld(state, renderSettings),
        renderContinuity(state, renderSettings),
        renderLore(state, options, renderSettings),
        renderPacing(state, renderSettings),
        renderNews(state, renderSettings),
        renderDomain(state, options, renderSettings),
    ].filter((block) => block && blockEnabled(settings, options, block.id));

    const result = applyTokenBudget(candidates, tokenBudget);

    return {
        blocks: result.blocks,
        text: result.text,
        tokens: estimateTokens(result.text),
        totalTokens: result.totalTokens,
        dropped: result.dropped,
        truncated: result.truncated,
        gateLevel,
    };
}

/** Convenience wrapper for callers that only need the prompt text. */
export function renderContextText(state, options = {}) {
    return renderContext(state, options).text;
}
