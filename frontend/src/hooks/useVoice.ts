"use client";

import { useState, useRef, useCallback, useEffect } from "react";

// ─── Types ───────────────────────────────────────────────────────────────────

export type VoiceMode = "off" | "ambient" | "activated" | "busy";
export type AudioState = "idle" | "listening" | "speaking" | "transcribing";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function getBestMimeType(): string {
  const types = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"];
  return types.find((t) => typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(t)) ?? "audio/webm";
}

const SPEECH_THRESHOLD = 12;    // 0-255 average frequency energy
const SILENCE_DURATION = 1600;  // ms of silence before sending to Whisper
const MIN_AUDIO_MS = 400;       // ignore clips shorter than this

// ─── Whisper STT with VAD ────────────────────────────────────────────────────

export interface WhisperSTTOptions {
  onTranscript: (text: string) => void;
  onLevel?: (level: number) => void; // 0-100 audio level for waveform
  lang?: string;
}

export function useWhisperSTT({ onTranscript, onLevel, lang }: WhisperSTTOptions) {
  const [audioState, setAudioState] = useState<AudioState>("idle");
  const [supported, setSupported] = useState(false);
  const [permissionDenied, setPermissionDenied] = useState(false);
  const [whisperAvailable, setWhisperAvailable] = useState<boolean | null>(null);

  const activeRef = useRef(false);
  const streamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const rafRef = useRef<number | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const silenceStartRef = useRef<number | null>(null);
  const hasSpeechRef = useRef(false);
  const recordingStartRef = useRef<number>(0);
  const onTranscriptRef = useRef(onTranscript);
  const onLevelRef = useRef(onLevel);
  const langRef = useRef(lang);

  useEffect(() => { onTranscriptRef.current = onTranscript; }, [onTranscript]);
  useEffect(() => { onLevelRef.current = onLevel; }, [onLevel]);
  useEffect(() => { langRef.current = lang; }, [lang]);

  useEffect(() => {
    const ok =
      typeof window !== "undefined" &&
      typeof navigator !== "undefined" &&
      !!navigator.mediaDevices?.getUserMedia &&
      typeof MediaRecorder !== "undefined" &&
      typeof AudioContext !== "undefined";
    setSupported(ok);
  }, []);

  // Check if Whisper endpoint is available
  useEffect(() => {
    fetch("/api/transcribe", { method: "POST", body: new FormData() })
      .then((r) => setWhisperAvailable(r.status !== 404))
      .catch(() => setWhisperAvailable(false));
  }, []);

  const sendToWhisper = useCallback(async (chunks: Blob[], mimeType: string) => {
    setAudioState("transcribing");
    const blob = new Blob(chunks, { type: mimeType });
    try {
      const fd = new FormData();
      fd.append("audio", blob, "audio.webm");
      if (langRef.current) fd.append("lang", langRef.current);
      const res = await fetch("/api/transcribe", { method: "POST", body: fd });
      const data = await res.json();
      if (data.text?.trim()) {
        onTranscriptRef.current(data.text.trim());
      }
    } catch { /* network error — ignore */ }
  }, []);

  const startCycle = useCallback(async () => {
    if (!activeRef.current) return;

    chunksRef.current = [];
    silenceStartRef.current = null;
    hasSpeechRef.current = false;
    recordingStartRef.current = Date.now();

    const mimeType = getBestMimeType();
    const recorder = new MediaRecorder(streamRef.current!, { mimeType, audioBitsPerSecond: 16000 });
    recorderRef.current = recorder;

    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) chunksRef.current.push(e.data);
    };
    recorder.start(100);
    setAudioState("listening");

    const analyser = analyserRef.current!;
    const dataArr = new Uint8Array(analyser.frequencyBinCount);

    const tick = async () => {
      if (!activeRef.current) return;
      analyser.getByteFrequencyData(dataArr);
      const level = Math.round((dataArr.reduce((s, v) => s + v, 0) / dataArr.length / 255) * 100);
      onLevelRef.current?.(level);

      const isSpeaking = level > SPEECH_THRESHOLD;

      if (isSpeaking) {
        hasSpeechRef.current = true;
        silenceStartRef.current = null;
        setAudioState("speaking");
      } else if (hasSpeechRef.current) {
        if (!silenceStartRef.current) silenceStartRef.current = Date.now();
        const silenceMs = Date.now() - silenceStartRef.current;
        if (silenceMs >= SILENCE_DURATION) {
          // Pause detected — stop recording and send to Whisper
          if (rafRef.current) cancelAnimationFrame(rafRef.current);
          recorder.stop();
          const elapsed = Date.now() - recordingStartRef.current;
          if (elapsed >= MIN_AUDIO_MS) {
            await sendToWhisper([...chunksRef.current], mimeType);
          }
          // Restart cycle immediately
          startCycle();
          return;
        }
      }

      rafRef.current = requestAnimationFrame(tick);
    };

    rafRef.current = requestAnimationFrame(tick);
  }, [sendToWhisper]);

  const enable = useCallback(async () => {
    if (!supported || activeRef.current) return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, sampleRate: 16000 },
      });
      streamRef.current = stream;

      const audioCtx = new AudioContext({ sampleRate: 16000 });
      const source = audioCtx.createMediaStreamSource(stream);
      const analyser = audioCtx.createAnalyser();
      analyser.fftSize = 512;
      source.connect(analyser);
      audioCtxRef.current = audioCtx;
      analyserRef.current = analyser;

      activeRef.current = true;
      setPermissionDenied(false);
      startCycle();
    } catch (err: any) {
      if (err?.name === "NotAllowedError") setPermissionDenied(true);
    }
  }, [supported, startCycle]);

  const disable = useCallback(() => {
    activeRef.current = false;
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    try { recorderRef.current?.stop(); } catch {}
    streamRef.current?.getTracks().forEach((t) => t.stop());
    audioCtxRef.current?.close();
    streamRef.current = null;
    recorderRef.current = null;
    audioCtxRef.current = null;
    analyserRef.current = null;
    setAudioState("idle");
    onLevelRef.current?.(0);
  }, []);

  return {
    audioState,
    supported,
    permissionDenied,
    whisperAvailable,
    enable,
    disable,
  };
}

// ─── Wake word state machine ──────────────────────────────────────────────────

export interface AlwaysOnOptions {
  onCommand: (text: string) => void;
  lang?: string;
}

export function useAlwaysOn({ onCommand, lang }: AlwaysOnOptions) {
  const [mode, setMode] = useState<VoiceMode>("off");
  const [level, setLevel] = useState(0);
  const modeRef = useRef<VoiceMode>("off");
  const activationTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onCommandRef = useRef(onCommand);
  useEffect(() => { onCommandRef.current = onCommand; }, [onCommand]);

  const updateMode = useCallback((m: VoiceMode) => {
    modeRef.current = m;
    setMode(m);
  }, []);

  const handleTranscript = useCallback((text: string) => {
    const current = modeRef.current;
    if (current === "off" || current === "busy") return;

    const lower = text.toLowerCase().trim();
    if (current === "ambient") {
      const wakeMatch = lower.match(/(?:(?:hey|ok|hi|yo)\s+)?jarvis[,!.?]?\s*([\s\S]*)/);
      if (wakeMatch) {
        const command = wakeMatch[1].trim();
        if (command.length > 1) {
          updateMode("busy");
          if (activationTimerRef.current) clearTimeout(activationTimerRef.current);
          onCommandRef.current(command);
        } else {
          updateMode("activated");
          if (activationTimerRef.current) clearTimeout(activationTimerRef.current);
          activationTimerRef.current = setTimeout(() => {
            if (modeRef.current === "activated") updateMode("ambient");
          }, 6000);
        }
      }
    } else if (current === "activated") {
      if (activationTimerRef.current) clearTimeout(activationTimerRef.current);
      updateMode("busy");
      onCommandRef.current(text.trim());
    }
  }, [updateMode]);

  const stt = useWhisperSTT({
    onTranscript: handleTranscript,
    onLevel: setLevel,
    lang,
  });

  const enable = useCallback(async () => {
    updateMode("ambient");
    await stt.enable();
  }, [stt, updateMode]);

  const disable = useCallback(() => {
    stt.disable();
    updateMode("off");
    if (activationTimerRef.current) clearTimeout(activationTimerRef.current);
  }, [stt, updateMode]);

  const setBusy = useCallback(() => {
    updateMode("busy");
  }, [updateMode]);

  const resumeAmbient = useCallback(() => {
    updateMode("ambient");
  }, [updateMode]);

  return {
    mode,
    audioState: stt.audioState,
    level,
    supported: stt.supported,
    whisperAvailable: stt.whisperAvailable,
    permissionDenied: stt.permissionDenied,
    enable,
    disable,
    setBusy,
    resumeAmbient,
  };
}

// ─── TTS ─────────────────────────────────────────────────────────────────────

function stripMarkdown(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, "code block")
    .replace(/`[^`]+`/g, (m) => m.slice(1, -1))
    .replace(/#{1,6}\s+/g, "")
    .replace(/\*\*(.*?)\*\*/g, "$1")
    .replace(/\*(.*?)\*/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/^[-*+]\s+/gm, "")
    .replace(/^\d+\.\s+/gm, "")
    .replace(/\n{2,}/g, ". ")
    .replace(/\n/g, " ")
    .trim();
}

export function useTTS() {
  const [speaking, setSpeaking] = useState(false);
  const [supported, setSupported] = useState(false);
  // Default ON and persist preference
  const [enabled, setEnabled] = useState(() => {
    if (typeof window === "undefined") return true;
    const stored = localStorage.getItem("jarvis_tts_enabled");
    return stored === null ? true : stored === "true";
  });

  useEffect(() => {
    const ok = typeof window !== "undefined" && "speechSynthesis" in window;
    setSupported(ok);
    if (ok) {
      window.speechSynthesis.getVoices();
      window.speechSynthesis.addEventListener("voiceschanged", () => window.speechSynthesis.getVoices());
    }
  }, []);

  useEffect(() => {
    if (typeof window !== "undefined") {
      localStorage.setItem("jarvis_tts_enabled", String(enabled));
    }
  }, [enabled]);

  const speak = useCallback((text: string, onEnd?: () => void) => {
    if (!supported) { onEnd?.(); return; }
    window.speechSynthesis.cancel();
    if (!enabled) { onEnd?.(); return; }
    const clean = stripMarkdown(text);
    if (!clean.trim()) { onEnd?.(); return; }

    const u = new SpeechSynthesisUtterance(clean);
    u.rate = 1.05;
    u.pitch = 0.9;
    u.volume = 1;

    const voices = window.speechSynthesis.getVoices();
    const preferred =
      voices.find((v) => /david|mark|google uk english male|daniel/i.test(v.name)) ??
      voices.find((v) => v.lang.startsWith("en") && /male/i.test(v.name)) ??
      voices.find((v) => v.lang === "en-US");
    if (preferred) u.voice = preferred;

    u.onstart = () => setSpeaking(true);
    u.onend = () => { setSpeaking(false); onEnd?.(); };
    u.onerror = () => { setSpeaking(false); onEnd?.(); };
    window.speechSynthesis.speak(u);
  }, [enabled, supported]);

  const stop = useCallback(() => {
    if (supported) window.speechSynthesis.cancel();
    setSpeaking(false);
  }, [supported]);

  const toggle = useCallback(() => {
    setEnabled((v) => { if (v) window.speechSynthesis?.cancel(); return !v; });
  }, []);

  return { speaking, enabled, supported, speak, stop, toggle };
}
