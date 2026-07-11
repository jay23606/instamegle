import { $, $$, el, esc, toast, state, initial, avatarHTML, sb } from './core.js';
import { peer } from './rtc.js';
import { db } from './db.js';

// ===================== group chats + mesh video calls =====================
// A group is persistent (Supabase). While a panel is open, members share a
// Realtime channel: text rides ephemeral Broadcast (nothing stored), and a
// group video call is a full P2P *mesh* — every member connects to every other.
const panels = new Map();   // groupId -> { id, node, ch, members, call, name }

const memberMap = (group) => {
    const m = {}; (group.group_members || []).forEach(gm => { m[gm.user_id] = gm.profiles || {}; }); return m;
};
const gLine = (gp, html) => { const l = $('.dmlog', gp.node); l.appendChild(el(html)); l.scrollTop = l.scrollHeight; };
const gText = (gp, name, text, cls) => gLine(gp, `<div class="b ${cls}">${cls === 'them' ? `<span class="gwho">${esc(name)}</span>` : ''}${esc(text)}</div>`);
const gSys = (gp, text) => gLine(gp, `<div class="b sys">${esc(text)}</div>`);
const send = (gp, payload) => { try { gp.ch.send({ type: 'broadcast', event: 'g', payload: { from: state.me.id, name: state.profile.username, ...payload } }); } catch (e) {} };

// ---- mesh video ----
const tileFor = (gp, uid, stream, name, isLocal) => {
    let t = $(`.gtile[data-uid="${uid}"]`, gp.node);
    if (!t) { t = el(`<div class="gtile" data-uid="${uid}"><video autoplay playsinline ${isLocal ? 'muted' : ''}></video><span class="gname">${esc(name || '')}</span></div>`); $('.gvideos', gp.node).appendChild(t); }
    if (stream) $('video', t).srcObject = stream;
    gridClass(gp);
};
const removeTile = (gp, uid) => { $(`.gtile[data-uid="${uid}"]`, gp.node)?.remove(); gridClass(gp); };
const gridClass = (gp) => { const g = $('.gvideos', gp.node); if (g) g.dataset.n = Math.min($$('.gtile', gp.node).length, 4); };

const wireGroupPeer = (gp, uid, conn) => {
    gp.call.peers.set(uid, conn);
    conn.on('stream', (s) => tileFor(gp, uid, s, gp.members[uid]?.username));
    conn.on('close', () => { gp.call.peers.delete(uid); removeTile(gp, uid); });
};
// Reconcile the mesh with who's currently in the call (higher uid initiates → no glare).
const meshUpdate = (gp) => {
    if (!gp.call) return;
    const st = gp.ch.presenceState(), inCall = new Set();
    for (const k in st) for (const m of st[k]) if (m.in_call) inCall.add(k);
    for (const uid of [...gp.call.peers.keys()]) if (!inCall.has(uid)) { try { gp.call.peers.get(uid).close(); } catch (e) {} gp.call.peers.delete(uid); removeTile(gp, uid); }
    for (const uid of inCall) {
        if (uid === state.me.id || gp.call.peers.has(uid)) continue;
        if (state.me.id > uid) wireGroupPeer(gp, uid, peer.call(uid, gp.call.localStream, { metadata: { group: gp.id } }));
    }
};
const joinCall = async (gp) => {
    if (gp.call) return;
    let stream; try { stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true }); } catch (e) { return toast('Camera/mic blocked'); }
    gp.call = { localStream: stream, peers: new Map() };
    gp.node.classList.add('incall');
    tileFor(gp, state.me.id, stream, 'You', true);
    $('.gcall', gp.node).textContent = '📵';
    await gp.ch.track({ username: state.profile.username, avatar: state.profile.avatar, in_call: true });
    meshUpdate(gp);
};
const leaveCall = (gp) => {
    if (!gp.call) return;
    gp.call.peers.forEach(c => { try { c.close(); } catch (e) {} });
    gp.call.localStream.getTracks().forEach(t => t.stop());
    $('.gvideos', gp.node).innerHTML = '';
    gp.node.classList.remove('incall');
    gp.call = null;
    $('.gcall', gp.node).textContent = '📹';
    gp.ch.track({ username: state.profile.username, avatar: state.profile.avatar, in_call: false });
};
// incoming mesh leg (auto-answered if we're in that group's call)
const onIncomingGroupCall = (c) => {
    const gp = panels.get(c.metadata?.group);
    if (!gp || !gp.call || gp.call.peers.has(c.peer)) return c.close();
    c.answer(gp.call.localStream);
    wireGroupPeer(gp, c.peer, c);
};

// ---- presence + messaging ----
const updatePresence = (gp) => {
    const st = gp.ch.presenceState();
    const online = Object.keys(st).length;
    const o = $('.gonline', gp.node); if (o) o.textContent = `${online} online`;
    const othersInCall = Object.keys(st).some(k => k !== state.me.id && st[k].some(m => m.in_call));
    const btn = $('.gcall', gp.node);
    if (othersInCall && !gp.call && !gp.notified) { gSys(gp, 'Video call in progress — tap 📹 to join'); gp.notified = true; btn?.classList.add('ring'); }
    if (!othersInCall) { gp.notified = false; btn?.classList.remove('ring'); }
    if (gp.call) meshUpdate(gp);
};
const onGroupMsg = (gp, p) => {
    if (!p || p.from === state.me.id) return;
    if (p.t === 'msg') gText(gp, p.name, p.text, 'them');
};

const openGroup = async (group) => {
    let gp = panels.get(group.id);
    if (gp) return void $('.dmin input', gp.node).focus();
    const members = memberMap(group);
    const others = Object.entries(members).filter(([uid]) => uid !== state.me.id);
    const avs = others.slice(0, 3).map(([, p]) => avatarHTML(p.username, p.avatar, 'gav')).join('');
    const node = el(`
      <div class="dm group" data-group="${group.id}">
        <div class="dmhead">
          <div class="gavatars">${avs}</div>
          <span class="u">${esc(group.name || 'Group')}</span>
          <span class="gonline muted" style="font-size:11px"></span>
          <button class="icon gadd" title="Add person" aria-label="Add person">＋</button>
          <button class="icon gcall" title="Group video call" aria-label="Group video call">📹</button>
          <button class="icon dclose" title="Close" aria-label="Close">✕</button>
        </div>
        <div class="gvideos"></div>
        <div class="dmlog"></div>
        <form class="dmin"><input placeholder="Message the group…" autocomplete="off" aria-label="Message"><button type="submit">Send</button></form>
      </div>`);
    $('#dmwrap').appendChild(node);
    gp = { id: group.id, node, members, call: null, ch: null, name: group.name };
    panels.set(group.id, gp);
    gSys(gp, `${group.name || 'Group'} · ${Object.keys(members).length} members`);

    // private:true → members-only, enforced by RLS on realtime.messages
    const ch = sb.channel('group:' + group.id, { config: { private: true, presence: { key: state.me.id }, broadcast: { self: false } } });
    gp.ch = ch;
    ch.on('broadcast', { event: 'g' }, ({ payload }) => onGroupMsg(gp, payload));
    ch.on('presence', { event: 'sync' }, () => updatePresence(gp));
    ch.subscribe(async (s) => { if (s === 'SUBSCRIBED') await ch.track({ username: state.profile.username, avatar: state.profile.avatar, in_call: false }); });

    $('.dclose', node).onclick = () => { leaveCall(gp); try { ch.unsubscribe(); } catch (e) {} node.remove(); panels.delete(group.id); };
    $('.gcall', node).onclick = () => gp.call ? leaveCall(gp) : joinCall(gp);
    $('.gadd', node).onclick = () => pickPeople('Add to group', {
        exclude: new Set(Object.keys(members)),
        onPick: async (uid, username) => {
            const { error } = await db.addGroupMember(gp.id, uid);
            if (error) return toast('Could not add');
            gp.members[uid] = { username }; gSys(gp, `${username} was added`);
        },
    });
    const form = $('.dmin', node), input = $('input', form);
    form.onsubmit = (e) => { e.preventDefault(); const t = input.value.trim(); if (!t) return; send(gp, { t: 'msg', text: t }); gText(gp, 'You', t, 'me'); input.value = ''; };
};

// ---- people picker modal (create group / add member) ----
const pickPeople = async (title, opts) => {
    const body = el('<div><div class="spin">Loading…</div></div>');
    const m = el(`<div class="modal"><div class="sheet"><div class="mhead">${esc(title)}<button class="x icon" aria-label="Close">✕</button></div><div class="mbody"></div></div></div>`);
    $('.mbody', m).appendChild(body);
    $('.x', m).onclick = () => m.remove();
    m.onclick = (e) => { if (e.target === m) m.remove(); };
    document.body.appendChild(m);
    const { data: profs } = await db.allProfiles();
    const selected = new Map((opts.prefill || []).map(p => [p.uid, p.username]));
    body.innerHTML = opts.multi
        ? `<input class="field" id="gname" placeholder="Group name…" style="margin:10px 12px;width:auto;display:block"><div id="plist"></div><button class="btn" id="gcreate" style="margin:10px 12px;width:auto">Create group</button>`
        : `<div id="plist"></div>`;
    const list = $('#plist', body);
    (profs || []).filter(p => p.id !== state.me.id && !(opts.exclude && opts.exclude.has(p.id))).forEach(p => {
        const row = el(`<div class="urow">${avatarHTML(p.username, p.avatar)}<div class="who"><span class="u">${esc(p.username)}</span></div><div class="acts"></div></div>`);
        if (opts.multi) {
            const cb = el(`<button class="pill ${selected.has(p.id) ? 'primary' : ''}">${selected.has(p.id) ? 'Added' : 'Add'}</button>`);
            cb.onclick = () => { if (selected.has(p.id)) { selected.delete(p.id); cb.textContent = 'Add'; cb.classList.remove('primary'); } else { selected.set(p.id, p.username); cb.textContent = 'Added'; cb.classList.add('primary'); } };
            $('.acts', row).appendChild(cb);
        } else {
            const b = el('<button class="pill primary">Add</button>');
            b.onclick = () => { m.remove(); opts.onPick(p.id, p.username); };
            $('.acts', row).appendChild(b);
        }
        list.appendChild(row);
    });
    if (opts.multi) $('#gcreate', body).onclick = () => {
        if (!selected.size) return toast('Pick at least one person');
        const name = $('#gname', body).value.trim() || 'Group';
        m.remove(); opts.onCreate(name, [...selected.keys()]);
    };
};

const createGroupFlow = (prefill = []) => pickPeople('New group', {
    multi: true, prefill,
    onCreate: async (name, ids) => {
        const { data: g, error } = await db.createGroup(name, ids);
        if (error) return toast('Could not create group');
        const { data: full } = await db.groupById(g.id);
        openGroup(full || { ...g, group_members: [] });
        window.dispatchEvent(new Event('groups-changed'));   // let the People view refresh its list
    },
});
const addToGroupFromDM = (uid, username) => createGroupFlow([{ uid, username }]);

export { openGroup, onIncomingGroupCall, createGroupFlow, addToGroupFromDM };
