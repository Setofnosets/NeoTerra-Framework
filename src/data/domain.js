/**
 * Generic villain-domain view model.
 *
 * Any villain-POV season can author an optional `domain` block; this module
 * turns the live WorldState into the Domain tab and the `[NEOTERRA_DOMAIN]`
 * prompt block. It is pure and Node-safe: no DOM, no network, no state writes.
 *
 * The domain follows the *season*, not the played identity: a villain season
 * keeps its domain even if the player switches to a hero card.
 */

function isObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function asArray(value) {
    return Array.isArray(value) ? value : [];
}

function finiteNumber(value, fallback = 0) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
}

function entriesOf(document) {
    if (Array.isArray(document)) {
        return document;
    }
    if (Array.isArray(document?.entries)) {
        return document.entries;
    }
    // Callers may hand the renderer a prebuilt `{byId}` registry index.
    if (isObject(document?.byId)) {
        return Object.values(document.byId).filter(isObject);
    }
    return [];
}

function playerId(state) {
    return state?.player?.identity === 'canon' && typeof state.player.characterId === 'string'
        ? state.player.characterId
        : 'player';
}

function threatStage(threat) {
    const stages = asArray(threat?.stages);
    if (stages.length === 0) {
        return { index: 0, label: 'unknown', count: 0 };
    }
    const fromProgress = Math.min(
        stages.length - 1,
        Math.max(0, Math.floor(finiteNumber(threat.progress) / (100 / stages.length))),
    );
    const index = Number.isInteger(threat?.stage) ? Math.min(stages.length - 1, threat.stage) : fromProgress;
    return {
        index,
        label: stages[index] ?? 'unknown',
        count: stages.length,
    };
}

function relationshipTo(state, targetId) {
    const id = playerId(state);
    const records = [];
    for (const relationship of asArray(state?.relationships)) {
        if (!isObject(relationship)) {
            continue;
        }
        if ((relationship.a === id && relationship.b === targetId)
            || (relationship.a === targetId && relationship.b === id)) {
            records.push(relationship);
        }
    }
    for (const relationship of asArray(state?.player?.relationships)) {
        if (isObject(relationship) && relationship.withCharacterId === targetId) {
            records.push(relationship);
        }
    }
    return records[0] ?? null;
}

function hasOwnerServant(state, targetId) {
    const id = playerId(state);
    const isOwnerServant = (relationship) => isObject(relationship)
        && String(relationship.type ?? '').toLowerCase() === 'owner/servant';
    for (const relationship of asArray(state?.relationships)) {
        if (isOwnerServant(relationship)
            && ((relationship.a === id && relationship.b === targetId)
                || (relationship.a === targetId && relationship.b === id))) {
            return true;
        }
    }
    for (const relationship of asArray(state?.player?.relationships)) {
        if (isOwnerServant(relationship) && relationship.withCharacterId === targetId) {
            return true;
        }
    }
    return false;
}

function locationName(state, locationsById, locationId) {
    if (!locationId) {
        return null;
    }
    return state?.locations?.[locationId]?.name
        ?? locationsById.get(locationId)?.name
        ?? locationId;
}

function emptyView(reason) {
    return {
        active: false,
        reason,
        domain: null,
        wonderland: null,
        knights: [],
        court: [],
        corruptionSpread: { byStage: {}, total: 0, top: [] },
        territory: { districts: [], counts: {}, factionId: null, factionName: null, headquartersLocationId: null },
        resistance: [],
        feed: [],
    };
}

/**
 * Build the domain view.
 *
 * @param {{
 *   state: object|null,
 *   season: object|null,
 *   registry?: object|null,
 *   locations?: object|null,
 *   districts?: object|null,
 *   settings?: object,
 * }} [options]
 * @returns {object}
 */
export function buildDomainView({
    state = null,
    season = null,
    registry = null,
    locations = null,
    districts = null,
    settings = {},
} = {}) {
    const domain = isObject(season?.domain) ? season.domain : null;
    if (!domain) {
        return emptyView('no-domain');
    }
    if (season?.playerRole !== 'villain') {
        return emptyView('not-villain-pov');
    }
    if (!isObject(state)) {
        return emptyView('no-world');
    }

    const characters = isObject(state.characters) ? state.characters : {};
    const factions = isObject(state.factions) ? state.factions : {};
    const player = playerId(state);
    const domainFactionId = typeof domain.factionId === 'string' ? domain.factionId : null;
    const faction = domainFactionId ? factions[domainFactionId] ?? null : null;
    const authoredLocations = asArray(locations?.locations ?? locations);
    const locationsById = new Map(authoredLocations.map((entry) => [entry.id, entry]));
    const authoredDistricts = asArray(districts?.districts ?? districts);
    const districtById = new Map(authoredDistricts.map((entry) => [entry.id, entry]));

    // --- knights ---------------------------------------------------------
    const knightFormKind = typeof domain.knightFormKind === 'string' ? domain.knightFormKind : null;
    const knightEntries = knightFormKind
        ? entriesOf(registry).filter((entry) => entry?.formKind === knightFormKind
            // A future season may reuse the same form kind; the domain only
            // owns the knights of its own season.
            && (!entry.seasonId || !season?.id || entry.seasonId === season.id))
        : [];
    const knightGroups = new Set();
    const knightCharacterIds = new Set();
    const knights = knightEntries.map((entry) => {
        if (entry.formGroup) {
            knightGroups.add(entry.formGroup);
        }
        if (entry.altOf) {
            knightCharacterIds.add(entry.altOf);
        }
        knightCharacterIds.add(entry.id);
        const live = Object.values(characters).find((character) => character
            && (character.charId === entry.id
                || (entry.formGroup && character.formGroup === entry.formGroup)))
            ?? null;
        const baseId = entry.altOf ?? live?.charId ?? entry.id;
        const relationship = relationshipTo(state, baseId) ?? relationshipTo(state, live?.charId);
        return {
            id: entry.id,
            name: entry.displayName ?? entry.id,
            formGroup: entry.formGroup ?? null,
            formId: live?.formId ?? null,
            baseCharacterId: baseId,
            active: live?.formId === entry.id,
            status: live?.status ?? 'latent',
            locationId: live?.locationId ?? null,
            locationName: locationName(state, locationsById, live?.locationId),
            corruptionStage: finiteNumber(live?.corruption?.stage),
            corruptionProgress: finiteNumber(live?.corruption?.progress),
            affinity: relationship ? finiteNumber(relationship.affinity) : 0,
            tension: relationship ? finiteNumber(relationship.tension) : 0,
        };
    }).sort((a, b) => String(a.name).localeCompare(String(b.name)));

    // --- court / corruption ---------------------------------------------
    const court = [];
    const byStage = {};
    const progressRows = [];
    for (const character of Object.values(characters)) {
        if (!character || typeof character.charId !== 'string') {
            continue;
        }
        if (character.charId === player) {
            continue;
        }
        const stage = finiteNumber(character.corruption?.stage);
        const progress = finiteNumber(character.corruption?.progress);
        byStage[stage] = (byStage[stage] ?? 0) + 1;
        progressRows.push({ id: character.charId, name: character.displayName ?? character.charId, stage, progress });

        const isKnight = knightCharacterIds.has(character.charId)
            || (character.formGroup && knightGroups.has(character.formGroup));
        if (isKnight) {
            continue;
        }
        const reasons = [];
        if (stage > 0) {
            reasons.push('corruption');
        }
        const allegiance = String(character.allegiance ?? '').trim().toLowerCase();
        const domainSide = String(faction?.side ?? '').trim().toLowerCase();
        if (domainFactionId
            && (allegiance === domainFactionId.toLowerCase()
                || (domainSide.length > 0 && allegiance === domainSide))) {
            reasons.push('allegiance');
        }
        if (hasOwnerServant(state, character.charId)) {
            reasons.push('owner/servant');
        }
        if (reasons.length === 0) {
            continue;
        }
        court.push({
            id: character.charId,
            name: character.displayName ?? character.charId,
            side: character.side ?? 'unknown',
            status: character.status ?? 'active',
            allegiance: character.allegiance ?? null,
            corruptionStage: stage,
            corruptionProgress: progress,
            locationId: character.locationId ?? null,
            locationName: locationName(state, locationsById, character.locationId),
            reasons,
        });
    }
    court.sort((a, b) => b.corruptionStage - a.corruptionStage
        || String(a.name).localeCompare(String(b.name)));

    const corruptionSpread = {
        byStage,
        total: progressRows.length,
        top: progressRows
            .filter((row) => row.progress > 0)
            .sort((a, b) => b.progress - a.progress || String(a.name).localeCompare(String(b.name)))
            .slice(0, 5),
    };

    // --- territory --------------------------------------------------------
    const districtRows = [];
    const counts = { districts: 0, controlled: 0, contested: 0, hostile: 0, unclaimed: 0 };
    const authoredByDistrict = new Map();
    for (const location of authoredLocations) {
        if (!location?.districtId) {
            continue;
        }
        if (!authoredByDistrict.has(location.districtId)) {
            authoredByDistrict.set(location.districtId, []);
        }
        authoredByDistrict.get(location.districtId).push(location.id);
    }
    const districtIds = [...new Set([
        ...authoredDistricts.map((entry) => entry.id),
        ...authoredByDistrict.keys(),
    ])];
    // The prompt block may run without the authored location document. Fall
    // back to the district label kept on live location state so territory
    // counts still render.
    if (districtIds.length === 0) {
        const groups = new Map();
        for (const location of Object.values(state.locations ?? {})) {
            const label = location?.district ?? location?.id;
            if (!label) {
                continue;
            }
            if (!groups.has(label)) {
                groups.set(label, []);
            }
            groups.get(label).push(location);
        }
        for (const [label, group] of groups) {
            let controlled = 0;
            let hostile = 0;
            let neutral = 0;
            for (const location of group) {
                if (domainFactionId && location.factionId === domainFactionId) {
                    controlled += 1;
                } else if (location.factionId) {
                    hostile += 1;
                } else {
                    neutral += 1;
                }
            }
            const status = controlled > 0 && hostile === 0 && neutral === 0
                ? 'controlled'
                : controlled > 0
                    ? 'contested'
                    : hostile > 0 ? 'hostile' : 'unclaimed';
            counts[status] += 1;
            counts.districts += 1;
            districtRows.push({
                id: label,
                name: label,
                status,
                controlled,
                hostile,
                neutral,
                watched: false,
            });
        }
    }
    for (const districtId of districtIds) {
        const locationIds = authoredByDistrict.get(districtId) ?? [];
        let controlled = 0;
        let hostile = 0;
        let neutral = 0;
        for (const id of locationIds) {
            const factionId = state.locations?.[id]?.factionId ?? locationsById.get(id)?.factionId ?? null;
            if (domainFactionId && factionId === domainFactionId) {
                controlled += 1;
            } else if (factionId) {
                hostile += 1;
            } else {
                neutral += 1;
            }
        }
        const status = controlled > 0 && hostile === 0 && neutral === 0
            ? 'controlled'
            : controlled > 0
                ? 'contested'
                : hostile > 0 ? 'hostile' : 'unclaimed';
        counts[status] += 1;
        counts.districts += 1;
        districtRows.push({
            id: districtId,
            name: districtById.get(districtId)?.name ?? districtId,
            status,
            controlled,
            hostile,
            neutral,
            watched: asArray(domain.watchDistricts).includes(districtId),
        });
    }
    districtRows.sort((a, b) => String(a.name).localeCompare(String(b.name)));

    const territory = {
        districts: districtRows,
        counts,
        factionId: domainFactionId,
        factionName: faction?.name ?? null,
        headquartersLocationId: faction?.headquartersLocationId ?? null,
        headquartersName: locationName(state, locationsById, faction?.headquartersLocationId),
    };

    // --- resistance -------------------------------------------------------
    const resistanceFactionIds = new Set(asArray(domain.resistanceFactionIds));
    const resistance = asArray(state.threats)
        .filter((threat) => {
            if (!isObject(threat) || threat.status === 'defeated' || threat.status === 'contained') {
                return false;
            }
            if (resistanceFactionIds.has(threat.sourceFactionId)) {
                return true;
            }
            const source = factions[threat.sourceFactionId] ?? null;
            return Boolean(source && source.side !== 'villain');
        })
        .map((threat) => {
            const stage = threatStage(threat);
            return {
                id: threat.id,
                name: threat.name ?? threat.id,
                status: threat.status ?? 'active',
                progress: finiteNumber(threat.progress),
                stageIndex: stage.index,
                stageLabel: stage.label,
                stageCount: stage.count,
                locationId: threat.locationId ?? null,
                locationName: locationName(state, locationsById, threat.locationId),
                sourceFactionId: threat.sourceFactionId ?? null,
                danger: `${stage.label} — ${finiteNumber(threat.progress)}%`,
            };
        })
        .sort((a, b) => b.progress - a.progress || String(a.name).localeCompare(String(b.name)));

    // --- feed -------------------------------------------------------------
    const interestingTags = new Set(['offscreen', 'knight', 'corruption', 'beat']);
    const feed = asArray(state.recentEvents)
        .filter((event) => isObject(event) && asArray(event.tags).some((tag) => interestingTags.has(tag)))
        .slice(-6)
        .reverse()
        .map((event) => ({
            turn: Number.isInteger(event.turn) ? event.turn : null,
            summary: event.headline ?? event.summary ?? '',
            tags: asArray(event.tags),
        }));

    return {
        active: true,
        reason: 'villain-pov',
        domain: {
            name: domain.name ?? 'The Domain',
            factionId: domainFactionId,
            knightFormKind,
            description: domain.description ?? '',
            loreText: domain.loreText ?? '',
        },
        wonderland: {
            name: domain.name ?? 'The Domain',
            description: domain.description ?? '',
            flavorText: domain.loreText ?? '',
        },
        knights,
        court,
        corruptionSpread,
        territory,
        resistance,
        feed,
    };
}

/** True when a season authors a domain and is villain-POV. */
export function isDomainActive(state, season) {
    return Boolean(isObject(season?.domain) && season?.playerRole === 'villain' && isObject(state));
}
