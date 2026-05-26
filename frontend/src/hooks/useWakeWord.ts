"use client";

import { useEffect, useRef, useState, useCallback } from "react";

type Listener = (trigger: string, transcript: string) => void;

export interface WakeWordOptions {
  agentName: string;          // "JARVIS" / "FRIDAY" / "E.D.I.T.H." / "ULTRON" / custom
  enabled: boolean;
  onWake: Listener;
  extraTriggers?: string[];   // ["hi", "hey", "ok"]
  cooldownMs?: number;        // time between fires
}

const DEFAULT_TRIGGERS = ["hi", "hey", "ok", "hello"];

function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
}

function buildTriggerSet(agentName: string, extras: string[]): string[] {
  const triggers = new Set<string>();
  const a = normalize(agentName);
  if (a) {
    triggers.add(a);
    a.split(" ").forEach((p) => { if (p.length >= 2) triggers.add(p); });
  }
  extras.forEach((e) => { const n = normalize(e); if (n) triggers.add(n); });
  return Array.from(triggers).sort((x, y) => y.length - x.length);
}

function matchTrigger(text: string, triggers: string[]): string | null {
  const t = normalize(text);
  if (!t) return null;
  for (const trig of triggers) {
    if (t === trig) return trig;
    if (t.startsWith(trig + " ")) return trig;
    if (t.includes(" " + trig + " ")) return trig;
    if (trig.length >= 4 && t.includes(trig)) return trig;
  }
  return null;
}

export function useWakeWord({ agentName, enabled, onWake, extraTriggers, cooldownMs = 1500 }: WakeWordOptions) {
  const [listening, setListening] = useState(false);
  const [supported, setSupported] = useState(false);
  const activeRef = useRef(false);
  const recRef = useRef<any>(null);
  const lastFireRef = useRef(0);
  const triggersRef = useRef<string[]>([]);
  const onWakeRef = useRef(onWake);

  useEffect(() => { onWakeRef.current = onWake; }, [onWake]);
  useEffect(() => {
    triggersRef.current = buildTriggerSet(agentName, extraTriggers ?? DEFAULT_TRIGGERS);
  }, [agentName, extraTriggers]);

  useEffect(() => {
    const SR = typeof window !== "undefined"
      ? (window as any).SpeechRecognition ?? (window as any).webkitSpeechRecognition
      : null;
    setSupported(!!SR);
  }, []);

  const stop = useCallback(() => {
    activeRef.current = false;
    try { recRef.current?.abort(); } catch { /* noop */ }
    recRef.current = null;
    setListening(false);
  }, []);

  const start = useCallback(() => {
    if (!supported || activeRef.current) return;
    const SRClass = (window as any).SpeechRecognition ?? (window as any).webkitSpeechRecognition;
    if (!SRClass) return;

    activeRef.current = true;
    setListening(true);

    const launchInstance = () => {
      if (!activeRef.current) return;
      const rec = new SRClass();
      recRef.current = rec;
      rec.continuous = true;
      rec.interimResults = true;
      rec.maxAlternatives = 1;
      rec.lang = "";

      rec.onresult = (event: any) => {
        let chunk = "";
        for (let i = event.resultIndex; i < event.results.length; i++) {
          chunk += event.results[i][0].transcript;
        }
        const trig = matchTrigger(chunk, triggersRef.current);
        if (!trig) return;
        const now = Date.now();
        if (now - lastFireRef.current < cooldownMs) return;
        lastFireRef.current = now;
        onWakeRef.current(trig, chunk.trim());
      };

      rec.onerror = (e: any) => {
        if (e.error === "not-allowed" || e.error === "service-not-allowed") {
          stop();
          return;
        }
      };

      rec.onend = () => {
        if (activeRef.current) setTimeout(launchInstance, 250);
      };

      try { rec.start(); } catch { setTimeout(launchInstance, 500); }
    };

    launchInstance();
  }, [supported, cooldownMs, stop]);

  useEffect(() => {
    if (enabled && supported) {
      start();
      return () => stop();
    }
    stop();
  }, [enabled, supported, start, stop]);

  return { listening, supported };
}
