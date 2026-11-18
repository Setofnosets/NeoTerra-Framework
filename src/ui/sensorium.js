/**
 * Domain tab (villain-POV sensorium).
 *
 * Everything here is a view over `buildDomainView`: the tab never writes state
 * and never calls an agent. The tab is hidden entirely for hero seasons and
 * for seasons that do not author a `domain` block.
 */

import { EVENTS, bus } from '../core/events.js';
import { buildDomainView } from '../data/domain.js';

export function escapeDomainHtml(value) {
    return String(value ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;');
}

function section(title, body, empty = null) {
    const content = body && String(body).trim().length > 0
        ? body
        : `<p class="neoterra-hint">${escapeDomainHtml(empty ?? 'Nothing here yet.')}</p>`;
    return `
        <section class="neoterra-domain-section">
            <h4 class="neoterra-domain-title">${escapeDomainHtml(title)}</h4>
            ${content}
        </section>`;
}

function renderKnights(knights) {
    if (knights.length === 0) {
        return '';
    }
    const rows = knights.map((knight) => `
        <li class="neoterra-domain-row${knight.active ? ' is-active' : ''}">
            <div class="neoterra-domain-row-head">
                <strong>${escapeDomainHtml(knight.name)}</strong>
                <span class="neoterra-overlay-chip">${escapeDomainHtml(knight.active ? 'on duty' : knight.status)}</span>
            </div>
            <span class="neoterra-hint">
                ${escapeDomainHtml(knight.locationName ?? 'location unknown')}
                · corruption ${knight.corruptionStage}
                · affinity ${knight.affinity}
            </span>
        </li>`).join('');
    return `<ul class="neoterra-domain-list">${rows}</ul>`;
}

function renderCourt(view) {
    const spread = view.corruptionSpread;
    const stages = Object.entries(spread.byStage ?? {})
        .sort(([a], [b]) => Number(a) - Number(b))
        .map(([stage, count]) => `<span class="neoterra-overlay-chip">stage ${escapeDomainHtml(stage)}: ${count}</span>`)
        .join('');
    const court = (view.court ?? []).map((member) => `
        <li class="neoterra-domain-row">
            <div class="neoterra-domain-row-head">
                <strong>${escapeDomainHtml(member.name)}</strong>
                <span class="neoterra-overlay-chip">${escapeDomainHtml(member.reasons.join(', '))}</span>
            </div>
            <span class="neoterra-hint">
                ${escapeDomainHtml(member.locationName ?? 'elsewhere')}
                · corruption ${member.corruptionStage} (${member.corruptionProgress}%)
            </span>
        </li>`).join('');
    const top = (spread.top ?? []).map((row) => `
        <li class="neoterra-domain-meter">
            <span>${escapeDomainHtml(row.name)}</span>
            <span class="neoterra-domain-meter-track"><span style="width:${Math.max(0, Math.min(100, row.progress))}%"></span></span>
            <span>${row.progress}%</span>
        </li>`).join('');
    return `
        <div class="neoterra-domain-chips">${stages || '<span class="neoterra-hint">No corruption recorded.</span>'}</div>
        ${court ? `<ul class="neoterra-domain-list">${court}</ul>` : '<p class="neoterra-hint">No corrupted or sworn characters yet.</p>'}
        ${top ? `<ul class="neoterra-domain-meters">${top}</ul>` : ''}`;
}

function renderTerritory(territory) {
    const counts = territory.counts ?? {};
    const chips = [
        `${counts.controlled ?? 0} controlled`,
        `${counts.contested ?? 0} contested`,
        `${counts.hostile ?? 0} hostile`,
        `${counts.unclaimed ?? 0} unclaimed`,
    ].map((text) => `<span class="neoterra-overlay-chip">${escapeDomainHtml(text)}</span>`).join('');
    const districts = (territory.districts ?? []).map((district) => `
        <li class="neoterra-domain-row is-${escapeDomainHtml(district.status)}">
            <div class="neoterra-domain-row-head">
                <strong>${escapeDomainHtml(district.name)}</strong>
                <span class="neoterra-overlay-chip">${escapeDomainHtml(district.status)}</span>
                ${district.watched ? '<span class="neoterra-overlay-chip">watched</span>' : ''}
            </div>
            <span class="neoterra-hint">
                ${district.controlled} ours · ${district.hostile} hostile · ${district.neutral} unclaimed
            </span>
        </li>`).join('');
    const hq = territory.headquartersName
        ? `<p class="neoterra-hint">Seat of power: ${escapeDomainHtml(territory.headquartersName)}</p>`
        : '';
    return `<div class="neoterra-domain-chips">${chips}</div>${hq}
        <ul class="neoterra-domain-list">${districts}</ul>`;
}

function renderResistance(resistance) {
    if (resistance.length === 0) {
        return '';
    }
    const rows = resistance.map((threat) => `
        <li class="neoterra-domain-row">
            <div class="neoterra-domain-row-head">
                <strong>${escapeDomainHtml(threat.name)}</strong>
                <span class="neoterra-overlay-chip">${escapeDomainHtml(threat.status)}</span>
            </div>
            <span class="neoterra-hint">
                ${escapeDomainHtml(threat.stageLabel)}${threat.stageCount > 0
        ? ` (stage ${threat.stageIndex + 1}/${threat.stageCount})`
        : ''}
                · ${threat.progress}% · ${escapeDomainHtml(threat.locationName ?? 'unknown')}
            </span>
            <span class="neoterra-domain-meter-track"><span style="width:${Math.max(0, Math.min(100, threat.progress))}%"></span></span>
        </li>`).join('');
    return `<ul class="neoterra-domain-list">${rows}</ul>`;
}

function renderFeed(feed) {
    if (feed.length === 0) {
        return '';
    }
    const rows = feed.map((entry) => `
        <li class="neoterra-domain-feed-item">
            <span class="neoterra-hint">${escapeDomainHtml(entry.tags.filter((tag) => tag !== 'offscreen' && tag !== 'tick').join(', '))}</span>
            <span>${escapeDomainHtml(entry.summary)}</span>
        </li>`).join('');
    return `<ul class="neoterra-domain-feed">${rows}</ul>`;
}

/** Full tab markup. Empty when the domain is not active. */
export function renderDomainMarkup(view) {
    if (!view?.active) {
        return `<p class="neoterra-empty" data-neoterra-domain-empty>This season has no domain view.</p>`;
    }
    return `
    <div class="neoterra-domain" data-neoterra-domain>
        <header class="neoterra-domain-head">
            <h3>${escapeDomainHtml(view.wonderland.name)}</h3>
            <p class="neoterra-hint">${escapeDomainHtml(view.wonderland.description)}</p>
            ${view.wonderland.flavorText ? `<p class="neoterra-domain-flavor">${escapeDomainHtml(view.wonderland.flavorText)}</p>` : ''}
        </header>
        <div class="neoterra-domain-grid">
            ${section('Knights', renderKnights(view.knights), 'No knighted characters are registered.')}
            ${section('Court & corruption', renderCourt(view))}
            ${section('Territory', renderTerritory(view.territory))}
            ${section('The resistance', renderResistance(view.resistance), 'No organized resistance is visible.')}
        </div>
        ${section('Feed', renderFeed(view.feed), 'No off-screen activity yet.')}
    </div>`;
}

/**
 * Mount the Domain tab into a host element.
 *
 * @param {{
 *   root: HTMLElement,
 *   getState: () => object|null,
 *   getSeason: () => object|null,
 *   getRegistry?: () => object|null,
 *   getLocations?: () => object|null,
 *   getDistricts?: () => object|null,
 *   getSettings?: () => object,
 *   subscribe?: boolean,
 * }} options
 */
export function mountSensorium({
    root,
    getState,
    getSeason,
    getRegistry = () => null,
    getLocations = () => null,
    getDistricts = () => null,
    getSettings = () => ({}),
    subscribe = true,
} = {}) {
    if (typeof document === 'undefined' || !root) {
        return null;
    }
    let disposed = false;

    function refresh() {
        if (disposed) {
            return null;
        }
        const view = buildDomainView({
            state: typeof getState === 'function' ? getState() : null,
            season: typeof getSeason === 'function' ? getSeason() : null,
            registry: typeof getRegistry === 'function' ? getRegistry() : null,
            locations: typeof getLocations === 'function' ? getLocations() : null,
            districts: typeof getDistricts === 'function' ? getDistricts() : null,
            settings: typeof getSettings === 'function' ? getSettings() : {},
        });
        root.innerHTML = renderDomainMarkup(view);
        return view;
    }

    const offMap = subscribe
        ? bus.on(EVENTS.MAP_UPDATED, () => {
            if (root.offsetParent !== null) {
                refresh();
            }
        })
        : () => {};
    const offTab = subscribe
        ? bus.on(EVENTS.TAB_CHANGED, () => {
            if (root.offsetParent !== null) {
                refresh();
            }
        })
        : () => {};

    refresh();

    return {
        refresh,
        dispose: () => {
            if (disposed) {
                return;
            }
            disposed = true;
            offMap();
            offTab();
            root.innerHTML = '';
        },
    };
}
