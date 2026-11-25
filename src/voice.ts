// Voice notes: one microphone recording at a time, and one player for all cards.
// A recording belongs to a card id and lives here, not in the component, so it
// carries on while the board is panned, zoomed or left.
import { useSyncExternalStore } from 'react';
import * as api from './api';
import { t } from './i18n';
import { fillHistory, getState, patchElement, subscribeState, toast, commit } from './store';
import type { VoiceContent } from './types';

const TICK_MS = 100;
const MAX_MS = 60 * 60 * 1000;
const MIN_MS = 400;
export const BARS = 40;
// Below this the microphone is picking up nothing at all (muted or the wrong one).
const SILENCE = 0.004;

export interface VoiceSession {
  phase: 'starting' | 'recording' | 'paused' | 'saving' | 'failed' | 'blocked';
  ms: number;
  // The latest loudness values (0–1), newest last.
  levels: number[];
  silent?: boolean;
  message?: string;
}

interface Take {
  file: File;
  duration: number;
  peaks: number[];
}

const listeners = new Set<() => void>();
const notify = () => listeners.forEach((l) => l());
const subscribe = (fn: () => void) => {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
};

// ---------------------------------------------------------------- recording

const sessions = new Map<string, VoiceSession>();
// Recorded but not saved yet (the upload failed): kept for another try.
const unsaved = new Map<string, Take>();
let active: Recording | null = null;

function setSession(id: string, next: VoiceSession | null) {
  if (next) sessions.set(id, next);
  else sessions.delete(id);
  notify();
}

export const useVoiceSession = (id: string) => useSyncExternalStore(subscribe, () => sessions.get(id));
// The card being recorded right now, or the first one that couldn't be saved.
export const useBusyVoice = () => useSyncExternalStore(subscribe, () => active?.id ?? unsaved.keys().next().value ?? null);

// Formats in order of preference: AAC plays in every browser, the others are what's left.
const FORMATS: [mime: string, ext: string][] = [
  ['audio/mp4;codecs=mp4a.40.2', '.m4a'],
  ['audio/webm;codecs=opus', '.weba'],
  ['audio/mp4', '.m4a'],
  ['audio/ogg;codecs=opus', '.ogg'],
];

function fileName(ext: string) {
  const d = new Date();
  const two = (n: number) => String(n).padStart(2, '0');
  return `${t('Voice note')} ${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}.${two(d.getMinutes())}.${two(d.getSeconds())}${ext}`;
}

// Squeezes the loudness history into BARS whole numbers from 0 to 100.
function toPeaks(levels: number[]) {
  if (!levels.length) return [];
  const loudest = levels.reduce((a, b) => Math.max(a, b), 0.02);
  return Array.from({ length: BARS }, (_, i) => {
    const from = Math.floor((i * levels.length) / BARS);
    const slice = levels.slice(from, Math.max(from + 1, Math.floor(((i + 1) * levels.length) / BARS)));
    return Math.round((Math.max(...slice) / loudest) * 100);
  });
}

class Recording {
  private stream: MediaStream | null = null;
  private recorder: MediaRecorder | null = null;
  private audio: AudioContext | null = null;
  private timer = 0;
  private chunks: Blob[] = [];
  private levels: number[] = [];
  private ms = 0;
  private lastTick = 0;
  private ext = '.weba';
  private stopping = false;
  private over = false;
  private keep = true;

  constructor(readonly id: string) {}

  async start() {
    setSession(this.id, { phase: 'starting', ms: 0, levels: [] });
    if (!window.isSecureContext) return this.fail(t('Recording needs https or localhost'));
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') return this.fail(t("This browser can't record audio"));
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      if (this.over) return stream.getTracks().forEach((tr) => tr.stop());
      this.stream = stream;
      const format = FORMATS.find(([mime]) => MediaRecorder.isTypeSupported(mime));
      this.recorder = new MediaRecorder(stream, { ...(format ? { mimeType: format[0] } : {}), audioBitsPerSecond: 48_000 });
      this.ext = format?.[1] ?? '.weba';
      this.recorder.ondataavailable = (e) => e.data.size && this.chunks.push(e.data);
      // Also fires when the microphone is unplugged: what was said so far is kept.
      this.recorder.onstop = () => this.done();
      this.recorder.start(1000);
      this.listen(stream);
      this.lastTick = performance.now();
      this.timer = window.setInterval(() => this.tick(), TICK_MS);
      this.publish();
    } catch (err) {
      if (this.over) return;
      const name = (err as DOMException)?.name;
      if (name === 'NotFoundError') this.fail(t('No microphone found'));
      else if (name === 'NotAllowedError') this.fail(t("Microphone blocked. Allow it in the browser's site settings."));
      else this.fail(t("Couldn't start the microphone"));
    }
  }

  private sample: () => number = () => 0;

  // Only feeds the moving bars; recording works without it.
  private listen(stream: MediaStream) {
    try {
      this.audio = new AudioContext();
      void this.audio.resume();
      const analyser = this.audio.createAnalyser();
      analyser.fftSize = 2048;
      this.audio.createMediaStreamSource(stream).connect(analyser);
      const data = new Float32Array(analyser.fftSize);
      this.sample = () => {
        analyser.getFloatTimeDomainData(data);
        let max = 0;
        for (const v of data) max = Math.max(max, Math.abs(v));
        return max;
      };
    } catch {}
  }

  private tick() {
    const now = performance.now();
    const dt = now - this.lastTick;
    this.lastTick = now;
    if (this.recorder?.state !== 'recording') return;
    this.ms += dt;
    const level = this.sample();
    // Background tabs tick once a second: repeat the value so the bars stay in step with time.
    for (let n = Math.max(1, Math.round(dt / TICK_MS)); n > 0; n--) this.levels.push(level);
    if (this.ms >= MAX_MS) return this.stop();
    this.publish();
  }

  private publish() {
    if (this.over) return;
    const recent = this.levels.slice(-BARS);
    setSession(this.id, {
      phase: this.recorder?.state === 'paused' ? 'paused' : 'recording',
      ms: this.ms,
      levels: recent,
      silent: !!this.audio && this.levels.length >= BARS && recent.every((v) => v < SILENCE),
    });
  }

  togglePause() {
    if (this.recorder?.state === 'recording') {
      this.tick();
      this.recorder.pause();
    } else if (this.recorder?.state === 'paused') {
      this.recorder.resume();
      this.lastTick = performance.now();
    }
    this.publish();
  }

  // Ends the recording and saves it (or throws it away).
  stop(keep = true) {
    if (this.over || this.stopping) return;
    this.stopping = true;
    this.keep = keep;
    if (!this.recorder) {
      // Still waiting for permission: nothing has been recorded.
      this.keep = false;
      return this.done();
    }
    this.tick();
    if (this.recorder.state !== 'inactive') this.recorder.stop();
    else this.done();
  }

  private release() {
    this.over = true;
    window.clearInterval(this.timer);
    this.stream?.getTracks().forEach((tr) => tr.stop());
    void this.audio?.close().catch(() => {});
    if (active === this) active = null;
  }

  private fail(message: string) {
    this.release();
    setSession(this.id, { phase: 'blocked', ms: 0, levels: [], message });
  }

  private done() {
    if (this.over) return;
    this.release();
    const type = (this.recorder?.mimeType || 'audio/webm').split(';')[0];
    const blob = new Blob(this.chunks, { type });
    if (!this.keep) return setSession(this.id, null);
    if (!blob.size || this.ms < MIN_MS) {
      toast(t('Recording was too short'));
      return setSession(this.id, null);
    }
    void save(this.id, { file: new File([blob], fileName(this.ext), { type }), duration: Math.round(this.ms) / 1000, peaks: toPeaks(this.levels) });
  }
}

async function save(id: string, take: Take) {
  unsaved.set(id, take);
  setSession(id, { phase: 'saving', ms: take.duration * 1000, levels: [] });
  try {
    const up = await api.upload(take.file);
    const content: VoiceContent = { src: up.url, name: up.name, size: up.size, mime: up.mime, duration: take.duration, peaks: take.peaks };
    const el = getState().elements[id];
    const again = el?.type === 'voice' && !!el.content.src;
    // The first recording belongs to the step that added the card; recording again is a step of its own.
    if (el) patchElement(id, { content }, { history: again });
    fillHistory(id, (old) => (old.type === 'voice' && !old.content.src ? { ...old, content } : old));
    unsaved.delete(id);
    setSession(id, null);
  } catch (err) {
    const full = String(err).includes('413');
    setSession(id, {
      phase: 'failed',
      ms: take.duration * 1000,
      levels: [],
      message: full ? t('Your storage is full. Delete some files and try again.') : t("Couldn't save the recording"),
    });
    if (!document.querySelector(`[data-el="${id}"]`)) toast(t("Couldn't save the recording"));
  }
}

export function startRecording(id: string) {
  if (getState().readOnly || sessions.get(id)?.phase === 'saving') return;
  stopPlaying();
  active?.stop(); // a recording already running on another card is saved first
  unsaved.delete(id);
  active = new Recording(id);
  void active.start();
}

// The card being recorded right now.
export const recordingId = () => active?.id ?? null;
export const isWaitingForMic = (id: string) => sessions.get(id)?.phase === 'starting';
export const stopRecording = () => active?.stop();
export const togglePauseRecording = () => active?.togglePause();

// Throws the recording away; a card that never held one goes with it.
export function cancelRecording(id: string) {
  if (active?.id === id) active.stop(false);
  unsaved.delete(id);
  setSession(id, null);
  const el = getState().elements[id];
  if (el?.type === 'voice' && !el.content.src) commit({ [id]: null }, { history: false });
}

export function retrySave(id: string) {
  const take = unsaved.get(id);
  if (take) void save(id, take);
}

export function downloadUnsaved(id: string) {
  const take = unsaved.get(id);
  if (!take) return;
  const a = document.createElement('a');
  a.href = URL.createObjectURL(take.file);
  a.download = take.file.name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 60_000);
}

// Where the microphone can't be used (a phone on plain http): pick or record a file instead.
export async function takeAudioFile(id: string, file: File) {
  if (!file.type.startsWith('audio/') && !/\.(mp3|m4a|wav|ogg|oga|opus|weba|aac|flac)$/i.test(file.name)) return toast(t('Choose an audio file'));
  const duration = await new Promise<number>((resolve) => {
    const probe = new Audio();
    const url = URL.createObjectURL(file);
    const end = (d: number) => {
      URL.revokeObjectURL(url);
      resolve(Number.isFinite(d) ? d : 0);
    };
    probe.onloadedmetadata = () => end(probe.duration);
    probe.onerror = () => end(0);
    probe.src = url;
  });
  await save(id, { file, duration, peaks: [] });
}

// Deleting or undoing the card ends its recording, but what was said is kept,
// so redo or Restore brings it back.
subscribeState(() => {
  if (!active) return;
  const el = getState().elements[active.id];
  if (!el || el.section === 'trash') active.stop();
});

window.addEventListener('beforeunload', (e) => {
  if (active || unsaved.size) e.preventDefault();
});

// ---------------------------------------------------------------- playing

export interface Playback {
  playing: boolean;
  time: number;
}

const RATES = [1, 1.5, 2];
const RATE_KEY = 'cn:voice-rate';
let rate = 1;
try {
  const saved = Number(localStorage.getItem(RATE_KEY));
  if (RATES.includes(saved)) rate = saved;
} catch {}

let audio: HTMLAudioElement | null = null;
let current: { id: string; src: string; duration: number } | null = null;
let playback: Playback | undefined;
let frame = 0;

export const usePlayback = (id: string) => useSyncExternalStore(subscribe, () => (current?.id === id ? playback : undefined));
export const useRate = () => useSyncExternalStore(subscribe, () => rate);

function report() {
  if (!audio || !current) return;
  playback = { playing: !audio.paused && !audio.ended, time: audio.ended ? 0 : audio.currentTime };
  notify();
}

function follow() {
  cancelAnimationFrame(frame);
  report();
  if (audio && !audio.paused) frame = requestAnimationFrame(follow);
}

function player() {
  if (audio) return audio;
  audio = new Audio();
  audio.addEventListener('play', follow);
  audio.addEventListener('pause', follow);
  audio.addEventListener('ended', follow);
  audio.addEventListener('seeked', report);
  return audio;
}

// Browsers record without writing the length into the file, which leaves it
// unknown (Infinity). Asking for a point far past the end makes them find it.
function findLength(a: HTMLAudioElement) {
  if (a.duration !== Infinity) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const done = () => {
      if (a.duration === Infinity) return;
      a.removeEventListener('durationchange', done);
      resolve();
    };
    a.addEventListener('durationchange', done);
    setTimeout(resolve, 2000);
    a.currentTime = 1e7;
  });
}

async function load(id: string, content: VoiceContent) {
  const a = player();
  if (current?.id === id && current.src === content.src && !a.error) return a;
  a.pause();
  current = { id, src: content.src, duration: content.duration };
  playback = { playing: false, time: 0 };
  notify();
  a.src = content.src;
  await new Promise<void>((resolve, reject) => {
    a.onloadedmetadata = () => resolve();
    a.onerror = () => reject(a.error);
  });
  await findLength(a);
  a.currentTime = 0;
  return a;
}

async function playFrom(id: string, content: VoiceContent, seconds?: number) {
  try {
    const a = await load(id, content);
    if (current?.id !== id) return; // another card was started meanwhile
    if (seconds !== undefined) a.currentTime = seconds;
    else if (a.ended) a.currentTime = 0;
    a.playbackRate = rate;
    await a.play();
  } catch (err) {
    // Switching to another card mid-load interrupts this one; that isn't a failure.
    if ((err as DOMException)?.name === 'AbortError' || current?.id !== id) return;
    stopPlaying();
    toast(t("Couldn't play this recording"));
  }
}

export function togglePlay(id: string, content: VoiceContent) {
  if (!content.src || active) return;
  if (current?.id === id && audio && !audio.paused && !audio.ended) audio.pause();
  else void playFrom(id, content);
}

export function seekTo(id: string, content: VoiceContent, fraction: number) {
  if (!content.src || active || !content.duration) return;
  void playFrom(id, content, Math.min(0.999, Math.max(0, fraction)) * content.duration);
}

export function stopPlaying(id?: string) {
  if (!current || (id && current.id !== id)) return;
  audio?.pause();
  current = null;
  playback = undefined;
  notify();
}

export function nextRate() {
  rate = RATES[(RATES.indexOf(rate) + 1) % RATES.length];
  if (audio) audio.playbackRate = rate;
  try {
    localStorage.setItem(RATE_KEY, String(rate));
  } catch {}
  notify();
}
