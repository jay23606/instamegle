import { sb, $, $$, el, esc, rand, app, toast, ago, initial, avatarHTML, isMediaUrl, safeMediaUrl, state, presenceUsers, fullCache, isOnline, processImage, makeAvatar, idb } from './core.js';
import { db } from './db.js';
import { startRtc, fetchFull } from './rtc.js';
import { openDM, callUser, onIncomingDM, onIncomingCall, dms } from './dm.js';
import { openGroup, onIncomingGroupCall, createGroupFlow } from './groups.js';

let myLikeSet = new Set();   // post ids the current user has liked (UI state)

// Surface async failures that would otherwise be swallowed (they don't hit console.error).
window.addEventListener('unhandledrejection', (e) => console.error('[peek] unhandled rejection:', e.reason));
window.addEventListener('groups-changed', () => renderGroups());   // keep the People view's Groups list fresh

// ===================== Realtime presence (online + peer map) =====================
let presenceCh = null;
const startPresence = () => {
    presenceCh = sb.channel('peek-presence', { config: { presence: { key: state.me.id } } });
    presenceCh.on('presence', { event: 'sync' }, () => {
        const st = presenceCh.presenceState();
        for (const k in presenceUsers) delete presenceUsers[k];
        let n = 0;
        for (const key in st) {
            n++;
            for (const m of st[key]) if (m.user_id) presenceUsers[m.user_id] = { username: m.username };
        }
        const o = $('#online'); if (o) o.textContent = n + ' online';
        // Any post cards waiting on a now-online author can try their full image.
        $$('.stage[data-pending]').forEach(tryLoadFull);
        onPresenceChange();   // refresh the People view + DM online dots
    });
    presenceCh.subscribe(async (status) => {
        if (status === 'SUBSCRIBED')
            await presenceCh.track({ user_id: state.me.id, username: state.profile.username });
    });
};

// Try to upgrade a card's blurred LQIP to the real P2P image.
const ownFull = (postId, idx) => idx === 0
    ? idb.get(`post:${postId}:0`).then(v => v || idb.get('post:' + postId))
    : idb.get(`post:${postId}:${idx}`);
const tryLoadFull = async (stage) => {
    const postId = stage.dataset.post, authorId = stage.dataset.author, idx = +(stage.dataset.idx || 0);
    if (stage.dataset.loaded) return;
    // Our own post → load straight from our IndexedDB, no network.
    let full = fullCache.get(`${postId}:${idx}`) || (authorId === state.me.id ? await ownFull(postId, idx) : null);
    if (!full) {
        if (!isOnline(authorId)) { stage.dataset.pending = '1'; return; }   // author offline → keep the blur
        full = await fetchFull(postId, authorId, idx);
    }
    if (!full) { stage.dataset.pending = '1'; return; }
    delete stage.dataset.pending;
    stage.dataset.loaded = '1';
    const img = el(`<img class="full" src="${safeMediaUrl(full)}" alt="">`);
    stage.appendChild(img);
    requestAnimationFrame(() => stage.classList.add('loaded'));
    const badge = $('.badge', stage); if (badge) badge.remove();
};

// Lazy image loading: only fetch a post's full image once it scrolls near the
// viewport, so a long feed doesn't open dozens of P2P connections at once.
const lazyImg = ('IntersectionObserver' in window)
    ? new IntersectionObserver((entries) => {
        for (const e of entries) if (e.isIntersecting) {
            lazyImg.unobserve(e.target);
            (e.target._load || (() => tryLoadFull(e.target)))();
        }
    }, { rootMargin: '400px' })
    : null;
const lazyLoad = (elm, fn) => {
    if (fn) elm._load = fn;
    if (lazyImg) lazyImg.observe(elm);
    else (fn || (() => tryLoadFull(elm)))();   // no IO support → load immediately
};
// Load a profile-grid cell's full image (own IndexedDB or P2P).
const loadCell = async (cell) => {
    const postId = cell.dataset.post, authorId = cell.dataset.author;   // grid shows the cover (idx 0)
    let full = fullCache.get(`${postId}:0`) || (authorId === state.me.id ? await ownFull(postId, 0) : null);
    if (!full && isOnline(authorId)) full = await fetchFull(postId, authorId, 0);
    const lq = $('.lqip', cell); if (full && lq) lq.replaceWith(el(`<img src="${safeMediaUrl(full)}" alt="">`));
};


// ===================== people / discover =====================
let followingSet = new Set(), followersSet = new Set(), peopleQuery = '';

const urow = (p) => {
    const online = isOnline(p.id), following = followingSet.has(p.id);
    const mutual = following && followersSet.has(p.id);   // both follow each other
    const node = el(`
      <div class="urow" data-uid="${p.id}">
        ${avatarHTML(p.username, p.avatar)}
        <div class="who">
          <a class="u" href="#/u/${encodeURIComponent(p.username)}">${esc(p.username)}</a>
          <div class="sub">${online ? '<span class="dot"></span>online' : 'not online'}</div>
        </div>
        <div class="acts">
          ${mutual ? `<button class="pill act-msg">Message</button>` : ''}
          <button class="pill foll ${following ? '' : 'primary'}">${following ? 'Following' : 'Follow'}</button>
        </div>
      </div>`);
    $('.foll', node).onclick = async (e) => {
        e.currentTarget.disabled = true;
        if (followingSet.has(p.id)) await db.unfollow(p.id);
        else { await db.follow(p.id, p.is_private); db.notify(p.id, p.is_private ? 'follow_request' : 'follow'); }
        renderPeople(peopleQuery);   // re-render: following each other unlocks Message/Call
    };
    const mb = $('.act-msg', node); if (mb) mb.onclick = () => openDM(p.id, p.username);
    return node;
};

const renderPeople = async (q) => {
    peopleQuery = q;
    const list = $('#peoplelist'); if (!list) return;
    const [{ data: profs }, { data: follows }, { data: followers }] = await Promise.all([
        q ? db.searchProfiles(q) : db.allProfiles(),
        db.myFollowing(), db.myFollowers(),
    ]);
    if (!$('#peoplelist')) return;   // view changed while awaiting
    followingSet = new Set((follows || []).map(f => f.following_id));
    followersSet = new Set((followers || []).map(f => f.follower_id));
    const others = (profs || []).filter(p => p.id !== state.me.id);
    const onlineOthers = others.filter(p => isOnline(p.id));
    list.innerHTML = '';
    if (!q && onlineOthers.length) {
        list.appendChild(el(`<div class="section-title">Online now — say hi 👋</div>`));
        onlineOthers.forEach(p => list.appendChild(urow(p)));
    }
    const rest = q ? others : others.filter(p => !isOnline(p.id));
    list.appendChild(el(`<div class="section-title">${q ? 'Results' : 'Suggestions'}</div>`));
    if (!rest.length && !(!q && onlineOthers.length))
        list.appendChild(el(`<div class="empty">No one${q ? ' matched that' : ' else here yet'}.</div>`));
    rest.forEach(p => list.appendChild(urow(p)));
};

const renderGroups = async () => {
    const box = $('#grouplist'); if (!box) return;
    const { data } = await db.myGroups();
    box.innerHTML = '';
    (data || []).forEach(g => {
        const names = (g.group_members || []).map(m => m.profiles?.username).filter(Boolean).slice(0, 4).join(', ');
        const row = el(`<div class="urow" style="cursor:pointer"><div class="avatar">👥</div><div class="who"><span class="u">${esc(g.name || 'Group')}</span><div class="sub">${esc(names)}</div></div></div>`);
        row.onclick = () => openGroup(g);
        box.appendChild(row);
    });
};
const viewPeople = () => {
    app.innerHTML = `<main>
      <div class="section-title" style="display:flex;justify-content:space-between;align-items:center">Groups
        <button class="pill primary" id="newgroup">＋ New group</button></div>
      <div id="grouplist"></div>
      <input class="field searchbar" id="usearch" placeholder="Search people by username…" autocomplete="off">
      <div id="peoplelist"><div class="spin">Loading people…</div></div>
    </main>`;
    $('#newgroup').onclick = () => createGroupFlow();
    renderGroups();
    const s = $('#usearch'); let t;
    s.oninput = () => { clearTimeout(t); t = setTimeout(() => renderPeople(s.value.trim()), 180); };
    renderPeople('');
};

// Called on every presence sync: keep the People view + DM dots fresh.
let lastOnlineKey = '';
const onPresenceChange = () => {
    // Presence syncs fire often (e.g. in_call toggles); only re-query the People
    // view when the set of online users actually changed.
    const key = Object.keys(presenceUsers).sort().join(',');
    if (key !== lastOnlineKey) { lastOnlineKey = key; if ($('#peoplelist')) renderPeople(peopleQuery); }
    dms.forEach((dm, uid) => { const dot = $('.dmhead .dot', dm.node); if (dot) dot.style.opacity = isOnline(uid) ? '1' : '.25'; });
};


// ===================== rendering: post card =====================
// One or more image slides (carousel when a post has multiple images).
const stagesHTML = (p, uname) => {
    const imgs = (p.previews && p.previews.length) ? p.previews : [p.preview];
    const pad = ((p.w && p.h) ? (p.h / p.w) : 1) * 100;
    const alt = p.caption ? esc(p.caption) : 'photo by ' + esc(uname);
    const slide = (src, i) => `<div class="stage" data-post="${p.id}" data-author="${p.user_id}" data-idx="${i}" style="padding-bottom:${pad.toFixed(2)}%">
        <img class="lqip" src="${safeMediaUrl(src)}" alt="${alt}"><div class="badge">🔒 loading…</div></div>`;
    if (imgs.length === 1) return slide(imgs[0], 0);
    return `<div class="carousel">${imgs.map(slide).join('')}</div>
      <div class="cdots">${imgs.map((_, i) => `<span class="${i === 0 ? 'on' : ''}"></span>`).join('')}</div>`;
};
const cardHTML = (p) => {
    const uname = p.profiles?.username || 'unknown';
    const likes = p.likes?.[0]?.count ?? 0;
    const cmts  = p.comments?.[0]?.count ?? 0;
    const liked = myLikeSet.has(p.id);
    const mine  = p.user_id === state.me.id;
    return `
    <article class="card" data-card="${p.id}">
      <div class="chead">
        ${avatarHTML(uname, p.profiles?.avatar)}
        <a class="uname" href="#/u/${encodeURIComponent(uname)}">${esc(uname)}</a>
        <div class="grow"></div>
        ${mine ? `<button class="icon del" title="Delete" aria-label="Delete post">⋯</button>` : ''}
      </div>
      ${stagesHTML(p, uname)}
      <div class="actions">
        <button class="like ${liked ? 'on' : ''}" data-post="${p.id}" aria-label="Like">${liked ? '♥' : '♡'}</button>
        <button class="focus-cmt icon" aria-label="Comment">🗨</button>
        <div class="grow"></div>
      </div>
      <div class="meta">
        <div class="likes" data-likes="${p.id}">${likes} like${likes === 1 ? '' : 's'}</div>
        ${p.caption ? `<div class="cap"><b>${esc(uname)}</b> ${esc(p.caption)}</div>` : ''}
        <div class="cmts" data-cmts="${p.id}">${cmts ? `<button class="btn ghost" style="width:auto;padding:0;margin:0" data-view="${p.id}">View all ${cmts} comments</button>` : ''}</div>
        <div class="time">${ago(p.created_at)}</div>
      </div>
      <form class="addcmt" data-add="${p.id}">
        <input placeholder="Add a comment…" autocomplete="off">
        <button type="submit">Post</button>
      </form>
    </article>`;
};

const wireCard = (node, p) => {
    $$('.stage', node).forEach(s => lazyLoad(s));         // each slide fetches its image when scrolled into view
    const car = $('.carousel', node);
    if (car) {                                            // sync carousel dots
        const dots = $$('.cdots span', node);
        car.onscroll = () => { const i = Math.round(car.scrollLeft / car.clientWidth); dots.forEach((d, j) => d.classList.toggle('on', j === i)); };
    }
    $('.like', node).onclick = () => toggleLike(p.id, node, p.user_id);
    $(`[data-likes="${p.id}"]`, node)?.addEventListener('click', () => likersModal(p.id));
    const form = $('.addcmt', node), input = $('input', form), btn = $('button', form);
    input.oninput = () => btn.classList.toggle('on', !!input.value.trim());
    $('.focus-cmt', node).onclick = () => input.focus();
    form.onsubmit = async (e) => {
        e.preventDefault();
        const body = input.value.trim(); if (!body) return;
        input.value = ''; btn.classList.remove('on');
        const { data, error } = await db.addComment(p.id, body);
        if (error) return toast('Could not post comment');
        appendComment(node, data);
        db.notify(p.user_id, 'comment', p.id);           // tell the author
    };
    const view = $('[data-view]', node); if (view) view.onclick = () => loadComments(node, p.id);
    const del = $('.del', node); if (del) del.onclick = () => deletePost(p.id, node);
};

const appendComment = (node, c) => {
    const box = $('[data-cmts]', node);
    const mine = c.user_id === state.me.id;
    const row = el(`<div class="cmt" data-cmt="${c.id}"><span class="cbody"><b>${esc(c.profiles?.username || 'you')}</b> ${esc(c.body)}</span>${mine ? `<span class="cdel">delete</span>` : ''}</div>`);
    if (mine) $('.cdel', row).onclick = async () => { if (!confirm('Delete comment?')) return; await db.delComment(c.id); row.remove(); };
    box.appendChild(row);
};

// Generic centered modal; closes on ✕, backdrop click, or navigation.
const modal = (title, bodyEl) => {
    const m = el(`<div class="modal"><div class="sheet"><div class="mhead">${esc(title)}<button class="x icon" aria-label="Close">✕</button></div><div class="mbody"></div></div></div>`);
    $('.mbody', m).appendChild(bodyEl);
    const close = () => m.remove();
    $('.x', m).onclick = close;
    m.onclick = (e) => { if (e.target === m) close(); };
    window.addEventListener('hashchange', close, { once: true });
    document.body.appendChild(m);
    return m;
};
const likersModal = async (postId) => {
    const body = el('<div><div class="spin">Loading…</div></div>');
    modal('Likes', body);
    const { data } = await db.likers(postId);
    body.innerHTML = '';
    if (!data || !data.length) return void (body.innerHTML = '<div class="empty">No likes yet.</div>');
    data.forEach(l => { const u = l.profiles; if (u) body.appendChild(
        el(`<a class="urow" href="#/u/${encodeURIComponent(u.username)}">${avatarHTML(u.username, u.avatar)}<div class="who"><span class="u">${esc(u.username)}</span></div></a>`)); });
};
const loadComments = async (node, postId) => {
    const box = $('[data-cmts]', node);
    box.innerHTML = '<div class="muted">Loading…</div>';
    const { data, error } = await db.comments(postId);
    box.innerHTML = '';
    if (error) return box.textContent = 'Could not load comments';
    data.forEach(c => appendComment(node, c));
};

const toggleLike = async (postId, node, authorId) => {
    const btn = $('.like', node), counter = $(`[data-likes="${postId}"]`, node);
    const liked = myLikeSet.has(postId);
    // optimistic
    let n = parseInt(counter.textContent) || 0;
    n += liked ? -1 : 1;
    counter.textContent = `${n} like${n === 1 ? '' : 's'}`;
    btn.classList.toggle('on', !liked); btn.textContent = liked ? '♡' : '♥';
    liked ? myLikeSet.delete(postId) : myLikeSet.add(postId);
    const { error } = liked ? await db.unlike(postId) : await db.like(postId);
    if (error) { toast('Like failed'); loadFeed(); return; }   // resync on failure
    if (!liked) db.notify(authorId, 'like', postId);           // tell the author on a new like
};

const deletePost = async (postId, node) => {
    if (!confirm('Delete this post? This cannot be undone.')) return;
    const { error } = await db.delPost(postId);
    if (error) return toast('Delete failed');
    await idb.del('post:' + postId);
    for (let i = 0; i < 10; i++) { idb.del(`post:${postId}:${i}`); fullCache.delete(`${postId}:${i}`); }
    node.remove();
    toast('Post deleted');
    // If we were on the post-detail page, go back to our profile.
    if (location.hash.startsWith('#/p/')) location.hash = '#/u/' + encodeURIComponent(state.profile.username);
};


// ===================== views =====================
let feedMode = localStorage.im_feed || 'following';   // 'following' | 'explore'
let followingIds = new Set();                          // for the realtime prepend filter
const viewFeed = () => {
    app.innerHTML = `<main>
      <div class="feedtabs">
        <button class="ftab ${feedMode === 'following' ? 'on' : ''}" data-fm="following">Following</button>
        <button class="ftab ${feedMode === 'explore' ? 'on' : ''}" data-fm="explore">Explore</button>
      </div>
      <div id="feedlist"><div class="spin">Loading…</div></div>
    </main>`;
    $$('.ftab').forEach(b => b.onclick = () => {
        feedMode = b.dataset.fm; localStorage.im_feed = feedMode;
        $$('.ftab').forEach(x => x.classList.toggle('on', x.dataset.fm === feedMode));
        loadFeed();
    });
    loadFeed();
};
const PAGE = 12;
let feedFrom = 0, feedDone = false, feedBusy = false, feedSentinelObs = null;
const ensureSentinel = (list) => {
    let s = $('#feedmore'); if (!s) s = el('<div id="feedmore" style="height:1px"></div>');
    list.appendChild(s);   // keep it at the end
    if (!feedSentinelObs) feedSentinelObs = new IntersectionObserver(
        (es) => { if (es[0].isIntersecting) loadFeed(false); }, { rootMargin: '700px' });
    feedSentinelObs.observe(s);
};
const loadFeed = async (reset = true) => {
    const list = $('#feedlist'); if (!list || feedBusy) return;
    if (reset) {
        feedFrom = 0; feedDone = false; list.innerHTML = '<div class="spin">Loading…</div>';
        const { data: likes } = await db.myLikes();
        myLikeSet = new Set((likes || []).map(l => l.post_id));
        if (feedMode === 'following') { const { data: f } = await db.myFollowing(); followingIds = new Set((f || []).map(x => x.following_id)); }
    }
    if (feedDone) return;
    feedBusy = true;
    const to = feedFrom + PAGE - 1;
    let posts, error;
    if (feedMode === 'following') ({ data: posts, error } = await db.feedByUsers([...followingIds, state.me.id], feedFrom, to));
    else ({ data: posts, error } = await db.feed(feedFrom, to));
    feedBusy = false;
    if (!$('#feedlist')) return;               // navigated away while loading
    if (reset) list.innerHTML = '';
    if (error) { if (reset) list.innerHTML = `<div class="empty">Couldn't load the feed.<br><span class="muted">${esc(error.message)}</span></div>`; return; }
    if (reset && !(posts && posts.length)) return void (list.innerHTML = feedMode === 'following'
        ? `<div class="empty">Your Following feed is empty.<br><a href="#/people">Find people to follow →</a><br><br>…or tap <b>Explore</b> above to see everyone.</div>`
        : `<div class="empty">No posts yet.<br><a href="#/new">Share the first one →</a></div>`);
    (posts || []).forEach(p => { const node = el(cardHTML(p)); list.appendChild(node); wireCard(node, p); });
    feedFrom += (posts || []).length;
    if (!posts || posts.length < PAGE) { feedDone = true; $('#feedmore')?.remove(); }
    else ensureSentinel(list);
};

const viewNew = () => {
    app.innerHTML = `
    <main>
      <div class="composer">
        <h3 style="margin:0 0 12px">New post</h3>
        <div class="drop" id="drop">📷<br>Tap to choose photo(s)</div>
        <input id="file" type="file" accept="image/*" multiple hidden>
        <textarea id="caption" placeholder="Write a caption…"></textarea>
        <div class="err" id="newerr"></div>
        <button class="btn" id="share" disabled>Share</button>
        <p class="muted" style="font-size:12px;margin-top:10px">Only tiny blurred previews are stored on the server. The full photos stay in your browser and stream peer-to-peer to people viewing them while you're online. Pick several for a swipeable carousel.</p>
      </div>
    </main>`;
    const drop = $('#drop'), file = $('#file'), share = $('#share'), errb = $('#newerr');
    let picked = [];
    drop.onclick = () => file.click();
    file.onchange = async () => {
        const files = [...file.files].slice(0, 10); if (!files.length) return;
        errb.textContent = ''; drop.textContent = 'Processing…';
        try {
            picked = await Promise.all(files.map(processImage));
            drop.classList.add('has');
            drop.innerHTML = picked.map(p => `<img src="${safeMediaUrl(p.full)}" alt="" style="width:auto;max-height:200px;display:inline-block;margin:2px">`).join('')
                + (picked.length > 1 ? `<div class="muted" style="font-size:12px;padding:6px">${picked.length} photos — swipeable carousel</div>` : '');
            share.disabled = false;
        } catch (e) { errb.textContent = 'Could not read those images.'; drop.textContent = '📷'; }
    };
    share.onclick = async () => {
        if (!picked.length) return;
        share.disabled = true; share.textContent = 'Sharing…';
        const { data, error } = await db.addPost({
            user_id: state.me.id, caption: $('#caption').value.trim(),
            preview: picked[0].preview, previews: picked.map(p => p.preview),
            w: picked[0].w, h: picked[0].h,
        });
        if (error) { errb.textContent = error.message; share.disabled = false; share.textContent = 'Share'; return; }
        await idb.set('post:' + data.id, picked[0].full);   // cover under the legacy key
        await Promise.all(picked.map((p, i) => { fullCache.set(`${data.id}:${i}`, p.full); return idb.set(`post:${data.id}:${i}`, p.full); }));
        toast('Posted!');
        location.hash = '#/';
    };
};

const viewProfile = async (username) => {
    app.innerHTML = `<main class="wide"><div class="spin">Loading…</div></main>`;
    const { data: prof, error } = await db.profile(username);
    const root = $('main');
    if (error || !prof) return root.innerHTML = `<div class="empty">User not found.</div>`;
    const mine = prof.id === state.me.id;
    const [counts, fsRes, fmRes] = await Promise.all([
        db.counts(prof.id),
        mine ? Promise.resolve({ data: null }) : db.followState(prof.id),
        mine ? Promise.resolve({ count: 0 }) : db.followsMe(prof.id),
    ]);
    const [pc, fc, gc] = counts;
    const status = fsRes.data?.status || null;   // 'accepted' | 'pending' | null
    const following = status === 'accepted', requested = status === 'pending', followsMe = !!fmRes.count;
    const mutual = following && followsMe;
    const canSee = mine || !prof.is_private || following;   // private posts need an accepted follow
    let posts = [];
    if (canSee) { const { data } = await db.postsBy(prof.id); posts = data || []; }

    root.innerHTML = `
      <div class="phead">
        ${avatarHTML(prof.username, prof.avatar)}
        <div>
          <h2 style="margin:0 0 4px;font-weight:400">${esc(prof.username)}${prof.is_private ? ' <span class="muted" style="font-size:13px">🔒</span>' : ''}</h2>
          <div class="stats">
            <span><b>${pc.count ?? posts.length}</b> posts</span>
            <span><b>${fc.count ?? 0}</b> followers</span>
            <span><b>${gc.count ?? 0}</b> following</span>
          </div>
          ${prof.bio ? `<div>${esc(prof.bio)}</div>` : ''}
          ${mine ? `<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:6px">
                      <button class="btn" id="editp" style="width:auto;padding:6px 22px;margin:0">Edit profile</button>
                      <button class="btn ghost" id="logout" style="width:auto;padding:6px 0">Log out</button>
                    </div>`
                 : `<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
                      <button class="btn" id="foll" style="width:auto;padding:6px 22px;margin:0">${requested ? 'Requested' : following ? 'Following' : 'Follow'}</button>
                      ${mutual ? `<button class="pill" id="pmsg">Message</button><button class="pill" id="pcall">📹 Call</button>` : ''}
                    </div>
                    ${mutual ? '' : `<div class="muted" style="font-size:12px;margin-top:8px">${following ? 'Waiting for them to follow you back to message or call.' : 'Follow each other to unlock messaging & video calls.'}</div>`}`}
        </div>
      </div>
      ${canSee ? `<div class="grid" id="grid"></div>`
               : `<div class="private-note">🔒 This account is private.<br>Follow <b>${esc(prof.username)}</b> to see their posts.</div>`}`;
    if (canSee) {
        const grid = $('#grid');
        if (!posts.length) grid.innerHTML = `<div class="empty" style="grid-column:1/-1">No posts yet.</div>`;
        posts.forEach(p => {
            const cell = el(`<div class="cell" data-post="${p.id}" data-author="${p.user_id}"><img class="lqip" src="${safeMediaUrl(p.preview)}" alt=""></div>`);
            cell.onclick = () => { location.hash = '#/p/' + p.id; };   // open the post
            grid.appendChild(cell);
            lazyLoad(cell, () => loadCell(cell));                       // P2P image when scrolled into view
        });
    }
    const lo = $('#logout'); if (lo) lo.onclick = doLogout;
    const ep = $('#editp'); if (ep) ep.onclick = () => { location.hash = '#/edit'; };
    const pm = $('#pmsg'); if (pm) pm.onclick = () => openDM(prof.id, prof.username);
    const pcBtn = $('#pcall'); if (pcBtn) pcBtn.onclick = () => callUser(prof.id, prof.username);
    const fb = $('#foll'); if (fb) fb.onclick = async () => {
        fb.disabled = true;
        if (following || requested) await db.unfollow(prof.id);   // unfollow / cancel request
        else { await db.follow(prof.id, prof.is_private); db.notify(prof.id, prof.is_private ? 'follow_request' : 'follow'); }
        viewProfile(prof.username);
    };
};

// Single-post view (opened from the profile grid). Reuses the feed card, with
// comments expanded and the ⋯ delete available for your own posts.
const viewPost = async (id) => {
    app.innerHTML = `<main><div class="spin">Loading…</div></main>`;
    const { data: p, error } = await db.post(id);
    const root = $('main'); if (!root) return;
    if (error || !p) return root.innerHTML = `<div class="empty">Post not found.</div>`;
    const { data: liked } = await sb.from('likes').select('post_id')
        .match({ post_id: id, user_id: state.me.id }).maybeSingle();
    liked ? myLikeSet.add(id) : myLikeSet.delete(id);
    root.innerHTML = '';
    const node = el(cardHTML(p));
    root.appendChild(node);
    wireCard(node, p);
    loadComments(node, id);   // detail view shows all comments
};

// Edit your own profile: avatar, username, bio.
const viewEditProfile = () => {
    const p = state.profile;
    app.innerHTML = `
    <main>
      <div class="composer">
        <h3 style="margin:0 0 16px">Edit profile</h3>
        <div style="display:flex;align-items:center;gap:16px;margin-bottom:8px">
          <div class="avatar" id="eavatar" style="width:80px;height:80px;font-size:28px">${isMediaUrl(p.avatar) ? `<img src="${p.avatar}" alt="">` : initial(p.username)}</div>
          <div>
            <button class="btn ghost" id="epick" style="width:auto;padding:0;margin:0">Change photo</button>
            <input id="efile" type="file" accept="image/*" hidden>
          </div>
        </div>
        <label>Username</label>
        <input class="field" id="euser" value="${esc(p.username)}" autocomplete="off">
        <label>Bio</label>
        <textarea id="ebio" placeholder="Write a short bio…">${esc(p.bio || '')}</textarea>
        <div class="toggle-row">
          <div><b>Private account</b><div class="muted" style="font-size:12px">Only approved followers can see your posts.</div></div>
          <div class="switch ${p.is_private ? 'on' : ''}" id="epriv" role="switch" aria-label="Private account"></div>
        </div>
        <div class="err" id="eerr"></div>
        <button class="btn" id="esave">Save</button>
      </div>
    </main>`;
    let newAvatar = null;
    $('#epriv').onclick = () => $('#epriv').classList.toggle('on');
    $('#epick').onclick = () => $('#efile').click();
    $('#efile').onchange = async () => {
        const f = $('#efile').files[0]; if (!f) return;
        try { newAvatar = await makeAvatar(f); $('#eavatar').innerHTML = `<img src="${safeMediaUrl(newAvatar)}" alt="">`; }
        catch (e) { $('#eerr').textContent = 'Could not read that image.'; }
    };
    $('#esave').onclick = async () => {
        const btn = $('#esave'), errb = $('#eerr'); errb.textContent = '';
        const username = $('#euser').value.trim(), bio = $('#ebio').value.trim();
        if (!/^[a-z0-9_.]{3,20}$/i.test(username)) return errb.textContent = 'Username: 3–20 letters, numbers, _ or .';
        btn.disabled = true; btn.textContent = 'Saving…';
        const patch = { username, bio, is_private: $('#epriv').classList.contains('on') };
        if (newAvatar) patch.avatar = newAvatar;
        const { error } = await db.updateProfile(patch);
        if (error) {
            errb.textContent = /duplicate|unique/i.test(error.message) ? 'That username is taken.' : error.message;
            btn.disabled = false; btn.textContent = 'Save'; return;
        }
        Object.assign(state.profile, patch);
        unmountChrome(); mountChrome();   // refresh nav avatar + username
        toast('Profile updated');
        location.hash = '#/u/' + encodeURIComponent(username);
    };
};


// ===================== notifications / activity =====================
let unread = 0;
const setBadge = (n) => {
    unread = Math.max(0, n);
    const d = $('#notifdot'); if (d) { d.textContent = unread > 9 ? '9+' : unread; d.classList.toggle('on', unread > 0); }
};
const refreshBadge = async () => { const { count } = await db.unreadCount(); setBadge(count || 0); };
const startNotifRealtime = () => {
    sb.channel('peek-notif')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'notifications', filter: `recipient_id=eq.${state.me.id}` },
          () => { if (!location.hash.startsWith('#/activity')) setBadge(unread + 1); })
      .subscribe();
};
const notifText = (type) => ({
    follow: 'started following you.',
    follow_accept: 'accepted your follow request.',
    like: 'liked your post.',
    comment: 'commented on your post.',
}[type] || '');
const viewActivity = async () => {
    app.innerHTML = `<main><h3 style="padding:14px 14px 6px;margin:0">Activity</h3><div id="acts"><div class="spin">Loading…</div></div></main>`;
    const [{ data: reqs }, { data: notes }] = await Promise.all([db.pendingRequests(), db.notifications()]);
    const box = $('#acts'); if (!box) return;
    box.innerHTML = '';
    if (reqs && reqs.length) {
        box.appendChild(el(`<div class="section-title">Follow requests</div>`));
        reqs.forEach(r => {
            const u = r.actor || {};
            const row = el(`<div class="nrow">${avatarHTML(u.username, u.avatar)}
              <div class="ntext"><b>${esc(u.username || 'someone')}</b> wants to follow you</div>
              <div class="nacts"><button class="pill primary rq-ok">Approve</button><button class="pill rq-no">Delete</button></div></div>`);
            $('.rq-ok', row).onclick = async () => { await db.approveFollow(r.follower_id); db.notify(r.follower_id, 'follow_accept'); row.remove(); };
            $('.rq-no', row).onclick = async () => { await db.denyFollow(r.follower_id); row.remove(); };
            box.appendChild(row);
        });
    }
    const list = (notes || []).filter(n => n.type !== 'follow_request');
    if (!list.length && !(reqs && reqs.length)) return void (box.innerHTML = `<div class="empty">No activity yet.</div>`);
    if (list.length) box.appendChild(el(`<div class="section-title">Recent</div>`));
    list.forEach(n => {
        const u = n.actor || {};
        const thumb = n.post?.preview ? `<img class="nthumb" src="${safeMediaUrl(n.post.preview)}" alt="">` : '';
        const link = n.post_id ? `#/p/${n.post_id}` : `#/u/${encodeURIComponent(u.username || '')}`;
        box.appendChild(el(`<a class="nrow" href="${link}">${avatarHTML(u.username, u.avatar)}
          <div class="ntext"><b>${esc(u.username || 'someone')}</b> ${notifText(n.type)}<div class="ntime">${ago(n.created_at)}</div></div>${thumb}</a>`));
    });
    db.markAllRead(); setBadge(0);   // opening Activity clears the badge
};

// ===================== chrome (nav) + router =====================
const chrome = () => `
  <header>
    <span class="logo" data-go="#/">Peek</span>
    <div class="grow"></div>
    <span id="online" class="muted">…</span>
    <button class="icon hide-mobile" data-go="#/" title="Home" aria-label="Home">⌂</button>
    <button class="icon hide-mobile" data-go="#/new" title="New post" aria-label="New post">＋</button>
    <button class="icon hide-mobile" data-go="#/people" title="Find people" aria-label="Find people">🔍</button>
    <button class="icon" data-go="#/activity" title="Activity" aria-label="Activity">🔔<span class="badge-count" id="notifdot"></span></button>
    <button class="icon" id="theme" title="Theme" aria-label="Toggle light/dark theme">◐</button>
    <button class="navavatar hide-mobile" data-go="#/u/${encodeURIComponent(state.profile.username)}" aria-label="Your profile">${isMediaUrl(state.profile.avatar) ? `<img src="${state.profile.avatar}" alt="">` : initial(state.profile.username)}</button>
  </header>`;

// Instagram-style bottom tab bar (mobile only; hidden on desktop via CSS).
const tabbar = () => `
  <nav id="tabbar" aria-label="Primary">
    <button class="tab" data-go="#/" title="Home" aria-label="Home">⌂</button>
    <button class="tab" data-go="#/people" title="Search" aria-label="Find people">🔍</button>
    <button class="tab" data-go="#/new" title="New post" aria-label="New post">＋</button>
    <button class="tab" data-go="#/u/${encodeURIComponent(state.profile.username)}" aria-label="Your profile"><span class="navavatar">${isMediaUrl(state.profile.avatar) ? `<img src="${state.profile.avatar}" alt="">` : initial(state.profile.username)}</span></button>
  </nav>`;

const mountChrome = () => {
    if (!state.profile) return;   // nothing to render chrome from yet
    if (!$('header')) document.body.insertAdjacentElement('afterbegin', el(chrome()));
    if (!$('#tabbar')) document.body.appendChild(el(tabbar()));
};
const unmountChrome = () => document.body.querySelectorAll('header, #tabbar').forEach(n => n.remove());

const route = () => {
    const h = location.hash.slice(1) || '/';
    const [, seg, arg] = h.split('/');
    lazyImg?.disconnect(); feedSentinelObs?.disconnect();   // stop retaining the previous view's (now-detached) nodes
    mountChrome();           // ensure top bar + bottom tab bar present
    if (seg === 'new') return viewNew();
    if (seg === 'edit') return viewEditProfile();
    if (seg === 'activity') return viewActivity();
    if (seg === 'people') return viewPeople();
    if (seg === 'p' && arg) return viewPost(arg);
    if (seg === 'u' && arg) return viewProfile(decodeURIComponent(arg));
    return viewFeed();
};

document.addEventListener('click', (e) => {
    const g = e.target.closest('[data-go]'); if (g) { location.hash = g.dataset.go; }
    if (e.target.id === 'theme') { const d = document.body.classList.toggle('dark'); localStorage.im_theme = d ? 'dark' : ''; }
});
window.addEventListener('hashchange', route);

// Live feed: prepend brand-new posts (from anyone) when sitting on the feed.
const startFeedRealtime = () => {
    sb.channel('peek-posts')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'posts' }, async (payload) => {
          const list = $('#feedlist'); if (!list) return;                 // only when the feed is mounted
          const p = payload.new;
          if (p.user_id === state.me.id || $(`[data-card="${p.id}"]`)) return; // our own / already shown
          if (feedMode === 'following' && !followingIds.has(p.user_id)) return; // not in this tab
          const { data: prof } = await sb.from('profiles').select('username, avatar').eq('id', p.user_id).single();
          p.profiles = prof; p.likes = [{ count: 0 }]; p.comments = [{ count: 0 }];
          const node = el(cardHTML(p));
          list.insertAdjacentElement('afterbegin', node);
          wireCard(node, p);
      }).subscribe();
};

// Live likes & comments on any post currently on screen.
const startEngagementRealtime = () => {
    sb.channel('peek-engagement')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'likes' }, (payload) => {
          const row = payload.new || payload.old; if (!row) return;
          if (row.user_id === state.me.id) return;                    // our own likes are optimistic
          const counter = $(`[data-likes="${row.post_id}"]`); if (!counter) return;
          let n = (parseInt(counter.textContent) || 0) + (payload.eventType === 'INSERT' ? 1 : -1);
          if (n < 0) n = 0;
          counter.textContent = `${n} like${n === 1 ? '' : 's'}`;
      })
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'comments' }, async (payload) => {
          const c = payload.new;
          if (c.user_id === state.me.id) return;                      // ours is already appended
          const card = $(`[data-card="${c.post_id}"]`); if (!card) return;
          const { data: prof } = await sb.from('profiles').select('username').eq('id', c.user_id).single();
          c.profiles = prof;
          appendComment(card, c);
      }).subscribe();
};


// ===================== auth screens =====================
const viewGate = () => {
    unmountChrome();
    let mode = 'in';
    const render = () => {
        app.innerHTML = `
        <div id="gate">
          <span class="logo">Peek</span>
          <form id="af">
            ${mode === 'up' ? `<input class="field" id="username" placeholder="Username" autocomplete="username">` : ''}
            <input class="field" id="email" type="email" placeholder="Email" autocomplete="email" required>
            <input class="field" id="password" type="password" placeholder="Password" autocomplete="${mode === 'up' ? 'new-password' : 'current-password'}" required>
            <div class="err" id="ae"></div>
            <button class="btn" id="go">${mode === 'up' ? 'Sign up' : 'Log in'}</button>
          </form>
          <div class="swap">
            ${mode === 'up' ? 'Have an account?' : "Don't have an account?"}
            <button class="btn ghost" id="swap" style="width:auto;display:inline">${mode === 'up' ? 'Log in' : 'Sign up'}</button>
          </div>
        </div>`;
        $('#swap').onclick = () => { mode = mode === 'up' ? 'in' : 'up'; render(); };
        $('#af').onsubmit = submit;
    };
    const submit = async (e) => {
        e.preventDefault();
        const email = $('#email').value.trim(), password = $('#password').value;
        const errb = $('#ae'), go = $('#go');
        errb.textContent = ''; go.disabled = true;
        try {
            if (mode === 'up') {
                const username = $('#username').value.trim();
                if (!/^[a-z0-9_.]{3,20}$/i.test(username)) throw new Error('Username: 3–20 letters, numbers, _ or .');
                const { data: taken } = await sb.from('profiles').select('id').eq('username', username).maybeSingle();
                if (taken) throw new Error('That username is taken.');
                const { error } = await sb.auth.signUp({ email, password, options: { data: { username } } });
                if (error) throw error;
                // If email confirmation is on, there's no session yet.
                if (!(await sb.auth.getSession()).data.session) { toast('Check your email to confirm, then log in.'); mode = 'in'; render(); return; }
            } else {
                const { error } = await sb.auth.signInWithPassword({ email, password });
                if (error) throw error;
            }
        } catch (err) { errb.textContent = err.message || 'Something went wrong'; go.disabled = false; }
    };
    render();
};

const doLogout = async () => { await sb.auth.signOut(); location.hash = '#/'; };


// ===================== boot =====================
let bootedFor = null;   // guard: onAuthStateChange(INITIAL_SESSION) + getSession() both fire
const enterApp = async (session) => {
    // Guard against the double fire of getSession() + onAuthStateChange. Only
    // re-route if the first boot already loaded the profile; otherwise the
    // in-flight boot will route once it's done (avoids a null-profile race).
    if (bootedFor === session.user.id) { if (state.profile) route(); return; }
    bootedFor = session.user.id;
    state.me = session.user;
    // Fetch our profile; self-heal if it's missing (e.g. signed up before the
    // trigger existed, or the trigger raced). RLS lets us insert our own row.
    let { data: prof } = await sb.from('profiles').select('*').eq('id', state.me.id).maybeSingle();
    if (!prof) {
        const username = state.me.user_metadata?.username || ('user_' + state.me.id.slice(0, 8));
        const { data: made } = await sb.from('profiles').insert({ id: state.me.id, username }).select().maybeSingle();
        prof = made;
    }
    state.profile = prof || { username: 'you' };
    if (localStorage.im_theme === 'dark') document.body.classList.add('dark');
    await startRtc(onIncomingDM, (c) => c.metadata?.group ? onIncomingGroupCall(c) : onIncomingCall(c));
    startPresence();
    startFeedRealtime();
    startEngagementRealtime();
    startNotifRealtime();
    unmountChrome();
    mountChrome();
    route();
    refreshBadge();
};

sb.auth.onAuthStateChange((_evt, session) => {
    if (session) enterApp(session);
    else { bootedFor = null; sb.removeAllChannels(); unmountChrome(); viewGate(); }
});
const { data: { session } } = await sb.auth.getSession();
session ? enterApp(session) : viewGate();

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
