import { $, $$, el, esc, rand, toast, state, idb, presenceUsers, isOnline, initial, safeMediaUrl, chunkString, mimeKind } from './core.js';
import { peer } from './rtc.js';
import { addToGroupFromDM } from './groups.js';

// ===================== P2P direct messages (ephemeral, never stored) =====================
const dms = new Map();   // uid -> { conn, node }
// Local (device-only) DM history in IndexedDB — gives you history across refreshes
// without anything living on a server. Capped at the last 200 messages per person.
const dmHistory = (uid) => idb.get('dm:' + uid).then(h => h || []);
const dmSave = async (uid, entry) => {
    const h = await dmHistory(uid);
    h.push(entry); if (h.length > 200) h.splice(0, h.length - 200);
    await idb.set('dm:' + uid, h);
};
const dmLine = (dm, text, cls) => {
    const l = $('.dmlog', dm.node);
    l.appendChild(el(`<div class="b ${cls}">${esc(text)}</div>`));
    l.scrollTop = l.scrollHeight;
};

// ---- media in DMs: files / pictures / videos / voice clips, all P2P ----
const MAX_DM_FILE = 20 * 1024 * 1024;   // 20 MB (P2P + base64 held in memory)
const blobToDataURL = (blob) => new Promise((res, rej) => {
    const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(blob);
});
// Backpressure: wait if the data channel's send buffer is backed up.
const drainConn = async (conn) => {
    const dc = conn && conn.dataChannel; if (!dc) return;
    let guard = 0;
    while (dc.bufferedAmount > 4 * 1024 * 1024 && guard++ < 3000) await new Promise(r => setTimeout(r, 30));
};
// Stream raw bytes over the channel in ~16KB pieces (with backpressure) — no base64 inflation.
const BIN_CHUNK = 16 * 1024;
const sendBytes = async (conn, buf) => {
    const dc = conn && conn.dataChannel; if (!dc) return;
    for (let o = 0, i = 0; o < buf.byteLength; o += BIN_CHUNK, i++) {
        try { dc.send(buf.slice(o, o + BIN_CHUNK)); } catch (e) { return; }
        if (i % 32 === 0) await drainConn(conn);
    }
};
// Render a media bubble (image inline, video/audio players, or a download link).
const dmMedia = (dm, m, cls) => {
    const log = $('.dmlog', dm.node);
    const url = safeMediaUrl(m.data);   // peer-supplied — must be a data:/blob: media URL
    const inner =
        m.kind === 'image' ? `<img class="dmmedia" src="${url}" alt="${esc(m.name || 'image')}">` :
        m.kind === 'video' ? `<video class="dmmedia" src="${url}" controls playsinline></video>` :
        m.kind === 'audio' ? `<audio src="${url}" controls></audio>` :
        `<a class="dmfile" href="${url}" download="${esc(m.name || 'file')}">📎 ${esc(m.name || 'file')}</a>`;
    log.appendChild(el(`<div class="b ${cls} media">${inner}</div>`));
    log.scrollTop = log.scrollHeight;
};
// A transient "receiving…" bubble that shows progress, replaced by the media.
const dmProgress = (dm, meta) => {
    const log = $('.dmlog', dm.node);
    const b = el(`<div class="b sys">receiving ${esc(meta.name || meta.kind)}… 0%</div>`);
    log.appendChild(b); log.scrollTop = log.scrollHeight; return b;
};
// Keep IndexedDB light: don't persist very large media, store a placeholder instead.
const dmSaveMedia = (uid, entry) => {
    if (entry.data && entry.data.length > 12 * 1024 * 1024)
        return dmSave(uid, { me: entry.me, text: `[${entry.kind}] ${entry.name || ''} (too large to save locally)` });
    return dmSave(uid, entry).catch(() => {});   // ignore quota errors
};
// Send a file over the DM data channel. Binary when the peer advertised support (no
// base64 inflation on the wire), else legacy base64 string parts. Transfers are
// serialized per channel so two files' binary chunks can't interleave.
const sendFile = async (dm, uid, file, kind) => {
    if (!file) return;
    if (!(dm.conn && dm.conn.open)) return dmLine(dm, '(not connected — they may be offline)', 'sys');
    if (file.size > MAX_DM_FILE) return dmLine(dm, `(too big — max ${Math.round(MAX_DM_FILE / 1e6)} MB)`, 'sys');
    let dataUrl; try { dataUrl = await blobToDataURL(file); } catch (e) { return dmLine(dm, '(could not read file)', 'sys'); }
    const id = rand(), meta = { name: file.name || kind, mime: file.type, kind };
    dm.sendQ = (dm.sendQ || Promise.resolve()).then(async () => {
        try {
            if (dm.binOk) {                                  // peer supports binary → send raw bytes
                const buf = await file.arrayBuffer();
                dm.conn.send({ t: 'file-meta', id, bin: 1, bytes: buf.byteLength, ...meta });
                await sendBytes(dm.conn, buf);
                dm.conn.send({ t: 'file-done', id });
            } else {                                         // legacy peer → base64 string parts
                const chunks = chunkString(dataUrl);
                dm.conn.send({ t: 'file-meta', id, parts: chunks.length, ...meta });
                for (let i = 0; i < chunks.length; i++) {
                    dm.conn.send({ t: 'file-part', id, i, s: chunks[i] });
                    if (i % 32 === 0) await drainConn(dm.conn);   // backpressure
                }
            }
        } catch (e) { dmLine(dm, '(send failed)', 'sys'); }
    });
    await dm.sendQ;
    dmMedia(dm, { ...meta, data: dataUrl }, 'me');
    dmSaveMedia(uid, { me: true, ...meta, data: dataUrl });
};

const dmPanel = (uid, username) => {
    let dm = dms.get(uid);
    if (dm) { $('.dmin input', dm.node).focus(); return dm; }
    const node = el(`
      <div class="dm" data-dm="${uid}">
        <div class="dmhead">
          <div class="avatar dmav">${initial(username)}</div>
          <span class="u">${esc(username)}</span>
          <span class="dot" style="opacity:${isOnline(uid) ? '1' : '.25'}"></span>
          <button class="icon dgroup" title="Add to a group" aria-label="Add to a group">＋</button>
          <button class="icon dcall" title="Video call" aria-label="Start video call">📹</button>
          <button class="icon dclose" title="Close" aria-label="Close conversation">✕</button>
        </div>
        <div class="dmlog"></div>
        <div class="dmtype"></div>
        <form class="dmin">
          <button type="button" class="dmicon dmattach" title="Attach" aria-label="Attach a photo, video, or file">📎</button>
          <button type="button" class="dmicon dmmic" title="Voice clip" aria-label="Record a voice clip">🎤</button>
          <input placeholder="Message…" autocomplete="off" aria-label="Message">
          <button type="submit">Send</button>
          <input type="file" class="dmfileinput" hidden>
        </form>
      </div>`);
    $('#dmwrap').appendChild(node);
    dm = { conn: null, node };
    dms.set(uid, dm);
    const clearUnread = () => dm.node.classList.remove('unread');
    node.addEventListener('mousedown', clearUnread);
    // replay local history (text + media)
    dmHistory(uid).then(h => h.forEach(m => m.kind ? dmMedia(dm, m, m.me ? 'me' : 'them') : dmLine(dm, m.text, m.me ? 'me' : 'them')));
    $('.dclose', node).onclick = () => { try { dm.conn?.close(); } catch (e) {} node.remove(); dms.delete(uid); };
    $('.dcall', node).onclick = () => callUser(uid, username);
    $('.dgroup', node).onclick = () => addToGroupFromDM(uid, username);
    const form = $('.dmin', node), input = $('input', form); let tt;
    input.addEventListener('focus', clearUnread);
    // attach a file / picture / video
    const attach = $('.dmattach', node), fileInput = $('.dmfileinput', node);
    attach.onclick = () => fileInput.click();
    fileInput.onchange = () => { const f = fileInput.files[0]; if (f) sendFile(dm, uid, f, mimeKind(f.type)); fileInput.value = ''; };
    // record & send a voice clip (tap to start, tap again to stop & send)
    const mic = $('.dmmic', node); let rec = null, recStream = null, recChunks = [];
    mic.onclick = async () => {
        if (rec && rec.state === 'recording') return rec.stop();
        try { recStream = await navigator.mediaDevices.getUserMedia({ audio: true }); }
        catch (e) { return dmLine(dm, '(microphone blocked)', 'sys'); }
        recChunks = []; rec = new MediaRecorder(recStream);
        rec.ondataavailable = (e) => { if (e.data && e.data.size) recChunks.push(e.data); };
        rec.onstop = async () => {
            recStream.getTracks().forEach(t => t.stop()); mic.classList.remove('recording');
            const blob = new Blob(recChunks, { type: rec.mimeType || 'audio/webm' });
            await sendFile(dm, uid, new File([blob], 'voice-clip', { type: blob.type }), 'audio');
        };
        rec.start(); mic.classList.add('recording');
    };
    form.onsubmit = (e) => {
        e.preventDefault();
        const t = input.value.trim(); if (!t) return;
        if (!(dm.conn && dm.conn.open)) return dmLine(dm, '(not connected — they may be offline)', 'sys');
        try { dm.conn.send({ t: 'msg', text: t }); dmLine(dm, t, 'me'); dmSave(uid, { me: true, text: t }); input.value = ''; } catch (e2) { dmLine(dm, '(send failed)', 'sys'); }
    };
    input.oninput = () => {
        if (!(dm.conn && dm.conn.open)) return;
        try { dm.conn.send({ t: 'typing' }); } catch (e) {}
        clearTimeout(tt); tt = setTimeout(() => { try { dm.conn.send({ t: 'stop' }); } catch (e) {} }, 1200);
    };
    return dm;
};
const wireDMConn = (uid, username, conn) => {
    const dm = dmPanel(uid, username);
    dm.conn = conn;
    const typ = $('.dmtype', dm.node), dot = $('.dot', dm.node);
    const rx = {};       // in-flight incoming (legacy base64) file transfers, keyed by id
    let binRx = null;    // the current incoming binary file transfer (sends are serialized → one at a time)
    const flagUnread = () => { const inp = $('.dmin input', dm.node); if (document.activeElement !== inp) dm.node.classList.add('unread'); };
    conn.on('open', () => { dot.style.opacity = '1'; try { conn.send({ t: 'cap', bin: 1 }); } catch (e) {} });   // advertise binary support
    conn.on('data', (d) => {
        if (!d) return;
        if (d.t === 'cap') { dm.binOk = !!d.bin; return; }
        if (d.t === 'typing') return void (typ.textContent = username + ' is typing…');
        if (d.t === 'stop') return void (typ.textContent = '');
        if (d.t === 'msg') {
            typ.textContent = ''; dmLine(dm, d.text, 'them'); dmSave(uid, { me: false, text: d.text }); flagUnread();
            return;
        }
        if (d.t === 'file-meta') {
            if (d.bin) binRx = { meta: d, chunks: [], got: 0, ph: dmProgress(dm, d) };            // binary transfer incoming
            else rx[d.id] = { meta: d, buf: new Array(d.parts), got: 0, ph: dmProgress(dm, d) };  // legacy base64 parts
            return;
        }
        if (d.t === 'file-done' && binRx) {
            const it = binRx; binRx = null; if (it.ph) it.ph.remove();
            blobToDataURL(new Blob(it.chunks, { type: it.meta.mime || '' })).then(data => {   // back to a data: URL so local history survives refresh
                const m = { kind: it.meta.kind, name: it.meta.name, mime: it.meta.mime, data };
                dmMedia(dm, m, 'them'); dmSaveMedia(uid, { me: false, ...m }); flagUnread();
            }).catch(() => {});
            return;
        }
        if (d.t === 'file-part') {
            const it = rx[d.id]; if (!it || it.buf[d.i] != null) return;
            it.buf[d.i] = d.s; it.got++;
            if (it.ph) it.ph.textContent = `receiving ${it.meta.name || it.meta.kind}… ${Math.round(it.got / it.meta.parts * 100)}%`;
            if (it.got === it.meta.parts) {
                const m = { kind: it.meta.kind, name: it.meta.name, mime: it.meta.mime, data: it.buf.join('') };
                delete rx[d.id]; if (it.ph) it.ph.remove();
                dmMedia(dm, m, 'them'); dmSaveMedia(uid, { me: false, ...m }); flagUnread();
            }
            return;
        }
    });
    conn.on('chunk', (ab) => {
        if (!binRx) return;
        binRx.chunks.push(ab); binRx.got += ab.byteLength;
        if (binRx.ph) binRx.ph.textContent = `receiving ${binRx.meta.name || binRx.meta.kind}… ${Math.round(binRx.got / (binRx.meta.bytes || 1) * 100)}%`;
    });
    conn.on('close', () => { dot.style.opacity = '.25'; dmLine(dm, '(disconnected)', 'sys'); dm.conn = null; });
    conn.on('error', () => {});
};
const openDM = (uid, username) => {
    const dm = dmPanel(uid, username);
    if (dm.conn && dm.conn.open) { $('.dmin input', dm.node).focus(); return; }
    if (!isOnline(uid)) return dmLine(dm, `${username} is offline. Messages are live peer-to-peer, so they need to be online.`, 'sys');
    wireDMConn(uid, username, peer.connect(uid, {
        metadata: { kind: 'dm', user_id: state.me.id, username: state.profile.username },
    }));
};
const onIncomingDM = (conn) => {
    const meta = conn.metadata || {};
    const uid = meta.user_id || conn.peer;
    const username = meta.username || presenceUsers[conn.peer]?.username || 'someone';
    if (uid) wireDMConn(uid, username, conn);
};

// ===================== P2P video calling (slumegle engine, to a chosen user) =====================
const getMedia = () => navigator.mediaDevices.getUserMedia({ video: true, audio: true });
let localStream = null, curCall = null;
const setCallStat = (t) => { const s = $('#cstat'); if (s) s.textContent = t; };
const endCall = () => {
    try { curCall?.close(); } catch (e) {}
    curCall = null;
    if (localStream) { localStream.getTracks().forEach(t => t.stop()); localStream = null; }
    const rv = $('#rv'), lv = $('#lv'); if (rv) rv.srcObject = null; if (lv) lv.srcObject = null;
    $('#cmute').style.opacity = $('#ccam').style.opacity = '1';
    $('#callo').classList.remove('on');
};
const wireCallMedia = (c) => {
    curCall = c;
    c.on('stream', (s) => { $('#rv').srcObject = s; setCallStat(''); });
    c.on('close', endCall);
    c.on('error', endCall);
};
const callUser = async (uid, username) => {
    if (!isOnline(uid)) return toast(username + ' is offline.');
    if (curCall) return toast('Already in a call.');
    try { localStream = await getMedia(); } catch (e) { return toast('Camera/mic blocked'); }
    $('#lv').srcObject = localStream;
    $('#callo').classList.add('on'); setCallStat('Calling ' + username + '…');
    wireCallMedia(peer.call(uid, localStream, { metadata: { username: state.profile.username } }));
};
const onIncomingCall = (incoming) => {
    if (curCall) return incoming.close();   // already busy
    const username = incoming.metadata?.username || presenceUsers[incoming.peer]?.username || 'Someone';
    const banner = $('#incall');
    banner.innerHTML = `<div class="avatar ib">${initial(username)}</div>
      <div style="flex:1"><b>${esc(username)}</b><div class="muted" style="font-size:12px">Incoming video call…</div></div>
      <button class="pill primary" id="acc">Accept</button>
      <button class="pill" id="dec">Decline</button>`;
    banner.classList.add('on');
    const clear = () => banner.classList.remove('on');
    $('#dec', banner).onclick = () => { clear(); try { incoming.close(); } catch (e) {} };
    $('#acc', banner).onclick = async () => {
        clear();
        try { localStream = await getMedia(); } catch (e) { toast('Camera/mic blocked'); try { incoming.close(); } catch (e2) {} return; }
        $('#lv').srcObject = localStream;
        $('#callo').classList.add('on'); setCallStat('Connecting…');
        incoming.answer(localStream);
        wireCallMedia(incoming);
    };
};
// call-bar controls (static elements, wired once)
$('#chang').onclick = endCall;
$('#cmute').onclick = () => { const a = localStream?.getAudioTracks()[0]; if (a) { a.enabled = !a.enabled; $('#cmute').style.opacity = a.enabled ? '1' : '.4'; } };
$('#ccam').onclick  = () => { const v = localStream?.getVideoTracks()[0]; if (v) { v.enabled = !v.enabled; $('#ccam').style.opacity = v.enabled ? '1' : '.4'; } };


export { openDM, callUser, onIncomingDM, onIncomingCall, dms };
