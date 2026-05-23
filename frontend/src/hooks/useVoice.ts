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

export type VoiceMode = "off" | "ambient" | "activated" | "busy";

// ─── Always-On STT with wake-word ────────────────────────────────────────────

export interface AlwaysOnSTTOptions {
  onCommand: (text: string) => void;
  onInterim?: (text: string) => void;
  lang?: string;
}

export function useAlwaysOnSTT({ onCommand, onInterim, lang }: AlwaysOnSTTOptions) {
  const [mode, setMode] = useState<VoiceMode>("off");
  const [interimText, setInterimText] = useState("");
  const [supported, setSupported] = useState(false);
  const [permissionDenied, setPermissionDenied] = useState(false);

  const modeRef = useRef<VoiceMode>("off");
  const recRef = useRef<ISpeechRecognition | null>(null);
  const restartTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const activationTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onCommandRef = useRef(onCommand);
  const onInterimRef = useRef(onInterim);
  const langRef = useRef(lang);

  useEffect(() => { onCommandRef.current = onCommand; }, [onCommand]);
  useEffect(() => { onInterimRef.current = onInterim; }, [onInterim]);
  useEffect(() => { langRef.current = lang; }, [lang]);

  const updateMode = useCallback((m: VoiceMode) => {
    modeRef.current = m;
    setMode(m);
  }, []);

  useEffect(() => {
    setSupported(
      typeof window !== "undefined" &&
      ("SpeechRecognition" in window || "webkitSpeechRecognition" in window)
    );
  }, []);

  const buildAndStart = useCallback(() => {
    if (typeof window === "undefined") return;
    const Ctor = window.SpeechRecognition ?? window.webkitSpeechRecognition;
    if (!Ctor) return;

    const rec = new Ctor();
    rec.continuous = true;
    rec.interimResults = true;
    rec.maxAlternatives = 1;
    rec.lang = langRef.current || (typeof navigator !== "undefined" ? navigator.language : "en-US");

    rec.onresult = (e: any) => {
      let interim = "";
      let final = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        if (e.results[i].isFinal) final += e.results[i][0].transcript;
        else interim += e.results[i][0].transcript;
      }

      const currentMode = modeRef.current;
      if (currentMode === "off" || currentMode === "busy") return;

      if (interim) {
        setInterimText(interim);
        onInterimRef.current?.(interim);
      }

      if (final.trim()) {
        setInterimText("");
        const lower = final.toLowerCase().trim();

        if (currentMode === "ambient") {
          // Look for wake word: "jarvis", "hey jarvis", "ok jarvis"
          const wakeMatch = lower.match(/(?:(?:hey|ok|hi)\s+)?jarvis[,!.?]?\s*([\s\S]*)/);
          if (wakeMatch) {
            const command = wakeMatch[1].trim();
            if (command.length > 1) {
              // Wake word + command in same utterance
              updateMode("busy");
              if (activationTimerRef.current) clearTimeout(activationTimerRef.current);
              onCommandRef.current(command);
            } else {
              // Just "Jarvis" — enter activated mode, wait for command
              updateMode("activated");
              if (activationTimerRef.current) clearTimeout(activationTimerRef.current);
              activationTimerRef.current = setTimeout(() => {
                if (modeRef.current === "activated") {
                  updateMode("ambient");
                }
              }, 6000);
            }
          }
        } else if (currentMode === "activated") {
          // Any speech after activation = the command
          if (activationTimerRef.current) clearTimeout(activationTimerRef.current);
          updateMode("busy");
          onCommandRef.current(final.trim());
        }
      }
    };

    rec.onerror = (e: any) => {
      if (e.error === "not-allowed" || e.error === "service-not-allowed") {
        setPermissionDenied(true);
        updateMode("off");
        return;
      }
      // no-speech, aborted, network — will restart via onend
    };

    rec.onend = () => {
      const current = modeRef.current;
      if (current === "off") return;
      // Auto-restart unless busy (busy = paused intentionally)
      if (current !== "busy") {
        restartTimerRef.current = setTimeout(() => {
          if (modeRef.current !== "off" && modeRef.current !== "busy") {
            buildAndStart();
          }
        }, 200);
      }
    };

    recRef.current = rec;
    try { rec.start(); } catch {}
  }, [updateMode]);

  const enable = useCallback(() => {
    if (!supported) return;
    if (restartTimerRef.current) clearTimeout(restartTimerRef.current);
    updateMode("ambient");
    buildAndStart();
  }, [supported, buildAndStart, updateMode]);

  const disable = useCallback(() => {
    if (restartTimerRef.current) clearTimeout(restartTimerRef.current);
    if (activationTimerRef.current) clearTimeout(activationTimerRef.current);
    updateMode("off");
    setInterimText("");
    try { recRef.current?.abort(); } catch {}
    recRef.current = null;
  }, [updateMode]);

  const mute = useCallback(() => {
    // Pause mic while JARVIS speaks (keeps mode as busy, stops recognition)
    try { recRef.current?.abort(); } catch {}
    recRef.current = null;
  }, []);

  const resumeAmbient = useCallback(() => {
    // Called after JARVIS finishes speaking
    updateMode("ambient");
    buildAndStart();
  }, [updateMode, buildAndStart]);

  const setBusy = useCallback(() => {
    updateMode("busy");
    mute();
  }, [updateMode, mute]);

  return {
    mode,
    interimText,
    supported,
    permissionDenied,
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
    .replace(/^>{1,}\s+/gm, "")
    .replace(/\n{2,}/g, ". ")
    .replace(/\n/g, " ")
    .trim();
}

export function useTTS() {
  const [speaking, setSpeaking] = useState(false);
  const [enabled, setEnabled] = useState(false);
  const [supported, setSupported] = useState(false);

  useEffect(() => {
    const ok = typeof window !== "undefined" && "speechSynthesis" in window;
    setSupported(ok);
    if (ok) {
      window.speechSynthesis.getVoices();
      window.speechSynthesis.addEventListener("voiceschanged", () => window.speechSynthesis.getVoices());
    }
  }, []);

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
