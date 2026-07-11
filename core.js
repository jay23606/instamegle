import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { esc, rand, ago, initial, isMediaUrl, safeMediaUrl, chunkString, mimeKind, makeLru } from './util.js';

// ===================== config =====================
const SUPABASE_URL = 'https://zbtgonklxweikgukzukg.supabase.co';
const SUPABASE_KEY = 'sb_publishable_Tpkd3FzWhsfldMll-gIqfg_74YVroef';
const PREVIEW_PX   = 32;    // LQIP thumbnail longest edge (stored in DB) — turn the detail knob here
const FULL_PX      = 1080;  // longest edge of the P2P full image kept in the browser
const FULL_Q       = 0.85;  // JPEG quality of the P2P full image

const sb = createClient(SUPABASE_URL, SUPABASE_KEY);

// ===================== tiny DOM helpers =====================
const $  = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const el = (html) => { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstElementChild; };
const app = $('#app');
const toast = (t) => { const n = $('#toast'); n.textContent = t; n.classList.add('show'); setTimeout(() => n.classList.remove('show'), 2200); };

// ===================== IndexedDB: the author's own full images =====================
// Full-res images NEVER go to Supabase. Each author keeps their own posts'
// images here and serves them peer-to-peer on request.
const idb = (() => {
    const dbp = new Promise((res, rej) => {
        const r = indexedDB.open('peek', 1);
        r.onupgradeneeded = () => r.result.createObjectStore('imgs');
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
    });
    const run = async (mode, fn) => {
        const db = await dbp;
        return new Promise((res, rej) => {
            const tx = db.transaction('imgs', mode);
            const rq = fn(tx.objectStore('imgs'));
            tx.oncomplete = () => res(rq && rq.result);
            tx.onerror = () => rej(tx.error);
        });
    };
    return {
        get: (k) => run('readonly',  s => s.get(k)),
        set: (k, v) => run('readwrite', s => s.put(v, k)),
        del: (k) => run('readwrite', s => s.delete(k)),
    };
})();

// ===================== image processing (canvas) =====================
const loadImage = (src) => new Promise((res, rej) => {
    const im = new Image(); im.onload = () => res(im); im.onerror = rej; im.src = src;
});
const scaleTo = (im, max) => {
    const k = Math.min(1, max / Math.max(im.width, im.height));
    const w = Math.max(1, Math.round(im.width * k)), h = Math.max(1, Math.round(im.height * k));
    const c = Object.assign(document.createElement('canvas'), { width: w, height: h });
    c.getContext('2d').drawImage(im, 0, 0, w, h);
    return c;
};
// Decode off the main thread when supported (keeps the UI responsive for multi-image
// posts). imageOrientation:'from-image' respects EXIF so phone photos aren't sideways.
// (The <img> fallback already applies EXIF via the browser default.)
const decode = async (file) => ('createImageBitmap' in window)
    ? await createImageBitmap(file, { imageOrientation: 'from-image' }).catch(() => loadImage(URL.createObjectURL(file)))
    : loadImage(URL.createObjectURL(file));
// Returns { preview (tiny, for DB), full (bigger, for P2P + IndexedDB), w, h }
const processImage = async (file) => {
    const im = await decode(file);
    const preview = scaleTo(im, PREVIEW_PX).toDataURL('image/jpeg', 0.55);
    const full    = scaleTo(im, FULL_PX).toDataURL('image/jpeg', FULL_Q);
    const out = { preview, full, w: im.width, h: im.height };
    im.close?.();
    return out;
};
// Avatars ARE small enough to store in the DB (unlike posts) so they always show,
// even when the person is offline. ~128px is a few KB.
const AVATAR_PX = 128;
const makeAvatar = async (file) => {
    const im = await decode(file);
    const url = scaleTo(im, AVATAR_PX).toDataURL('image/jpeg', 0.7);
    im.close?.();
    return url;
};
// Render an avatar: the stored image if present (and safe), else the initial letter.
const avatarHTML = (username, avatar, cls = '') =>
    `<div class="avatar ${cls}">${isMediaUrl(avatar) ? `<img src="${avatar}" alt="">` : initial(username)}</div>`;

// ===================== auth / session state =====================
const state = { me: null, profile: null };
const presenceUsers = {};       // user_id -> { username }  (who's currently online)
const fullCache = makeLru(60);  // postId:idx -> full data URL (LRU-capped so a long session doesn't hoard memory)
const isOnline = (uid) => !!presenceUsers[uid];

export { sb, $, $$, el, esc, rand, app, toast, ago, initial, idb, processImage, makeAvatar, avatarHTML,
    isMediaUrl, safeMediaUrl, chunkString, mimeKind, state, presenceUsers, fullCache, isOnline };
