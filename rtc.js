import { sb, state, rand, idb, fullCache, chunkString } from './core.js';

// ===================== WebRTC over Supabase Realtime (no PeerJS cloud) =====================
// The offer/answer/ICE handshake rides Supabase Realtime Broadcast (infra we already
// run), keyed by user_id — so there's no third-party signaling server to be flaky.
// Media/data still flow directly browser-to-browser once connected.
// Optional TURN relay — fill this in to make P2P work on cellular / symmetric NAT
// (carrier-grade NAT). Grab short-lived creds from Metered / Cloudflare / Twilio, or
// self-host coturn. Empty = STUN-only (fine on Wi-Fi, often fails on cellular).
const TURN = [];
// e.g. const TURN = [{ urls: ['turn:HOST:3478?transport=udp', 'turn:HOST:3478?transport=tcp'], username: 'user', credential: 'pass' }];
const ICE = { iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:global.stun.twilio.com:3478' },
    ...TURN,
] };

// Binary transfer: stream an ArrayBuffer over the data channel in ~16KB pieces,
// pausing when the send buffer backs up so we never overrun it on big images /
// slow links. The channel is ordered + reliable, so chunks need no indices.
const CHUNK = 16 * 1024;
const drain = (dc) => new Promise(res => { const t = () => (dc.bufferedAmount > (1 << 20) ? setTimeout(t, 20) : res()); t(); });
const sendBinary = async (dc, buf) => { for (let o = 0; o < buf.byteLength; o += CHUNK) { try { dc.send(buf.slice(o, o + CHUNK)); } catch (e) { return; } await drain(dc); } };

let signalCh = null;
let onDataConn = null, onMediaConn = null;   // incoming handlers (were peer.on('connection'/'call'))
const conns = new Map();                     // cid -> { handleSignal }
const signalSend = (to, msg) => { try { signalCh && signalCh.send({ type: 'broadcast', event: 'sig', payload: { to, from: state.me.id, ...msg } }); } catch (e) {} };
const emitter = () => { const L = {}; return {
    on(ev, fn) { (L[ev] || (L[ev] = [])).push(fn); return this; },
    emit(ev, ...a) { (L[ev] || []).forEach(f => f(...a)); },
}; };

// Reliable, ordered data connection — same surface the app used from PeerJS.
const makeDataConn = (remote, cid, initiator, metadata) => {
    const ev = emitter(); const pc = new RTCPeerConnection(ICE);
    let dc, remoteSet = false, closed = false; const pend = [];
    const fireClose = () => { if (closed) return; closed = true; api.open = false; conns.delete(cid); ev.emit('close'); };
    const api = {
        peer: remote, metadata, open: false,
        on(e, fn) { ev.on(e, fn); return api; },
        send(o) { try { if (dc && dc.readyState === 'open') dc.send(JSON.stringify(o)); } catch (e) {} },
        close() { try { dc && dc.close(); } catch (e) {} try { pc.close(); } catch (e) {} conns.delete(cid); },
        get dataChannel() { return dc; },
    };
    const wireDC = (ch) => {
        dc = ch;
        dc.binaryType = 'arraybuffer';                        // receive binary payload chunks as ArrayBuffers
        dc.onopen = () => { api.open = true; ev.emit('open'); };
        dc.onmessage = (m) => {
            if (typeof m.data === 'string') { let d; try { d = JSON.parse(m.data); } catch (e) { d = m.data; } ev.emit('data', d); }
            else ev.emit('chunk', m.data);                    // binary chunk (ordered channel → arrives in send order)
        };
        dc.onclose = fireClose;
    };
    pc.onicecandidate = (e) => { if (e.candidate) signalSend(remote, { cid, kind: 'data', ice: e.candidate }); };
    let discT = null;   // 'disconnected' is usually a transient blip — give it a grace period before tearing down
    pc.onconnectionstatechange = () => {
        const s = pc.connectionState;
        if (s === 'connected') { clearTimeout(discT); discT = null; }
        else if (s === 'disconnected') { clearTimeout(discT); discT = setTimeout(fireClose, 8000); }
        else if (s === 'failed' || s === 'closed') { clearTimeout(discT); fireClose(); }
    };
    if (initiator) {
        wireDC(pc.createDataChannel('d'));
        pc.createOffer().then(o => pc.setLocalDescription(o))
          .then(() => signalSend(remote, { cid, kind: 'data', sdp: pc.localDescription, metadata }));
    } else { pc.ondatachannel = (e) => wireDC(e.channel); }
    conns.set(cid, { handleSignal: async (msg) => {
        if (msg.sdp) {
            await pc.setRemoteDescription(msg.sdp); remoteSet = true;
            pend.splice(0).forEach(c => pc.addIceCandidate(c).catch(() => {}));
            if (msg.sdp.type === 'offer') { await pc.setLocalDescription(await pc.createAnswer()); signalSend(remote, { cid, kind: 'data', sdp: pc.localDescription }); }
        } else if (msg.ice) { remoteSet ? pc.addIceCandidate(msg.ice).catch(() => {}) : pend.push(msg.ice); }
    } });
    return api;
};

// Media (video call) connection.
const makeMediaConn = (remote, cid, initiator, metadata, stream) => {
    const ev = emitter(); const pc = new RTCPeerConnection(ICE);
    let remoteSet = false, closed = false; const pend = [];
    const fireClose = () => { if (closed) return; closed = true; conns.delete(cid); ev.emit('close'); };
    const addTracks = (s) => s.getTracks().forEach(t => pc.addTrack(t, s));
    const api = {
        peer: remote, metadata,
        on(e, fn) { ev.on(e, fn); return api; },
        answer: async (s) => { addTracks(s); await pc.setLocalDescription(await pc.createAnswer()); signalSend(remote, { cid, kind: 'media', sdp: pc.localDescription }); },
        close() { try { pc.close(); } catch (e) {} conns.delete(cid); },
    };
    pc.onicecandidate = (e) => { if (e.candidate) signalSend(remote, { cid, kind: 'media', ice: e.candidate }); };
    pc.ontrack = (e) => ev.emit('stream', e.streams[0]);
    let discT = null;   // 'disconnected' is usually a transient blip — give it a grace period before tearing down
    pc.onconnectionstatechange = () => {
        const s = pc.connectionState;
        if (s === 'connected') { clearTimeout(discT); discT = null; }
        else if (s === 'disconnected') { clearTimeout(discT); discT = setTimeout(fireClose, 8000); }
        else if (s === 'failed' || s === 'closed') { clearTimeout(discT); fireClose(); }
    };
    if (initiator) {
        addTracks(stream);
        pc.createOffer().then(o => pc.setLocalDescription(o))
          .then(() => signalSend(remote, { cid, kind: 'media', sdp: pc.localDescription, metadata }));
    }
    conns.set(cid, { handleSignal: async (msg) => {
        if (msg.sdp) { await pc.setRemoteDescription(msg.sdp); remoteSet = true; pend.splice(0).forEach(c => pc.addIceCandidate(c).catch(() => {})); }
        else if (msg.ice) { remoteSet ? pc.addIceCandidate(msg.ice).catch(() => {}) : pend.push(msg.ice); }
    } });
    return api;
};

// PeerJS-shaped facade so the rest of the app is unchanged (target by user_id).
const peer = {
    connect: (userId, opts = {}) => makeDataConn(userId, rand(), true, opts.metadata),
    call: (userId, stream, opts = {}) => makeMediaConn(userId, rand(), true, opts.metadata, stream),
};

// Dispatch an incoming signaling message to its connection (or create one on offer).
const onSignal = (p) => {
    if (!p || p.to !== state.me.id) return;
    let entry = conns.get(p.cid);
    if (!entry) {
        if (!p.sdp || p.sdp.type !== 'offer') return;   // stray candidate/answer for a dead conn
        if (p.kind === 'data') { const c = makeDataConn(p.from, p.cid, false, p.metadata); onDataConn && onDataConn(c); }
        else if (p.kind === 'media') { const c = makeMediaConn(p.from, p.cid, false, p.metadata); onMediaConn && onMediaConn(c); }
        entry = conns.get(p.cid);
    }
    entry && entry.handleSignal(p);
};

const startRtc = (dmHandler, callHandler) => new Promise((resolve) => {
    // incoming connections (moved from the old peer.on('connection'/'call'))
    onDataConn = (c) => {
        if (c.metadata?.kind === 'dm') return dmHandler(c);
        c.on('data', async (d) => {              // else: a one-shot image request (with optional carousel idx)
            if (!d || d.type !== 'want') return;
            const idx = d.idx || 0;
            const full = await idb.get(`post:${d.postId}:${idx}`) || (idx === 0 ? await idb.get('post:' + d.postId) : null);
            if (!full) return c.send({ type: 'miss', postId: d.postId });
            if (d.bin && typeof full === 'string') {          // new viewer: send the JPEG as raw binary (no base64 inflation)
                const mime = full.slice(5, full.indexOf(';')) || 'image/jpeg';
                const buf = await (await fetch(full)).arrayBuffer();
                c.send({ type: 'img-meta', postId: d.postId, bin: 1, bytes: buf.byteLength, mime });
                await sendBinary(c.dataChannel, buf);
                c.send({ type: 'img-done', postId: d.postId });
            } else {                                          // legacy viewer: base64 string parts (kept for rollout compatibility)
                const chunks = chunkString(full);
                c.send({ type: 'img-meta', postId: d.postId, parts: chunks.length });
                chunks.forEach((s, i) => c.send({ type: 'img-part', postId: d.postId, i, s }));
            }
        });
    };
    onMediaConn = callHandler;
    signalCh = sb.channel('peek-signal', { config: { broadcast: { self: false } } });
    signalCh.on('broadcast', { event: 'sig' }, ({ payload }) => onSignal(payload));
    signalCh.subscribe((status) => { if (status === 'SUBSCRIBED') resolve(); });
});

// Ask an online author's browser for the full image of a post; reassembles chunks.
// idx selects which image of a multi-image (carousel) post; cache key is postId:idx.
const fetchFull = (postId, authorId, idx = 0) => new Promise((resolve) => {
    const ck = `${postId}:${idx}`;
    if (fullCache.has(ck)) return resolve(fullCache.get(ck));
    if (!authorId) return resolve(null);
    let done = false, buf = null, need = 0, got = 0;              // legacy base64-parts state
    let binMode = false, mime = 'image/jpeg'; const parts = [];   // binary-transfer state
    const finish = (v) => { if (done) return; done = true; if (v) fullCache.set(ck, v); try { c.close(); } catch (e) {} resolve(v); };
    const c = peer.connect(authorId, {});
    const timer = setTimeout(() => finish(null), 20000);
    c.on('open', () => c.send({ type: 'want', postId, idx, bin: 1 }));   // advertise binary support
    c.on('data', (d) => {
        if (!d || d.postId !== postId) return;
        if (d.type === 'miss') { clearTimeout(timer); return finish(null); }
        if (d.type === 'img') { clearTimeout(timer); return finish(d.full); }   // legacy single-shot
        if (d.type === 'img-meta') {
            if (d.bin) { binMode = true; mime = d.mime || 'image/jpeg'; }         // binary transfer incoming
            else { need = d.parts; buf = new Array(need); got = 0; }              // legacy base64 parts
            return;
        }
        if (d.type === 'img-done' && binMode) { clearTimeout(timer); return finish(URL.createObjectURL(new Blob(parts, { type: mime }))); }
        if (d.type === 'img-part' && buf && buf[d.i] == null) {
            buf[d.i] = d.s;
            if (++got === need) { clearTimeout(timer); finish(buf.join('')); }
        }
    });
    c.on('chunk', (ab) => { if (binMode) parts.push(ab); });   // collect binary chunks (arrive in order on a reliable channel)
    c.on('close', () => { clearTimeout(timer); finish(null); });
});


export { peer, startRtc, fetchFull };
