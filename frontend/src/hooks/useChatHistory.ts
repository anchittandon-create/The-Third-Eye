"use client";

import { useState, useEffect, useCallback } from "react";

export interface ChatSession {
  id: string;
  title: string;
  messages: Array<{
    id: string;
    role: "user" | "assistant";
    content: string;
    toolsUsed?: string[];
    attachments?: string[];
    timestamp: string;
  }>;
  agentId: string;
  created_at: string;
  updated_at: string;
}

const LS_KEY = "thirdeye_chat_history";
const MAX_SESSIONS = 50;

function load(): ChatSession[] {
  if (typeof window === "undefined") return [];
  try { return JSON.parse(localStorage.getItem(LS_KEY) ?? "[]"); } catch { return []; }
}

function save(sessions: ChatSession[]) {
  localStorage.setItem(LS_KEY, JSON.stringify(sessions.slice(0, MAX_SESSIONS)));
}

function generateTitle(firstMessage: string): string {
  return firstMessage.slice(0, 60) + (firstMessage.length > 60 ? "…" : "");
}

export function useChatHistory() {
  const [sessions, setSessions] = useState<ChatSession[]>(() => load());
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);

  useEffect(() => { save(sessions); }, [sessions]);

  const activeSession = sessions.find((s) => s.id === activeSessionId) ?? null;

  const createSession = useCallback((agentId: string): ChatSession => {
    const session: ChatSession = {
      id: crypto.randomUUID(),
      title: "New conversation",
      messages: [],
      agentId,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    setSessions((prev) => [session, ...prev]);
    setActiveSessionId(session.id);
    return session;
  }, []);

  const addMessage = useCallback((sessionId: string, message: ChatSession["messages"][0]) => {
    setSessions((prev) => prev.map((s) => {
      if (s.id !== sessionId) return s;
      const msgs = [...s.messages, message];
      const title = s.messages.length === 0 && message.role === "user"
        ? generateTitle(message.content)
        : s.title;
      return { ...s, messages: msgs, title, updated_at: new Date().toISOString() };
    }));
  }, []);

  const updateLastAssistantMessage = useCallback((sessionId: string, content: string, toolsUsed?: string[]) => {
    setSessions((prev) => prev.map((s) => {
      if (s.id !== sessionId) return s;
      const msgs = [...s.messages];
      const lastIdx = msgs.length - 1;
      if (lastIdx >= 0 && msgs[lastIdx].role === "assistant") {
        msgs[lastIdx] = { ...msgs[lastIdx], content, ...(toolsUsed ? { toolsUsed } : {}) };
      }
      return { ...s, messages: msgs, updated_at: new Date().toISOString() };
    }));
  }, []);

  const deleteSession = useCallback((id: string) => {
    setSessions((prev) => prev.filter((s) => s.id !== id));
    if (activeSessionId === id) setActiveSessionId(null);
  }, [activeSessionId]);

  const clearAll = useCallback(() => {
    setSessions([]);
    setActiveSessionId(null);
  }, []);

  return {
    sessions,
    activeSession,
    activeSessionId,
    setActiveSessionId,
    createSession,
    addMessage,
    updateLastAssistantMessage,
    deleteSession,
    clearAll,
  };
}
