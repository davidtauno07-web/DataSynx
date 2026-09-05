import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Panel } from '../../components/Panel';
import { formatDuration } from '../../lib/format';

type RecorderState = 'idle' | 'recording' | 'paused' | 'stopped';

interface Props {
  onImported: () => void;
}

const BAR_COUNT = 48;

/** Real MediaRecorder capture. The saved blob is uploaded verbatim. */
export function VoiceRecorder({ onImported }: Props) {
  const [state, setState] = useState<RecorderState>('idle');
  const [elapsed, setElapsed] = useState(0);
  const [levels, setLevels] = useState<number[]>(() => new Array(BAR_COUNT).fill(0));
  const [blob, setBlob] = useState<Blob | null>(null);
  const [playbackUrl, setPlaybackUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const rafRef = useRef<number | null>(null);
  const startedAtRef = useRef(0);
  const accumulatedRef = useRef(0);

  const teardown = useCallback(() => {
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    void audioContextRef.current?.close();
    audioContextRef.current = null;
    analyserRef.current = null;
  }, []);

  useEffect(() => () => teardown(), [teardown]);

  useEffect(() => {
    if (state !== 'recording') return;
    const timer = window.setInterval(() => {
      setElapsed(accumulatedRef.current + (Date.now() - startedAtRef.current));
    }, 200);
    return () => window.clearInterval(timer);
  }, [state]);

  const sampleLevels = useCallback(() => {
    const analyser = analyserRef.current;
    if (!analyser) return;
    const data = new Uint8Array(analyser.frequencyBinCount);
    analyser.getByteFrequencyData(data);
    const step = Math.max(1, Math.floor(data.length / BAR_COUNT));
    const next: number[] = [];
    for (let i = 0; i < BAR_COUNT; i += 1) next.push(data[i * step] / 255);
    setLevels(next);
    rafRef.current = requestAnimationFrame(sampleLevels);
  }, []);

  async function start() {
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;

      const context = new AudioContext();
      const analyser = context.createAnalyser();
      analyser.fftSize = 256;
      context.createMediaStreamSource(stream).connect(analyser);
      audioContextRef.current = context;
      analyserRef.current = analyser;
      rafRef.current = requestAnimationFrame(sampleLevels);

      const recorder = new MediaRecorder(stream);
      chunksRef.current = [];
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunksRef.current.push(event.data);
      };
      recorder.onstop = () => {
        const recorded = new Blob(chunksRef.current, { type: recorder.mimeType || 'audio/webm' });
        setBlob(recorded);
        setPlaybackUrl(URL.createObjectURL(recorded));
        setState('stopped');
        teardown();
      };
      recorder.start(250);
      recorderRef.current = recorder;
      accumulatedRef.current = 0;
      startedAtRef.current = Date.now();
      setElapsed(0);
      setBlob(null);
      setPlaybackUrl(null);
      setState('recording');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Microphone unavailable');
    }
  }

  function pause() {
    recorderRef.current?.pause();
    accumulatedRef.current += Date.now() - startedAtRef.current;
    setState('paused');
  }

  function resume() {
    recorderRef.current?.resume();
    startedAtRef.current = Date.now();
    setState('recording');
  }

  function stop() {
    recorderRef.current?.stop();
    accumulatedRef.current += state === 'recording' ? Date.now() - startedAtRef.current : 0;
    setElapsed(accumulatedRef.current);
  }

  function discard() {
    setBlob(null);
    setPlaybackUrl(null);
    setElapsed(0);
    setState('idle');
  }

  async function save() {
    if (!blob) return;
    setBusy(true);
    setError(null);
    try {
      const form = new FormData();
      const extension = blob.type.includes('ogg') ? 'ogg' : 'webm';
      form.append('recording', blob, `recording-${Date.now()}.${extension}`);
      form.append('durationMs', String(Math.round(elapsed)));
      const res = await fetch('/api/imports/voice', { method: 'POST', body: form, credentials: 'include' });
      if (!res.ok) {
        const payload = (await res.json().catch(() => ({}))) as { message?: string };
        throw new Error(payload.message ?? `Upload failed (${res.status})`);
      }
      discard();
      onImported();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Upload failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Panel title="Voice Recorder">
      {error && <Alert>{error}</Alert>}
      <div className="waveform" aria-hidden="true">
        {levels.map((level, index) => (
          <span key={index} style={{ height: `${Math.max(2, level * 100)}%` }} />
        ))}
      </div>
      <p className="mono" style={{ marginTop: 12 }} aria-live="polite">
        {formatDuration(elapsed)} · {state}
      </p>
      <div className="inline">
        {state === 'idle' && (
          <button className="primary" onClick={start}>
            Start
          </button>
        )}
        {state === 'recording' && <button onClick={pause}>Pause</button>}
        {state === 'paused' && <button onClick={resume}>Resume</button>}
        {(state === 'recording' || state === 'paused') && <button onClick={stop}>Stop</button>}
        {state === 'stopped' && (
          <>
            <button className="primary" onClick={save} disabled={busy}>
              {busy ? 'Saving…' : 'Save & Queue'}
            </button>
            <button onClick={discard} disabled={busy}>
              Discard
            </button>
            <button onClick={start} disabled={busy}>
              Record again
            </button>
          </>
        )}
      </div>
      {playbackUrl && <audio src={playbackUrl} controls style={{ width: '100%', marginTop: 12 }} />}
      <p className="muted mono" style={{ marginTop: 12 }}>
        The original recording is stored unmodified before any processing runs.
      </p>
    </Panel>
  );
}
