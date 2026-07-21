const $ = selector => document.querySelector(selector);

const state = {
  socket: null,
  authenticated: false,
  control: true,
  decoder: null,
  decoderConfig: null,
  fallback: false,
  waitingForKey: true,
  videoGeneration: 0,
  latestReceivedFrame: -1,
  lastDecoderReset: 0,
  latestFrame: null,
  renderQueued: false,
  remoteWidth: 3440,
  remoteHeight: 1440,
  streamWidth: 3440,
  streamHeight: 1440,
  frameWidth: 3440,
  frameHeight: 1440,
  renderBounds: { x: 0, y: 0, width: 1, height: 1 },
  lastPointer: 0,
  reconnectTimer: null,
  resizeTimer: null,
  settingsTimer: null,
  connectedAt: 0,
  measuredFrames: 0,
  measuredBytes: 0,
  measureStarted: performance.now(),
  currentBitrate: 16,
  bitrateLimit: 16,
  adaptiveScale: 1,
  goodWindows: 0,
  lastAdaptation: 0,
  pendingPing: null,
  pingSerial: 0,
  lastRecovery: 0
};

const canvas = $('#desktopCanvas');
const context = canvas.getContext('2d', { alpha: false, desynchronized: true });
const stage = $('#desktopStage');
const mouseButtons = ['left', 'middle', 'right'];

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) }
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Request failed.');
  return data;
}

function requestFullscreen() {
  if (document.fullscreenElement) return;
  const request = document.documentElement.requestFullscreen || document.documentElement.webkitRequestFullscreen;
  if (!request) return;
  try {
    const result = request.call(document.documentElement, { navigationUI: 'hide' });
    result?.catch?.(() => {});
  } catch {}
}

function resizeCanvas() {
  const rect = canvas.getBoundingClientRect();
  const pixelRatio = Math.min(window.devicePixelRatio || 1, 3);
  const width = Math.max(1, Math.round(rect.width * pixelRatio));
  const height = Math.max(1, Math.round(rect.height * pixelRatio));
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = 'high';
  }
}

function drawFrame(frame) {
  resizeCanvas();
  const sourceWidth = frame.displayWidth || frame.width || state.remoteWidth;
  const sourceHeight = frame.displayHeight || frame.height || state.remoteHeight;
  state.frameWidth = sourceWidth;
  state.frameHeight = sourceHeight;
  const scale = Math.min(canvas.width / sourceWidth, canvas.height / sourceHeight);
  const width = Math.round(sourceWidth * scale);
  const height = Math.round(sourceHeight * scale);
  const x = Math.round((canvas.width - width) / 2);
  const y = Math.round((canvas.height - height) / 2);
  state.renderBounds = {
    x: x / canvas.width,
    y: y / canvas.height,
    width: width / canvas.width,
    height: height / canvas.height
  };
  context.fillStyle = '#000';
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(frame, x, y, width, height);
  frame.close?.();
  $('#streamPlaceholder').classList.add('hidden');
}

function queueFrame(frame) {
  if (Number.isFinite(frame.timestamp)) {
    const outputFrameId = Math.round(frame.timestamp * 60 / 1_000_000);
    send({ type: 'frame-ack', generation: state.videoGeneration, frameId: outputFrameId });
  } else {
    send({ type: 'jpeg-ack' });
  }
  state.latestFrame?.close?.();
  state.latestFrame = frame;
  if (state.renderQueued) return;
  state.renderQueued = true;
  requestAnimationFrame(() => {
    state.renderQueued = false;
    const latest = state.latestFrame;
    state.latestFrame = null;
    if (latest) drawFrame(latest);
  });
}

function closeDecoder() {
  state.latestFrame?.close?.();
  state.latestFrame = null;
  if (state.decoder && state.decoder.state !== 'closed') {
    try { state.decoder.close(); } catch {}
  }
  state.decoder = null;
  state.decoderConfig = null;
}

function useJpegFallback() {
  if (state.fallback) return;
  state.fallback = true;
  closeDecoder();
  sendClientConfig();
}

function configureDecoder(message) {
  if (!('VideoDecoder' in window)) return useJpegFallback();
  closeDecoder();
  state.fallback = false;
  state.waitingForKey = true;
  state.streamWidth = Number(message.width) || state.streamWidth;
  state.streamHeight = Number(message.height) || state.streamHeight;
  try {
    state.decoder = new VideoDecoder({
      output: queueFrame,
      error: () => useJpegFallback()
    });
    state.decoderConfig = {
      codec: message.codec,
      codedWidth: state.streamWidth,
      codedHeight: state.streamHeight,
      optimizeForLatency: true,
      hardwareAcceleration: 'prefer-hardware'
    };
    state.decoder.configure(state.decoderConfig);
  } catch {
    useJpegFallback();
  }
}

function resetDecoderForLatency() {
  if (!state.decoder || !state.decoderConfig) return;
  state.lastDecoderReset = performance.now();
  state.latestFrame?.close?.();
  state.latestFrame = null;
  state.waitingForKey = true;
  try {
    state.decoder.reset();
    state.decoder.configure(state.decoderConfig);
    const now = performance.now();
    if ($('#adaptiveBitrate').checked && now - state.lastAdaptation > 2500) {
      state.currentBitrate = Math.max(4, Math.floor(state.currentBitrate * 0.8));
      if ($('#resolutionSelect').value === 'auto') state.adaptiveScale = Math.max(0.5, state.adaptiveScale - 0.15);
      state.lastAdaptation = now;
      updateAdaptiveLabel();
      sendClientConfig();
    } else {
      send({ type: 'resync' });
    }
  } catch {
    useJpegFallback();
  }
}

function decodePacket(buffer) {
  if (buffer.byteLength < 16 || !state.decoder || state.decoder.state !== 'configured') return;
  const view = new DataView(buffer);
  const key = view.getUint8(1) === 1;
  const fps = view.getUint16(6, true) || 60;
  const frameId = view.getUint32(8, true);
  const length = view.getUint32(12, true);
  if (length < 1 || length > buffer.byteLength - 16) return;
  state.latestReceivedFrame = frameId;
  if (state.waitingForKey && !key) return;
  if (key) state.waitingForKey = false;
  try {
    state.decoder.decode(new EncodedVideoChunk({
      type: key ? 'key' : 'delta',
      timestamp: Math.round(frameId * 1_000_000 / fps),
      data: new Uint8Array(buffer, 16, length)
    }));
  } catch {
    state.waitingForKey = true;
  }
}

async function decodeJpeg(buffer) {
  try {
    const bitmap = await createImageBitmap(new Blob([buffer], { type: 'image/jpeg' }));
    queueFrame(bitmap);
  } catch {}
}

function handleBinary(buffer) {
  if (!(buffer instanceof ArrayBuffer) || buffer.byteLength === 0) return;
  state.measuredFrames++;
  state.measuredBytes += buffer.byteLength;
  if (new Uint8Array(buffer, 0, 1)[0] === 2) decodePacket(buffer);
  else decodeJpeg(buffer);
}

function handleMessage(message) {
  if (message.type === 'welcome') {
    state.remoteWidth = message.screen.width;
    state.remoteHeight = message.screen.height;
    state.control = message.control;
    $('#actualResolution').textContent = `${message.screen.width} × ${message.screen.height}`;
  } else if (message.type === 'stream-config') {
    state.videoGeneration = Number(message.generation) || 0;
    state.measuredFrames = 0;
    state.measuredBytes = 0;
    state.measureStarted = performance.now();
    configureDecoder(message);
  } else if (message.type === 'display-status') {
    state.remoteWidth = message.width;
    state.remoteHeight = message.height;
    $('#actualResolution').textContent = `${message.width} × ${message.height} @ ${message.refresh || 60} Hz`;
  } else if (message.type === 'display-error') {
    $('#actualResolution').textContent = 'Change failed';
    $('#streamSettings').classList.add('open');
  } else if (message.type === 'control') {
    state.control = message.enabled;
  } else if (message.type === 'latency-pong' && state.pendingPing?.id === message.id) {
    const rtt = performance.now() - state.pendingPing.started;
    state.pendingPing = null;
    if (rtt > 650) recoverFromLag();
  } else if (message.type === 'capture-error') {
    useJpegFallback();
  }
}

function send(payload) {
  if (state.socket?.readyState === WebSocket.OPEN) state.socket.send(JSON.stringify(payload));
}

function preferredStream() {
  const pixelRatio = Math.min(window.devicePixelRatio || 1, 3);
  const viewportWidth = window.visualViewport?.width || window.innerWidth;
  const viewportHeight = window.visualViewport?.height || window.innerHeight;
  const clientWidth = Math.max(640, Math.round(viewportWidth * pixelRatio));
  const clientHeight = Math.max(480, Math.round(viewportHeight * pixelRatio));
  const resolution = $('#resolutionSelect').value;
  const manual = /^(\d+)x(\d+)$/.exec(resolution);
  const desiredStreamWidth = manual ? Number(manual[1]) : resolution === 'native' ? 2560 : clientWidth;
  const autoWidth = Math.min(1920, desiredStreamWidth) * state.adaptiveScale;
  const width = Math.max(640, Math.min(2560, resolution === 'auto' ? autoWidth : desiredStreamWidth));
  const limit = Math.max(4, Math.min(50, Number($('#bitrateRange').value) || 16));
  const bitrate = $('#adaptiveBitrate').checked ? Math.min(limit, state.currentBitrate) : limit;
  return { width: Math.round(width / 16) * 16, bitrate, fps: 60, resolution, clientWidth, clientHeight };
}

function adaptiveBitrateFloor() {
  const resolution = $('#resolutionSelect').value;
  const requestedWidth = resolution === 'native' ? 2560 : Number(/^\d+/.exec(resolution)?.[0]) || 0;
  const wanted = requestedWidth >= 2560 ? 20 : requestedWidth >= 1920 ? 14 : requestedWidth >= 1440 ? 10 : requestedWidth >= 1280 ? 8 : 4;
  return Math.min(state.bitrateLimit, wanted);
}

function sendClientConfig() {
  send({
    type: 'client-config',
    codecs: !state.fallback && 'VideoDecoder' in window ? ['h264-webcodecs'] : [],
    ...preferredStream()
  });
}

function recoverFromLag() {
  const now = performance.now();
  if (now - state.lastRecovery < 3000 || state.socket?.readyState !== WebSocket.OPEN) return;
  state.lastRecovery = now;
  state.pendingPing = null;
  if ($('#adaptiveBitrate').checked) {
    const reduced = Math.max(adaptiveBitrateFloor(), Math.floor(state.currentBitrate * 0.65));
    if (reduced < state.currentBitrate) state.currentBitrate = reduced;
    else if ($('#resolutionSelect').value === 'auto') state.adaptiveScale = Math.max(0.5, state.adaptiveScale - 0.2);
    state.lastAdaptation = now;
    updateAdaptiveLabel();
  }
  state.socket.close(4001, 'Discard delayed stream');
}

function sendLatencyPing() {
  if (state.pendingPing || state.socket?.readyState !== WebSocket.OPEN) return;
  const pending = { id: ++state.pingSerial, started: performance.now() };
  state.pendingPing = pending;
  send({ type: 'latency-ping', id: pending.id });
  setTimeout(() => {
    if (state.pendingPing?.id === pending.id && performance.now() - pending.started > 900) recoverFromLag();
  }, 950);
}

function updateAdaptiveLabel(fps) {
  const enabled = $('#adaptiveBitrate').checked;
  const suffix = Number.isFinite(fps) ? ` · ${fps.toFixed(0)} FPS received` : '';
  $('#adaptiveStatus').textContent = enabled
    ? `Using ${state.currentBitrate} Mbps${state.adaptiveScale < 1 ? ` · ${Math.round(state.adaptiveScale * 100)}% stream size` : ''}${suffix}`
    : `Fixed bitrate${suffix}`;
}

function adaptStream() {
  sendLatencyPing();
  const now = performance.now();
  const elapsed = (now - state.measureStarted) / 1000;
  if (elapsed < 1.5) return;
  const fps = state.measuredFrames / elapsed;
  state.measuredFrames = 0;
  state.measuredBytes = 0;
  state.measureStarted = now;
  updateAdaptiveLabel(fps);

  if (!state.authenticated || state.fallback || !$('#adaptiveBitrate').checked || state.socket?.readyState !== WebSocket.OPEN) return;
  if (now - state.connectedAt < 6000 || now - state.lastAdaptation < 5000) return;

  let changed = false;
  if (fps < 52) {
    const reduced = Math.max(adaptiveBitrateFloor(), Math.floor(state.currentBitrate * 0.72));
    if (reduced < state.currentBitrate) {
      state.currentBitrate = reduced;
      changed = true;
    } else if (fps < 48 && $('#resolutionSelect').value === 'auto' && state.adaptiveScale > 0.5) {
      state.adaptiveScale = Math.max(0.5, state.adaptiveScale - 0.2);
      changed = true;
    }
    state.goodWindows = 0;
  } else if (fps >= 58) {
    state.goodWindows++;
    if (state.goodWindows >= 5) {
      if (state.adaptiveScale < 1) {
        state.adaptiveScale = Math.min(1, state.adaptiveScale + 0.1);
        changed = true;
      } else if (state.currentBitrate < state.bitrateLimit) {
        state.currentBitrate = Math.min(state.bitrateLimit, state.currentBitrate + 2);
        changed = true;
      }
      state.goodWindows = 0;
    }
  } else {
    state.goodWindows = 0;
  }

  if (changed) {
    state.lastAdaptation = now;
    updateAdaptiveLabel(fps);
    sendClientConfig();
  }
}

function connectRemote() {
  if (!state.authenticated) return;
  clearTimeout(state.reconnectTimer);
  state.pendingPing = null;
  state.socket?.close();
  const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
  const socket = new WebSocket(`${protocol}://${location.host}/remote`);
  socket.binaryType = 'arraybuffer';
  state.socket = socket;

  socket.onopen = () => {
    state.connectedAt = performance.now();
    state.measureStarted = performance.now();
    state.measuredFrames = 0;
    state.measuredBytes = 0;
    sendClientConfig();
  };
  socket.onmessage = event => {
    if (typeof event.data === 'string') {
      try { handleMessage(JSON.parse(event.data)); } catch {}
    } else {
      handleBinary(event.data);
    }
  };
  socket.onclose = async () => {
    if (state.socket !== socket || !state.authenticated) return;
    state.pendingPing = null;
    closeDecoder();
    try {
      const status = await api('/api/status');
      if (!status.authenticated) return showLogin();
    } catch {}
    state.reconnectTimer = setTimeout(connectRemote, 900);
  };
}

function showRemote() {
  state.authenticated = true;
  $('#loginScreen').classList.add('hidden');
  $('#remoteApp').classList.remove('hidden');
  resizeCanvas();
  connectRemote();
}

function showLogin() {
  state.authenticated = false;
  state.pendingPing = null;
  clearTimeout(state.reconnectTimer);
  state.socket?.close(1000);
  closeDecoder();
  $('#remoteApp').classList.add('hidden');
  $('#loginScreen').classList.remove('hidden');
  $('#accessCode').value = '';
}

function remotePoint(event) {
  const rect = canvas.getBoundingClientRect();
  // Use the exact normalized rectangle from drawFrame. This keeps pointer and
  // touch placement aligned with the visible pixels through resolution and
  // aspect-ratio changes, including the short decoder transition between them.
  const canvasX = (event.clientX - rect.left) / rect.width;
  const canvasY = (event.clientY - rect.top) / rect.height;
  const bounds = state.renderBounds;
  return {
    x: Math.max(0, Math.min(1, (canvasX - bounds.x) / bounds.width)),
    y: Math.max(0, Math.min(1, (canvasY - bounds.y) / bounds.height))
  };
}

const pointerMoveEvent = 'onpointerrawupdate' in window ? 'pointerrawupdate' : 'pointermove';
stage.addEventListener(pointerMoveEvent, event => {
  if (!state.control || performance.now() - state.lastPointer < 8) return;
  state.lastPointer = performance.now();
  send({ type: 'input', input: { type: 'move', ...remotePoint(event) } });
});
stage.addEventListener('pointerdown', event => {
  requestFullscreen();
  if (!state.control) return;
  stage.focus({ preventScroll: true });
  stage.setPointerCapture?.(event.pointerId);
  send({ type: 'input', input: { type: 'move', ...remotePoint(event) } });
  send({ type: 'input', input: { type: 'button', button: mouseButtons[event.button] || 'left', down: true } });
});
stage.addEventListener('pointerup', event => {
  if (state.control) send({ type: 'input', input: { type: 'button', button: mouseButtons[event.button] || 'left', down: false } });
});
stage.addEventListener('pointercancel', event => {
  if (state.control) send({ type: 'input', input: { type: 'button', button: mouseButtons[event.button] || 'left', down: false } });
});
stage.addEventListener('wheel', event => {
  if (!state.control) return;
  event.preventDefault();
  send({ type: 'input', input: { type: 'wheel', x: event.deltaX / 24, y: event.deltaY / 24 } });
}, { passive: false });
stage.addEventListener('contextmenu', event => event.preventDefault());

function setSettingsOpen(open) {
  $('#streamSettings').classList.toggle('open', open);
}

function queueSettingsUpdate() {
  clearTimeout(state.settingsTimer);
  state.settingsTimer = setTimeout(sendClientConfig, 220);
}

$('#settingsHotspot').addEventListener('click', () => setSettingsOpen(true));
$('#streamSettingsClose').addEventListener('click', () => setSettingsOpen(false));
$('#settingsDone').addEventListener('click', () => { sendClientConfig(); setSettingsOpen(false); });
$('#resolutionSelect').addEventListener('change', () => {
  state.adaptiveScale = 1;
  state.currentBitrate = Math.max(state.currentBitrate, adaptiveBitrateFloor());
  updateAdaptiveLabel();
  queueSettingsUpdate();
});
$('#bitrateRange').addEventListener('input', event => {
  state.bitrateLimit = Number(event.target.value);
  if (!$('#adaptiveBitrate').checked || state.currentBitrate > state.bitrateLimit) state.currentBitrate = state.bitrateLimit;
  $('#bitrateValue').textContent = `${event.target.value} Mbps`;
  updateAdaptiveLabel();
  queueSettingsUpdate();
});
$('#adaptiveBitrate').addEventListener('change', event => {
  if (!event.target.checked) state.currentBitrate = state.bitrateLimit;
  state.goodWindows = 0;
  state.lastAdaptation = performance.now();
  updateAdaptiveLabel();
  sendClientConfig();
});

window.addEventListener('keydown', event => {
  if (!state.authenticated) return;
  if (event.ctrlKey && event.shiftKey && event.code === 'KeyS') {
    event.preventDefault();
    setSettingsOpen(!$('#streamSettings').classList.contains('open'));
    return;
  }
  if ($('#streamSettings').classList.contains('open')) {
    if (event.key === 'Escape') setSettingsOpen(false);
    return;
  }
  if (!state.control) return;
  event.preventDefault();
  send({
    type: 'input',
    input: {
      type: 'key', key: event.key, code: event.code,
      ctrl: event.ctrlKey, alt: event.altKey, shift: event.shiftKey, meta: event.metaKey
    }
  });
});

window.addEventListener('resize', () => {
  resizeCanvas();
  clearTimeout(state.resizeTimer);
  state.resizeTimer = setTimeout(sendClientConfig, 500);
});

$('#loginForm').addEventListener('submit', async event => {
  event.preventDefault();
  requestFullscreen();
  $('#loginError').textContent = '';
  const button = event.currentTarget.querySelector('button[type="submit"]');
  button.disabled = true;
  try {
    await api('/api/login', { method: 'POST', body: JSON.stringify({ code: $('#accessCode').value }) });
    showRemote();
  } catch (error) {
    $('#loginError').textContent = error.message;
  } finally {
    button.disabled = false;
  }
});

$('#accessCode').addEventListener('input', event => {
  event.target.value = event.target.value.replace(/[^a-z0-9]/gi, '').toUpperCase();
});
$('#showCode').addEventListener('click', () => {
  $('#accessCode').type = $('#accessCode').type === 'password' ? 'text' : 'password';
});

async function initialize() {
  resizeCanvas();
  const connection = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
  const mobile = /Android|iPhone|iPad|Mobile/i.test(navigator.userAgent);
  const bitrateLimit = connection?.saveData ? 8 : connection?.effectiveType === '3g' ? 10 : mobile ? 24 : 30;
  const estimatedBitrate = connection?.saveData
    ? 8
    : Number(connection?.downlink) > 0
      ? Math.max(mobile ? 12 : 16, Math.floor(Number(connection.downlink) * 0.8))
      : bitrateLimit;
  state.bitrateLimit = bitrateLimit;
  state.currentBitrate = Math.min(bitrateLimit, estimatedBitrate);
  $('#bitrateRange').value = bitrateLimit;
  $('#bitrateValue').textContent = `${bitrateLimit} Mbps`;
  updateAdaptiveLabel();
  try {
    const status = await api('/api/status');
    state.remoteWidth = status.screen.width;
    state.remoteHeight = status.screen.height;
    if (status.authenticated) showRemote();
  } catch {
    $('#loginError').textContent = 'Orbit is not responding. Refresh the page.';
  }
}

setInterval(adaptStream, 2000);
initialize();
