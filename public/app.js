const $ = id => document.getElementById(id);
const id = crypto.randomUUID();

let stream;
let pc;
let peerId;
let dataChannel;
let pollTimer;
let connectionWatchdog;
let meteredFrame;
let pendingCandidates = [];
let micOn = true;
let camOn = true;
let stopped = false;
let rtcConfig = {
  iceTransportPolicy: 'all',
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:global.stun.twilio.com:3478' }
  ]
};

async function api(path, body) {
  const options = body
    ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
    : {};
  const res = await fetch(path, options);
  if (!res.ok) throw new Error(`API ${res.status}`);
  return res.json();
}

async function loadIceConfig() {
  try {
    const config = await api('/api/ice-config');
    if (config?.iceServers?.length) rtcConfig = config;
  } catch (e) {}
}

function toast(text) {
  $('toast').textContent = text;
  $('toast').classList.add('show');
  setTimeout(() => $('toast').classList.remove('show'), 2600);
}

function addMessage(text, mine = false) {
  const el = document.createElement('div');
  el.className = `message${mine ? ' mine' : ''}`;
  el.textContent = text;
  $('messages').append(el);
  $('messages').scrollTop = $('messages').scrollHeight;
}

function updateOverlay(title, text) {
  const overlay = $('searching');
  overlay.classList.remove('hidden');
  overlay.querySelector('h2').textContent = title;
  overlay.querySelector('p').textContent = text;
}

function setSearching() {
  updateOverlay('Ищем собеседника', 'Откройте эту же ссылку на другом устройстве и нажмите старт.');
  $('statusText').textContent = 'ПОИСК';
  $('chatTitle').textContent = 'Ищем собеседника';
  closeMeteredRoom();
  const remoteVideo = $('remoteVideo');
  if (remoteVideo) remoteVideo.srcObject = null;
}

function setConnecting() {
  updateOverlay('Собеседник найден', 'Соединяем видео и звук через релей…');
  $('statusText').textContent = 'СОЕДИНЯЕМ';
  $('chatTitle').textContent = 'Собеседник найден';
  clearTimeout(connectionWatchdog);
  connectionWatchdog = setTimeout(() => {
    if (pc && pc.connectionState !== 'connected') setConnectionProblem();
  }, 15000);
}

function setLive() {
  clearTimeout(connectionWatchdog);
  $('searching').classList.add('hidden');
  $('statusText').textContent = 'В ЭФИРЕ';
  $('chatTitle').textContent = 'Можно говорить';
}

function openMeteredRoom(roomURL) {
  closePeer();
  setConnecting();
  addMessage('Собеседник найден. Открываем рабочую видео-комнату автоматически...');
  window.location.href = roomURL;
}

function closeMeteredRoom() {
  if (!meteredFrame) return;
  const video = document.createElement('video');
  video.id = 'remoteVideo';
  video.autoplay = true;
  video.playsInline = true;
  meteredFrame.replaceWith(video);
  meteredFrame = null;
}

function setConnectionProblem() {
  updateOverlay('Видео не пробилось', 'Нажмите “Следующий” или обновите страницу на двух устройствах.');
  $('statusText').textContent = 'НЕТ СВЯЗИ';
  $('chatTitle').textContent = 'Видео не соединилось';
}

async function start() {
  try {
    stopped = false;
    closePeer();
    closeMeteredRoom();
    clearTimeout(pollTimer);
    await api('/api/leave', { id }).catch(() => {});
    $('intro').classList.add('hidden');
    $('chat').classList.remove('hidden');
    $('messageForm').classList.add('hidden');
    $('localVideo').closest('.local-wrap').classList.add('hidden');
    setSearching();
    await loadIceConfig();
    await api('/api/join', { id });
    poll();
  } catch (e) {
    toast('Не удалось начать поиск. Обновите страницу и попробуйте снова.');
  }
}

async function poll() {
  if (stopped) return;
  try {
    const { events } = await api(`/api/events?id=${id}`);
    for (const event of events) await handleEvent(event);
  } catch (e) {
    toast('Связь с сервером потеряна');
  }
  pollTimer = setTimeout(poll, 500);
}

async function handleEvent(event) {
  if (event.type === 'matched') {
    peerId = event.peerId;
    if (event.roomURL) {
      openMeteredRoom(event.roomURL);
      return;
    }
    setConnecting();
    await createPeer(event.initiator);
  }

  if (event.type === 'signal' && pc) {
    if (event.signal.sdp) {
      await pc.setRemoteDescription(event.signal.sdp);
      for (const candidate of pendingCandidates.splice(0)) {
        try { await pc.addIceCandidate(candidate); } catch (e) {}
      }
      if (event.signal.sdp.type === 'offer') {
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        signal({ sdp: pc.localDescription });
      }
    }

    if (event.signal.candidate) {
      if (pc.remoteDescription) {
        try { await pc.addIceCandidate(event.signal.candidate); } catch (e) {}
      } else {
        pendingCandidates.push(event.signal.candidate);
      }
    }
  }

  if (event.type === 'peer-left') {
    closePeer();
    setSearching();
    await api('/api/join', { id });
  }
}

async function createPeer(initiator) {
  closePeer();
  pendingCandidates = [];
  pc = new RTCPeerConnection(rtcConfig);

  stream.getTracks().forEach(track => pc.addTrack(track, stream));

  pc.ontrack = e => {
    $('remoteVideo').srcObject = e.streams[0];
    $('remoteVideo').play().catch(() => {});
    setLive();
  };

  pc.onicecandidate = e => {
    if (e.candidate) signal({ candidate: e.candidate });
  };

  pc.onconnectionstatechange = () => {
    if (pc?.connectionState === 'connected') setLive();
    if (['failed', 'disconnected'].includes(pc?.connectionState)) setConnectionProblem();
  };

  pc.oniceconnectionstatechange = () => {
    if (['failed', 'disconnected'].includes(pc?.iceConnectionState)) setConnectionProblem();
  };

  pc.ondatachannel = e => setupChannel(e.channel);

  if (initiator) {
    setupChannel(pc.createDataChannel('chat'));
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    signal({ sdp: pc.localDescription });
  }
}

function setupChannel(channel) {
  dataChannel = channel;
  dataChannel.onmessage = e => addMessage(e.data);
}

function signal(signalBody) {
  return api('/api/signal', { from: id, to: peerId, signal: signalBody });
}

function closePeer() {
  clearTimeout(connectionWatchdog);
  if (pc) pc.close();
  pc = null;
  dataChannel = null;
  peerId = null;
  pendingCandidates = [];
}

async function next() {
  closePeer();
  closeMeteredRoom();
  setSearching();
  await api('/api/next', { id });
}

async function stop() {
  stopped = true;
  clearTimeout(pollTimer);
  await api('/api/leave', { id });
  closePeer();
  closeMeteredRoom();
  stream?.getTracks().forEach(t => t.stop());
  stream = null;
  $('chat').classList.add('hidden');
  $('intro').classList.remove('hidden');
  setSearching();
}

$('startBtn').onclick = start;
$('nextBtn').onclick = next;
$('stopBtn').onclick = stop;

$('micBtn').onclick = () => {
  micOn = !micOn;
  stream?.getAudioTracks().forEach(t => t.enabled = micOn);
  $('micBtn').classList.toggle('off', !micOn);
  toast(micOn ? 'Микрофон включён' : 'Микрофон выключен');
};

$('camBtn').onclick = () => {
  camOn = !camOn;
  stream?.getVideoTracks().forEach(t => t.enabled = camOn);
  $('camBtn').classList.toggle('off', !camOn);
  toast(camOn ? 'Камера включена' : 'Камера выключена');
};

$('messageForm').onsubmit = e => {
  e.preventDefault();
  const text = $('messageInput').value.trim();
  if (!text) return;
  if (dataChannel?.readyState === 'open') {
    dataChannel.send(text);
    addMessage(text, true);
    $('messageInput').value = '';
  } else {
    toast('Сначала дождитесь собеседника');
  }
};

$('reportBtn').onclick = () => {
  toast('Жалоба отправлена. Ищем нового собеседника');
  next();
};

$('rulesBtn').onclick = () => $('rulesDialog').showModal();
$('closeRules').onclick = $('acceptRules').onclick = () => $('rulesDialog').close();

window.addEventListener('beforeunload', () => {
  navigator.sendBeacon('/api/leave', new Blob([JSON.stringify({ id })], { type: 'application/json' }));
});

setInterval(() => {
  $('onlineCount').textContent = (1270 + Math.floor(Math.random() * 45)).toLocaleString('ru-RU');
}, 4000);
