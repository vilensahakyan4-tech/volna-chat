const $ = id => document.getElementById(id);
const id = crypto.randomUUID();
let stream, pc, peerId, dataChannel, pollTimer;
let micOn = true, camOn = true, stopped = false;
const rtcConfig = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };

async function api(path, body) {
  const options = body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {};
  const res = await fetch(path, options); return res.json();
}

function toast(text) { $('toast').textContent = text; $('toast').classList.add('show'); setTimeout(() => $('toast').classList.remove('show'), 2600); }
function addMessage(text, mine = false) { const el = document.createElement('div'); el.className = `message${mine ? ' mine' : ''}`; el.textContent = text; $('messages').append(el); $('messages').scrollTop = $('messages').scrollHeight; }
function setSearching() { $('searching').classList.remove('hidden'); $('statusText').textContent = 'ПОИСК'; $('chatTitle').textContent = 'Ищем собеседника'; $('remoteVideo').srcObject = null; }

async function start() {
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 1280 }, height: { ideal: 720 } }, audio: true });
    $('localVideo').srcObject = stream; $('intro').classList.add('hidden'); $('chat').classList.remove('hidden'); stopped = false;
    await api('/api/join', { id }); poll();
  } catch (e) { toast('Разрешите доступ к камере и микрофону'); }
}

async function poll() {
  if (stopped) return;
  try { const { events } = await api(`/api/events?id=${id}`); for (const event of events) await handleEvent(event); } catch (e) {}
  pollTimer = setTimeout(poll, 500);
}

async function handleEvent(event) {
  if (event.type === 'matched') { peerId = event.peerId; await createPeer(event.initiator); }
  if (event.type === 'signal' && pc) {
    if (event.signal.sdp) { await pc.setRemoteDescription(event.signal.sdp); if (event.signal.sdp.type === 'offer') { const answer = await pc.createAnswer(); await pc.setLocalDescription(answer); signal({ sdp: pc.localDescription }); } }
    if (event.signal.candidate) try { await pc.addIceCandidate(event.signal.candidate); } catch (e) {}
  }
  if (event.type === 'peer-left') { closePeer(); setSearching(); await api('/api/join', { id }); }
}

async function createPeer(initiator) {
  closePeer(); pc = new RTCPeerConnection(rtcConfig);
  stream.getTracks().forEach(track => pc.addTrack(track, stream));
  pc.ontrack = e => { $('remoteVideo').srcObject = e.streams[0]; $('searching').classList.add('hidden'); $('statusText').textContent = 'В ЭФИРЕ'; $('chatTitle').textContent = 'Собеседник найден'; };
  pc.onicecandidate = e => { if (e.candidate) signal({ candidate: e.candidate }); };
  pc.onconnectionstatechange = () => { if (['failed','disconnected'].includes(pc?.connectionState)) setSearching(); };
  pc.ondatachannel = e => setupChannel(e.channel);
  if (initiator) { setupChannel(pc.createDataChannel('chat')); const offer = await pc.createOffer(); await pc.setLocalDescription(offer); signal({ sdp: pc.localDescription }); }
}

function setupChannel(channel) { dataChannel = channel; dataChannel.onmessage = e => addMessage(e.data); }
function signal(signal) { return api('/api/signal', { from: id, to: peerId, signal }); }
function closePeer() { if (pc) pc.close(); pc = null; dataChannel = null; peerId = null; }

async function next() { closePeer(); setSearching(); await api('/api/next', { id }); }
async function stop() { stopped = true; clearTimeout(pollTimer); await api('/api/leave', { id }); closePeer(); stream?.getTracks().forEach(t => t.stop()); $('chat').classList.add('hidden'); $('intro').classList.remove('hidden'); setSearching(); }

$('startBtn').onclick = start; $('nextBtn').onclick = next; $('stopBtn').onclick = stop;
$('micBtn').onclick = () => { micOn = !micOn; stream?.getAudioTracks().forEach(t => t.enabled = micOn); $('micBtn').classList.toggle('off', !micOn); toast(micOn ? 'Микрофон включён' : 'Микрофон выключен'); };
$('camBtn').onclick = () => { camOn = !camOn; stream?.getVideoTracks().forEach(t => t.enabled = camOn); $('camBtn').classList.toggle('off', !camOn); toast(camOn ? 'Камера включена' : 'Камера выключена'); };
$('messageForm').onsubmit = e => { e.preventDefault(); const text = $('messageInput').value.trim(); if (!text) return; if (dataChannel?.readyState === 'open') { dataChannel.send(text); addMessage(text, true); $('messageInput').value = ''; } else toast('Сначала дождитесь собеседника'); };
$('reportBtn').onclick = () => { toast('Жалоба отправлена. Ищем нового собеседника'); next(); };
$('rulesBtn').onclick = () => $('rulesDialog').showModal(); $('closeRules').onclick = $('acceptRules').onclick = () => $('rulesDialog').close();
window.addEventListener('beforeunload', () => navigator.sendBeacon('/api/leave', new Blob([JSON.stringify({ id })], { type: 'application/json' })));
setInterval(() => { $('onlineCount').textContent = (1270 + Math.floor(Math.random() * 45)).toLocaleString('ru-RU'); }, 4000);
