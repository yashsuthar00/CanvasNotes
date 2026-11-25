import { useEffect, useRef, useState, type MouseEvent, type ReactNode } from 'react';
import { pickFiles } from '../actions';
import { t } from '../i18n';
import { useStore } from '../store';
import type { ElementOf } from '../types';
import {
  BARS,
  cancelRecording,
  downloadUnsaved,
  nextRate,
  retrySave,
  seekTo,
  startRecording,
  stopPlaying,
  stopRecording,
  togglePauseRecording,
  togglePlay,
  takeAudioFile,
  useBusyVoice,
  usePlayback,
  useRate,
  useVoiceSession,
  type VoiceSession,
} from '../voice';

export function formatTime(seconds: number) {
  const s = Math.max(0, Math.floor(seconds));
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  const two = (n: number) => String(n).padStart(2, '0');
  return h ? `${h}:${two(m % 60)}:${two(s % 60)}` : `${m}:${two(s % 60)}`;
}

const MicIcon = () => (
  <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <rect x="9" y="3" width="6" height="11" rx="3" />
    <path d="M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v3" />
  </svg>
);
const Glyph = ({ d }: { d: string }) => (
  <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden>
    <path d={d} />
  </svg>
);
const PLAY = 'M8 5.5v13l10.5-6.5z';
const PAUSE = 'M7 5h3.5v14H7zM13.5 5H17v14h-3.5z';
const STOP = 'M6.5 6.5h11v11h-11z';

function Round({ label, hotkey, onClick, kind = '', children }: { label: string; hotkey?: string; onClick(): void; kind?: string; children: ReactNode }) {
  return (
    <button data-nodrag className={`voice-round ${kind}`} title={hotkey ? `${label} (${hotkey})` : label} aria-label={label} onClick={onClick}>
      {children}
    </button>
  );
}

function Bars({ values, played }: { values: number[]; played?: number }) {
  return (
    <>
      {values.map((v, i) => (
        <i key={i} className={played !== undefined && (i + 0.5) / values.length <= played ? 'on' : undefined} style={{ height: `${Math.max(8, v)}%` }} />
      ))}
    </>
  );
}

// The moving bars, newest on the right.
function LiveBars({ levels }: { levels: number[] }) {
  const padded = [...Array<number>(Math.max(0, BARS - levels.length)).fill(0), ...levels];
  return (
    <div className="voice-bars live" aria-hidden>
      <Bars values={padded.map((v) => Math.min(100, Math.sqrt(v) * 110))} />
    </div>
  );
}

function RecordingControls({ id, session }: { id: string; session: VoiceSession }) {
  if (session.phase === 'starting') {
    return (
      <div className="voice-row">
        <span className="voice-round waiting">
          <MicIcon />
        </span>
        <span className="voice-note">{t('Waiting for the microphone…')}</span>
        <button data-nodrag className="voice-x" title={t('Cancel')} aria-label={t('Cancel')} onClick={() => cancelRecording(id)}>
          ✕
        </button>
      </div>
    );
  }
  if (session.phase === 'saving') {
    return (
      <div className="voice-row">
        <span className="voice-round waiting">
          <MicIcon />
        </span>
        <span className="voice-note">{t('Saving…')}</span>
        <span className="voice-time">{formatTime(session.ms / 1000)}</span>
      </div>
    );
  }
  if (session.phase === 'failed') {
    return (
      <div className="voice-message">
        <span role="alert">{session.message}</span>
        <div className="voice-actions">
          <button data-nodrag onClick={() => retrySave(id)}>{t('Try again')}</button>
          <button data-nodrag onClick={() => downloadUnsaved(id)}>{t('Download')}</button>
          <button data-nodrag onClick={() => cancelRecording(id)}>{t('Cancel')}</button>
        </div>
      </div>
    );
  }
  if (session.phase === 'blocked') {
    return (
      <div className="voice-message">
        <span role="alert">{session.message}</span>
        <div className="voice-actions">
          <button data-nodrag onClick={() => startRecording(id)}>{t('Try again')}</button>
          <button data-nodrag onClick={() => pickFiles('audio/*', ([file]) => file && void takeAudioFile(id, file))}>{t('Upload audio')}</button>
          <button data-nodrag onClick={() => cancelRecording(id)}>{t('Cancel')}</button>
        </div>
      </div>
    );
  }
  const paused = session.phase === 'paused';
  return (
    <>
      <div className={`voice-row ${paused ? 'paused' : ''}`}>
        <Round label={t('Stop and save')} hotkey="R" kind="stop" onClick={stopRecording}>
          <Glyph d={STOP} />
        </Round>
        <LiveBars levels={session.levels} />
        <span className="voice-time">{formatTime(session.ms / 1000)}</span>
        <button data-nodrag className="voice-x" title={`${t(paused ? 'Resume' : 'Pause')} (P)`} aria-label={t(paused ? 'Resume' : 'Pause')} onClick={togglePauseRecording}>
          {paused ? <MicIcon /> : <Glyph d={PAUSE} />}
        </button>
        <button data-nodrag className="voice-x" title={`${t('Discard recording')} (Shift R)`} aria-label={t('Discard recording')} onClick={() => cancelRecording(id)}>
          ✕
        </button>
      </div>
      {session.silent && <div className="voice-hint">{t('No sound yet. Check the microphone.')}</div>}
    </>
  );
}

const FLAT = Array<number>(BARS).fill(30);

export function VoiceBody({ el }: { el: ElementOf<'voice'> }) {
  const { id, content } = el;
  const session = useVoiceSession(id);
  const playback = usePlayback(id);
  const rate = useRate();
  const readOnly = useStore((s) => s.readOnly);
  const pressed = useRef<{ x: number; y: number } | null>(null);
  // Leaving the board stops the sound.
  useEffect(() => () => stopPlaying(id), [id]);

  if (session) {
    return (
      <div className={`card voice ${['recording', 'paused'].includes(session.phase) ? 'recording' : ''}`}>
        <RecordingControls id={id} session={session} />
      </div>
    );
  }
  if (!content.src) {
    return (
      <div className="card voice">
        <div className="voice-row">
          {!readOnly && (
            <Round label={t('Record a voice note')} kind="record" onClick={() => startRecording(id)}>
              <MicIcon />
            </Round>
          )}
          <span className="voice-note">{readOnly ? t('Voice note') : t('Record a voice note')}</span>
        </div>
      </div>
    );
  }
  const playing = !!playback?.playing;
  const played = playback && content.duration ? Math.min(1, playback.time / content.duration) : 0;
  // A press that didn't move jumps to that point; a drag moves the card.
  const onBarsClick = (e: MouseEvent<HTMLDivElement>) => {
    const p = pressed.current;
    if (!p || Math.hypot(e.clientX - p.x, e.clientY - p.y) > 4 || e.shiftKey) return;
    const r = e.currentTarget.getBoundingClientRect();
    seekTo(id, content, (e.clientX - r.left) / r.width);
  };
  return (
    <div className="card voice">
      <div className="voice-row">
        <Round label={t(playing ? 'Pause' : 'Play')} onClick={() => togglePlay(id, content)}>
          <Glyph d={playing ? PAUSE : PLAY} />
        </Round>
        <div
          className="voice-bars"
          onPointerDown={(e) => (pressed.current = { x: e.clientX, y: e.clientY })}
          onClick={onBarsClick}
        >
          <Bars values={content.peaks?.length ? content.peaks : FLAT} played={played} />
        </div>
        <span className="voice-time">{formatTime(playback && (playing || playback.time > 0) ? playback.time : content.duration)}</span>
        <button data-nodrag className="voice-rate" title={t('Playback speed')} aria-label={t('Playback speed')} onClick={nextRate}>
          {rate}×
        </button>
      </div>
    </div>
  );
}

// While recording, the card may be scrolled away or on another board: this keeps Stop within reach.
export function RecordingBar() {
  const id = useBusyVoice();
  return id ? <RecordingBarFor id={id} /> : null;
}

function RecordingBarFor({ id }: { id: string }) {
  const session = useVoiceSession(id);
  const [hidden, setHidden] = useState(false);
  useEffect(() => {
    const look = () => {
      const card = document.querySelector(`[data-el="${id}"]`)?.getBoundingClientRect();
      const view = document.querySelector('.canvas')?.getBoundingClientRect();
      const x = card ? card.left + card.width / 2 : 0;
      const y = card ? card.top + card.height / 2 : 0;
      setHidden(!card || !view || x < view.left || x > view.right || y < view.top || y > view.bottom);
    };
    look();
    const timer = window.setInterval(look, 250);
    return () => window.clearInterval(timer);
  }, [id]);
  if (!session || !hidden || !['recording', 'paused', 'failed'].includes(session.phase)) return null;
  return (
    <div className="voice-dock card">
      <RecordingControls id={id} session={session} />
    </div>
  );
}
