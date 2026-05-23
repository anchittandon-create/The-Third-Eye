"use client";

import { useState, useRef, useCallback, useEffect } from "react";

interface ISpeechRecognition extends EventTarget {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  maxAlternatives: number;
  onresult: ((e: any) => void) | null;
  onerror: ((e: any) => void) | null;
  onend: (() => void) | null;
  onstart: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}

declare global {
  interface Window {
    SpeechRecognition: new () => ISpeechRecognition;
    webkitSpeechRecognition: new () => ISpeechRecognition;
  }
}

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
    .replace(/^>{1,}\s+/gm, "")
    .replace(/\n{2,}/g, ". ")
    .replace(/\n/g, " ")
    .trim();
}

// ─── Continuous STT ──────────────────────────────────────────────────────────

export interface ContinuousSTTOptions {
  onFinal: (text: string) => void;
  onInterim?: (text: string) => void;
  lang?: string;
}

export function useContinuousSTT({ onFinal, onInterim, lang }: ContinuousSTTOptions) {
  const [listening, setListening] = useState(false);
  const [interimText, setInterimText] = useState("");
  const [supported, setSupported] = useState(false);

  const activeRef = useRef(false);
  const pausedRef = useRef(false); // paused while TTS speaks
  const recRef = useRef<ISpeechRecognition | null>(null);
  const onFinalRef = useRef(onFinal);
  const onInterimRef = useRef(onInterim);
  const restartTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => { onFinalRef.current = onFinal; }, [onFinal]);
  useEffect(() => { onInterimRef.current = onInterim; }, [onInterim]);

  useEffect(() => {
    setSupported(
      typeof window !== "undefined" &&
      ("SpeechRecognition" in window || "webkitSpeechRecognition" in window)
    );
  }, []);

  const buildRec = useCallback((): ISpeechRecognition | null => {
    if (typeof window === "undefined") return null;
    const Ctor = window.SpeechRecognition ?? window.webkitSpeechRecognition;
    if (!Ctor) return null;

    const rec = new Ctor();
    rec.continuous = true;
    rec.interimResults = true;
    rec.maxAlternatives = 1;
    rec.lang = lang ?? (typeof navigator !== "undefined" ? navigator.language : "en-US");

    rec.onresult = (e: any) => {
      let interim = "";
      let final = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) final += r[0].transcript;
        else interim += r[0].transcript;
      }
      if (interim) {
        setInterimText(interim);
        onInterimRef.current?.(interim);
      }
      if (final.trim()) {
        setInterimText("");
        onFinalRef.current(final.trim());
      }
    };

    rec.onerror = (e: any) => {
      // no-speech / aborted are expected; others are real errors
      if (e.error !== "no-speech" && e.error !== "aborted") {
        activeRef.current = false;
        setListening(false);
        setInterimText("");
      }
    };

    rec.onend = () => {
      // Auto-restart if still active and not paused
      if (activeRef.current && !pausedRef.current) {
        restartTimerRef.current = setTimeout(() => {
          if (!activeRef.current || pausedRef.current) return;
          const next = buildRec();
          if (!next) return;
          recRef.current = next;
          try { next.start(); } catch {}
        }, 150);
      } else if (!activeRef.current) {
        setInterimText("");
      }
    };

    return rec;
  }, [lang]);

  const start = useCallback(() => {
    if (!supported || activeRef.current) return;
    activeRef.current = true;
    pausedRef.current = false;
    setListening(true);
    setInterimText("");
    const rec = buildRec();
    if (!rec) return;
    recRef.current = rec;
    try { rec.start(); } catch {}
  }, [supported, buildRec]);

  const stop = useCallback(() => {
    if (restartTimerRef.current) clearTimeout(restartTimerRef.current);
    activeRef.current = false;
    pausedRef.current = false;
    setListening(false);
    setInterimText("");
    try { recRef.current?.abort(); } catch {}
    recRef.current = null;
  }, []);

  // Pause/resume while TTS speaks (prevents feedback loop)
  const pause = useCallback(() => {
    if (!activeRef.current) return;
    pausedRef.current = true;
    try { recRef.current?.abort(); } catch {}
  }, []);

  const resume = useCallback(() => {
    if (!activeRef.current) return;
    pausedRef.current = false;
    const rec = buildRec();
    if (!rec) return;
    recRef.current = rec;
    try { rec.start(); } catch {}
  }, [buildRec]);

  return { listening, interimText, supported, start, stop, pause, resume };
}

// ─── TTS ─────────────────────────────────────────────────────────────────────

export function useTTS() {
  const [speaking, setSpeaking] = useState(false);
  const [enabled, setEnabled] = useState(false);
  const [supported, setSupported] = useState(false);
  const onEndRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    const ok = typeof window !== "undefined" && "speechSynthesis" in window;
    setSupported(ok);
    if (ok) {
      // Preload voices
      window.speechSynthesis.getVoices();
      window.speechSynthesis.addEventListener("voiceschanged", () => {
        window.speechSynthesis.getVoices();
      });
    }
  }, []);

  const speak = useCallback((text: string, onEnd?: () => void) => {
    if (!enabled || !supported) { onEnd?.(); return; }
    window.speechSynthesis.cancel();
    const clean = stripMarkdown(text);
    if (!clean.trim()) { onEnd?.(); return; }

    const u = new SpeechSynthesisUtterance(clean);
    u.rate = 1.05;
    u.pitch = 0.9;
    u.volume = 1;

    const voices = window.speechSynthesis.getVoices();
    // Prefer deep/authoritative voices for JARVIS feel; fallback to en-US Male
    const preferred = voices.find((v) =>
      /david|mark|google uk english male|daniel|alex|fred/i.test(v.name)
    ) ?? voices.find((v) => v.lang.startsWith("en") && v.name.toLowerCase().includes("male"))
      ?? voices.find((v) => v.lang === "en-US");
    if (preferred) u.voice = preferred;

    onEndRef.current = onEnd ?? null;
    u.onstart = () => setSpeaking(true);
    u.onend = () => { setSpeaking(false); onEndRef.current?.(); onEndRef.current = null; };
    u.onerror = () => { setSpeaking(false); onEndRef.current?.(); onEndRef.current = null; };

    window.speechSynthesis.speak(u);
  }, [enabled, supported]);

  const stop = useCallback(() => {
    if (supported) window.speechSynthesis.cancel();
    setSpeaking(false);
    onEndRef.current?.();
    onEndRef.current = null;
  }, [supported]);

  const toggle = useCallback(() => {
    setEnabled((v) => {
      if (v) window.speechSynthesis?.cancel();
      return !v;
    });
  }, []);

  return { speaking, enabled, supported, speak, stop, toggle };
}
