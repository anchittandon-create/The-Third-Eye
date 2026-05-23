"use client";

import { useState, useEffect, useCallback } from "react";

export interface LocalNote {
  id: string;
  title: string;
  content: string;
  pinned?: boolean;
  created_at: string;
  updated_at: string;
}

const KEY = "jarvis_notes_v1";

function load(): LocalNote[] {
  if (typeof window === "undefined") return [];
  try { return JSON.parse(localStorage.getItem(KEY) ?? "[]"); }
  catch { return []; }
}

function persist(notes: LocalNote[]) { localStorage.setItem(KEY, JSON.stringify(notes)); }

export function useLocalNotes() {
  const [notes, setNotes] = useState<LocalNote[]>([]);
  const [ready, setReady] = useState(false);

  useEffect(() => { setNotes(load()); setReady(true); }, []);

  const create = useCallback((title: string, content = "") => {
    const n: LocalNote = { id: crypto.randomUUID(), title, content, created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
    setNotes((prev) => { const next = [n, ...prev]; persist(next); return next; });
    return n;
  }, []);

  const update = useCallback((id: string, data: Partial<LocalNote>) => {
    setNotes((prev) => {
      const next = prev.map((n) => n.id === id ? { ...n, ...data, updated_at: new Date().toISOString() } : n);
      persist(next); return next;
    });
  }, []);

  const remove = useCallback((id: string) => {
    setNotes((prev) => { const next = prev.filter((n) => n.id !== id); persist(next); return next; });
  }, []);

  return { notes, ready, create, update, remove };
}
