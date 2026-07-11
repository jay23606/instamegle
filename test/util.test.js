import { test } from 'node:test';
import assert from 'node:assert/strict';
import { esc, initial, ago, isMediaUrl, safeMediaUrl, BLANK, mimeKind, chunkString, makeLru } from '../util.js';

test('esc escapes HTML metacharacters', () => {
    assert.equal(esc('<b>"x"&y</b>'), '&lt;b&gt;&quot;x&quot;&amp;y&lt;/b&gt;');
    assert.equal(esc(null), '');
    assert.equal(esc(undefined), '');
});

test('initial takes the first uppercased letter', () => {
    assert.equal(initial('molly'), 'M');
    assert.equal(initial('  jay'), 'J');
    assert.equal(initial(''), '?');
    assert.equal(initial(null), '?');
});

test('isMediaUrl blocks XSS payloads, allows data:/blob: media', () => {
    for (const ok of ['data:image/jpeg;base64,AAAA', 'data:video/mp4;base64,AAAA', 'data:audio/webm;base64,A', 'blob:http://x/abc'])
        assert.equal(isMediaUrl(ok), true, ok);
    for (const bad of ['x" onerror="alert(1)', '"><img src=x onerror=alert(1)>', 'javascript:alert(1)', 'data:text/html,<script>', '', null, undefined, 42])
        assert.equal(isMediaUrl(bad), false, String(bad));
});

test('safeMediaUrl passes valid media, replaces attacks with BLANK', () => {
    const u = 'data:image/png;base64,iVBOR';
    assert.equal(safeMediaUrl(u), u);
    assert.equal(safeMediaUrl('javascript:alert(1)'), BLANK);
    assert.equal(safeMediaUrl(null), BLANK);
});

test('mimeKind classifies by MIME prefix', () => {
    assert.equal(mimeKind('image/png'), 'image');
    assert.equal(mimeKind('video/webm'), 'video');
    assert.equal(mimeKind('audio/webm'), 'audio');
    assert.equal(mimeKind('application/pdf'), 'file');
    assert.equal(mimeKind(''), 'file');
});

test('chunkString splits into <=size pieces and round-trips', () => {
    const s = 'x'.repeat(40000) + 'END';
    const parts = chunkString(s, 16000);
    assert.equal(parts.length, Math.ceil(s.length / 16000));
    assert.equal(parts.join(''), s);
    assert.ok(parts.every(p => p.length <= 16000));
    assert.deepEqual(chunkString('', 10), []);
});

test('ago formats relative time', () => {
    const now = Date.now();
    assert.equal(ago(new Date(now - 5e3).toISOString()), 'just now');
    assert.equal(ago(new Date(now - 5 * 60e3).toISOString()), '5m');
    assert.equal(ago(new Date(now - 3 * 3600e3).toISOString()), '3h');
    assert.equal(ago(new Date(now - 2 * 86400e3).toISOString()), '2d');
});

test('makeLru evicts oldest over cap and refreshes recency on set', () => {
    const c = makeLru(3);
    c.set('a', 1); c.set('b', 2); c.set('c', 3);
    assert.equal(c.size, 3);
    c.set('d', 4);                 // evicts 'a' (oldest)
    assert.equal(c.has('a'), false);
    assert.equal(c.has('d'), true);
    assert.equal(c.size, 3);
    c.set('b', 22);                // refresh 'b' -> newest; 'c' now oldest
    c.set('e', 5);                 // evicts 'c'
    assert.equal(c.has('c'), false);
    assert.equal(c.get('b'), 22);
    assert.equal(c.has('e'), true);
});
