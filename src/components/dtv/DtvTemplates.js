/**
 * ============================================================================
 * Litefin Tizen - Dispatcharr Live TV Templates
 * ============================================================================
 * Small HTML/format helpers shared by the Live TV list, guide and overlay.
 * Every server-supplied string goes through escapeHtml.
 * ============================================================================
 */

import { escapeHtml } from '../../utils/Utils.js';
import { i18n } from '../../utils/i18n.js';
import CardRenderer from '../../utils/CardRenderer.js';
import { logoCache } from '../../livetv/LogoCache.js';
import { DTV_ERROR } from '../../api/DispatcharrClient.js';
import { getBaseUrl } from '../../livetv/DtvSettings.js';

/**
 * User-facing explanation of a Dispatcharr request failure.
 * @param {Error} err - Usually a DispatcharrError
 * @param {string} [baseUrl] - Address to mention (defaults to the saved one)
 * @returns {string}
 */
export function errorMessage(err, baseUrl) {
    const url = baseUrl || getBaseUrl();
    switch (err && err.kind) {
        case DTV_ERROR.NOT_CONFIGURED:
            return i18n.t('DtvNotConfiguredText');
        case DTV_ERROR.UNAUTHORIZED:
            return i18n.t('DtvErrorUnauthorized');
        case DTV_ERROR.FORBIDDEN:
            return i18n.t('DtvErrorForbidden');
        case DTV_ERROR.NOT_FOUND:
            return i18n.t('DtvErrorNotFound', [url]);
        case DTV_ERROR.NETWORK:
            return i18n.t('DtvErrorNetwork', [url]);
        case DTV_ERROR.TIMEOUT:
            return i18n.t('DtvErrorTimeout', [url]);
        default:
            return i18n.t('DtvErrorServer', [err && err.status ? String(err.status) : '?']);
    }
}

/**
 * Logo box: initials on a gradient underneath, the cached logo on top.
 * Call bindLogo() after inserting the markup.
 * @param {Object} channel
 * @param {string} [extraClass]
 * @returns {string}
 */
export function logoHtml(channel, extraClass = '') {
    const fallback = CardRenderer.getFallbackData(channel.name);
    return `
        <div class="dtv-logo ${extraClass}">
            <img class="dtv-logo-img" alt="" />
            <span class="dtv-logo-fallback grad-${fallback.gradNum}">${escapeHtml(fallback.initials)}</span>
        </div>
    `;
}

/**
 * Point the <img> inside `root` at the channel's cached logo.
 * @param {HTMLElement} root - Element containing a .dtv-logo-img
 * @param {Object} channel
 */
export function bindLogo(root, channel) {
    const img = root ? root.querySelector('.dtv-logo-img') : null;
    if (img) logoCache.apply(img, channel.logoUrl);
}

/**
 * "20:00 – 21:30" in the user's 12/24 h format.
 * @param {Object} program
 * @returns {string}
 */
export function formatRange(program) {
    if (!program) return '';
    return `${i18n.formatLocalTime(new Date(program.start))} – ${i18n.formatLocalTime(new Date(program.end))}`;
}

/**
 * Program title with its episode subtitle when present.
 * @param {Object} program
 * @returns {string} Plain text (escape before inserting)
 */
export function programTitle(program) {
    if (!program) return '';
    return program.subTitle ? `${program.title} · ${program.subTitle}` : program.title;
}

/**
 * Star icon used for favorites.
 * @param {boolean} filled
 * @returns {string}
 */
export function starIcon(filled) {
    return filled
        ? '<svg viewBox="0 0 24 24" width="28" height="28"><path fill="currentColor" d="M12 17.27L18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2L9.19 8.63L2 9.24l5.46 4.73L5.82 21z"/></svg>'
        : '<svg viewBox="0 0 24 24" width="28" height="28"><path fill="currentColor" d="m12 15.39l-3.76 2.27l.99-4.28l-3.32-2.88l4.38-.37L12 6.09l1.71 4.04l4.38.37l-3.32 2.88l.99 4.28M22 9.24l-7.19-.61L12 2L9.19 8.63L2 9.24l5.45 4.73L5.82 21L12 17.27L18.18 21l-1.63-7.03z"/></svg>';
}
