import { defineRenderer } from '@foyer/slide-sdk';
import type { LiveConfig } from './index.ts';

const RETRY_MS = 3000;
/** No new frame for this long counts as an outage. */
const STALL_MS = 5000;

// Live picture over WebRTC (WHEP, the way the probe measured it on Airtame 2).
// Connects while the slide is being prepared, so the picture is there when it
// shows; reconnects on outages; closes the connection when hidden.
export default defineRenderer<LiveConfig>((root, { config, liveUrl, ctx }) => {
  if (!liveUrl) throw new Error('Live-Video nicht verfügbar');

  const video = document.createElement('video');
  video.className = `foyer-live__video foyer-live__video--${config.fill ? 'cover' : 'contain'}`;
  const withSound = config.sound && ctx.soundAllowed;
  // Set muted explicitly either way: Airtame plays sound otherwise (KONZEPT 6.2).
  video.muted = !withSound;
  video.defaultMuted = !withSound;
  if (!withSound) video.setAttribute('muted', '');
  video.playsInline = true;
  video.autoplay = true;
  const notice = document.createElement('div');
  notice.className = 'foyer-live__notice';
  notice.hidden = true;
  root.append(video, notice);

  let pc: RTCPeerConnection | null = null;
  let wanted = false;
  let active = false;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let watchTimer: ReturnType<typeof setInterval> | undefined;
  let lastTime = -1;
  let lastProgress = 0;

  const showNotice = (text: string | null) => {
    notice.textContent = text ?? '';
    notice.hidden = !text;
  };

  const close = () => {
    clearTimeout(retryTimer);
    clearInterval(watchTimer);
    if (pc) {
      pc.ontrack = null;
      pc.oniceconnectionstatechange = null;
      pc.close();
      pc = null;
    }
    video.srcObject = null;
  };

  const fail = (reason: string) => {
    close();
    if (!wanted) return;
    if (active && config.onError === 'skip') {
      ctx.reportError(`Live-Bild ausgefallen, Folie übersprungen (${reason})`);
      ctx.done();
      return;
    }
    if (active) showNotice('Live-Bild nicht verfügbar · neuer Versuch …');
    retryTimer = setTimeout(connect, RETRY_MS);
  };

  const play = () => {
    const played = video.play();
    if (!played || typeof played.catch !== 'function') return;
    played.catch((err: Error) => {
      if (!active || video.muted) return;
      // Sound blocked by the browser: play silently rather than not at all.
      ctx.reportError(`Ton blockiert, Live-Bild läuft stumm (${err.message})`);
      video.muted = true;
      play();
    });
  };

  async function connect() {
    close();
    if (!wanted) return;
    const peer = new RTCPeerConnection();
    pc = peer;
    peer.addTransceiver('video', { direction: 'recvonly' });
    if (config.sound) peer.addTransceiver('audio', { direction: 'recvonly' });
    peer.ontrack = (event) => {
      if (event.track.kind !== 'video' && video.srcObject) return;
      video.srcObject = event.streams[0] ?? new MediaStream([event.track]);
      if (active) play();
    };
    peer.oniceconnectionstatechange = () => {
      if (peer.iceConnectionState === 'failed') fail('Verbindung fehlgeschlagen');
    };
    try {
      await peer.setLocalDescription(await peer.createOffer());
      // No trickle ICE: wait for the candidates (at most 2 s), then one request.
      await new Promise<void>((resolve) => {
        if (peer.iceGatheringState === 'complete') return resolve();
        const timer = setTimeout(resolve, 2000);
        peer.onicegatheringstatechange = () => {
          if (peer.iceGatheringState === 'complete') {
            clearTimeout(timer);
            resolve();
          }
        };
      });
      const res = await fetch(liveUrl!, {
        method: 'POST',
        headers: { 'Content-Type': 'application/sdp' },
        body: peer.localDescription!.sdp,
      });
      if (pc !== peer) return;
      if (res.status !== 201) throw new Error((await res.text()) || `HTTP ${res.status}`);
      await peer.setRemoteDescription({ type: 'answer', sdp: await res.text() });
    } catch (err) {
      if (pc === peer) fail(String((err as Error)?.message ?? err));
      return;
    }
    // The picture counts as there once it moves; a frozen picture is an outage.
    lastTime = -1;
    lastProgress = Date.now();
    watchTimer = setInterval(() => {
      if (video.currentTime !== lastTime) {
        lastTime = video.currentTime;
        lastProgress = Date.now();
        if (video.currentTime > 0) showNotice(null);
      } else if (Date.now() - lastProgress > STALL_MS) {
        fail('kein Bild');
      }
    }, 1000);
  }

  return {
    prepare() {
      if (wanted) return;
      wanted = true;
      void connect();
    },
    start() {
      active = true;
      if (!wanted) {
        wanted = true;
        void connect();
      }
      play();
    },
    stop() {
      active = false;
      wanted = false;
      showNotice(null);
      close();
    },
    destroy() {
      active = false;
      wanted = false;
      close();
    },
  };
});
