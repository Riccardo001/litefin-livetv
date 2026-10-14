/**
 * ============================================================================
 * Litefin Tizen - Live Engine Factory
 * ============================================================================
 * Picks the playback engine for Dispatcharr live channels:
 *   - Tizen with AVPlay → LiveAvPlayEngine (unless the user forced the HTML5
 *     engine in the player settings)
 *   - webOS, desktop    → LiveVideoEngine
 * ============================================================================
 */

import { platformInfo } from '../../utils/PlatformInfo.js';
import { PlayerSettings } from '../../utils/PlayerSettings.js';
import { LiveAvPlayEngine } from './LiveAvPlayEngine.js';
import { LiveVideoEngine } from './LiveVideoEngine.js';

/**
 * @param {HTMLElement} container - Full-screen element hosting the video
 * @param {Object} log - Logger instance
 * @returns {LiveAvPlayEngine|LiveVideoEngine}
 */
export function createLiveEngine(container, log) {
    const avplay = (window.webapis && window.webapis.avplay) || (window.tizen && window.tizen.avplay) || null;
    if (platformInfo.isTizen && avplay && PlayerSettings.get('playerBackend') !== 'html5') {
        return new LiveAvPlayEngine({ container, avplay, log });
    }
    return new LiveVideoEngine({ container });
}

export default createLiveEngine;
