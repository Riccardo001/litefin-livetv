import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

/**
 * ============================================================================
 * Dispatcharr Live TV CSS Compatibility Test Suite
 * ============================================================================
 * The Live TV stylesheet targets Tizen 5.5 / webOS 5 (Chromium 68-69) and is
 * not processed by autoprefixer, so it must avoid properties those engines
 * do not support and keep animations on transform/opacity only.
 * ============================================================================
 */

const css = readFileSync(new URL('../src/styles/dtv.css', import.meta.url), 'utf8')
    // Ignore comments, which legitimately mention the forbidden features
    .replace(/\/\*[\s\S]*?\*\//g, '');

const FORBIDDEN = [
    { pattern: /(^|[;{\s])gap\s*:/m, reason: 'flexbox gap needs Chromium 84' },
    { pattern: /(row|column)-gap\s*:/, reason: 'flexbox gap needs Chromium 84' },
    { pattern: /aspect-ratio/, reason: 'aspect-ratio needs Chromium 88' },
    { pattern: /(^|[;{\s])inset\s*:/m, reason: 'inset needs Chromium 87' },
    { pattern: /clamp\(/, reason: 'clamp() needs Chromium 79' },
    { pattern: /:is\(|:where\(/, reason: ':is()/:where() need Chromium 88' },
    { pattern: /:focus-visible/, reason: ':focus-visible needs Chromium 86' },
    { pattern: /backdrop-filter/, reason: 'backdrop-filter is too heavy for TV GPUs' },
    { pattern: /filter\s*:\s*[^;]*blur/, reason: 'blur filters are too heavy for TV GPUs' },
    { pattern: /box-shadow/, reason: 'shadows are avoided for performance' }
];

test('dtv.css avoids features unsupported by Chromium 68', () => {
    FORBIDDEN.forEach(({ pattern, reason }) => {
        assert.equal(pattern.test(css), false, `dtv.css uses ${pattern}: ${reason}`);
    });
});

test('dtv.css only animates transform and opacity', () => {
    const transitions = css.match(/transition\s*:[^;]+;/g) || [];
    transitions.forEach((rule) => {
        const value = rule.replace(/^transition\s*:/, '').replace(/;$/, '');
        if (value.trim() === 'none') return;
        value.split(',').forEach((part) => {
            const property = part.trim().split(/\s+/)[0];
            assert.ok(['transform', 'opacity'].includes(property), `animated property not allowed: ${rule.trim()}`);
        });
    });
    assert.equal(/@keyframes/.test(css), false, 'keyframe animations are not used');
});

test('dtv.css selectors are scoped to the Live TV section', () => {
    const selectors = css
        .replace(/\{[^}]*\}/g, '\n')
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean);
    selectors.forEach((selector) => {
        assert.ok(/\.dtv-/.test(selector), `unscoped selector: ${selector}`);
    });
});
