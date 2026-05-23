"use client";

import { useState, useRef, useEffect, useCallback, KeyboardEvent } from "react";
import { useSession } from "next-auth/react";
import {
  Send, Cpu, Zap, RotateCcw, Volume2, VolumeX,
  MicOff, Mic, Globe, AlertCircle,
} from "lucide-react";
import { cn } from "@/lib/utils";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useAlwaysOnSTT, useTTS, type VoiceMode } from "@/hooks/useVoice";
import { useLocalTasks } from "@/hooks/useLocalTasks";
import { useLocalKnowledge } from "@/hooks/useLocalKnowledge";

interface Message {
  id: string;
  role: "user" | "assistant";
  content: string;
  streaming?: boolean;
  toolsUsed?: string[];
}

interface HistoryEntry {
  role: "user" | "assistant";
  content: string | object[];
}

const SUGGESTIONS = [
  "What are my most urgent tasks?",
  "Add a task: review Q2 metrics by Friday",
  "What's today's date and time?",
  "Help me plan my week",
  "Search my knowledge base",
  "Draft a professional follow-up email",
];

const LANGUAGES = [
  { code: "", label: "Auto (browser locale)" },
  { code: "en-US", label: "English (US)" },
  { code: "en-GB", label: "English (UK)" },
  { code: "hi-IN", label: "हिन्दी (Hindi)" },
  { code: "es-ES", label: "Español" },
  { code: "fr-FR", label: "Français" },
  { code: "de-DE", label: "Deutsch" },
  { code: "pt-BR", label: "Português (BR)" },
  { code: "ja-JP", label: "日本語" },
  { code: "zh-CN", label: "普通话" },
  { code: "ar-SA", label: "العربية" },
  { code: "ko-KR", label: "한국어" },
];

export function AssistantClient({ userName }: { userName?: string }) {
  const { data: session } = useSession();
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const [lang, setLang] = useState("");
  const [showLang, setShowLang] = useState(false);

  const bottomRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const historyRef = useRef<HistoryEntry[]>([]);
  const memoryRef = useRef<Record<string, string>>({});
  const abortRef = useRef<AbortController | null>(null);
  const isStreamingRef = useRef(false);
  const sendMessageRef = useRef<(text?: string) => Promise<void>>(async () => {});

  const { allTasks, create: createTask } = useLocalTasks();
  const { docs } = useLocalKnowledge();
  const tts = useTTS();

  const handleCommand = useCallback((text: string) => {
    sendMessageRef.current(text);
  }, []);

  const stt = useAlwaysOnSTT({
    onCommand: handleCommand,
    lang: lang || undefined,
  });

  // Auto-enable on mount (requests mic permission)
  useEffect(() => {
    if (stt.supported) stt.enable();
    return () => stt.disable();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stt.supported]);

  // Sync streaming ref
  useEffect(() => { isStreamingRef.current = isStreaming; }, [isStreaming]);

  // Auto-scroll
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const sendMessage = useCallback(async (text?: string) => {
    const msg = (text ?? input).trim();
    if (!msg || isStreamingRef.current) return;

    setInput("");
    if (textareaRef.current) textareaRef.current.style.height = "auto";

    const userMsg: Message = { id: crypto.randomUUID(), role: "user", content: msg };
    const assistantId = crypto.randomUUID();
    setMessages((prev) => [...prev, userMsg, {
      id: assistantId, role: "assistant", content: "", streaming: true, toolsUsed: [],
    }]);
    setIsStreaming(true);
    // Silence the mic while processing
    stt.setBusy();

    abortRef.current = new AbortController();

    try {
      const readyDocs = docs
        .filter((d) => d.processing_status === "ready")
        .map((d) => ({ id: d.id, title: d.title, content: d.content, chunk_count: d.chunk_count }));

      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: msg,
          history: historyRef.current,
          memory: memoryRef.current,
          userName: userName ?? session?.user?.name?.split(" ")[0],
          tasks: allTasks,
          docs: readyDocs,
        }),
        signal: abortRef.current.signal,
      });

      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let fullText = "";
      const toolsUsed: string[] = [];
      let eventType = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (line.startsWith("event: ")) { eventType = line.slice(7).trim(); continue; }
          if (line.startsWith("data: ")) {
            try {
              const parsed = JSON.parse(line.slice(6));
              if (eventType === "text" && parsed.text !== undefined) {
                fullText += parsed.text;
                setMessages((prev) => prev.map((m) =>
                  m.id === assistantId ? { ...m, content: fullText, toolsUsed } : m
                ));
              } else if (eventType === "tool" && parsed.name) {
                toolsUsed.push(parsed.name);
                setMessages((prev) => prev.map((m) =>
                  m.id === assistantId ? { ...m, toolsUsed: [...toolsUsed] } : m
                ));
              } else if (eventType === "done") {
                if (parsed.memory) memoryRef.current = parsed.memory;
                historyRef.current = [
                  ...historyRef.current,
                  { role: "user", content: msg },
                  { role: "assistant", content: fullText },
                ];
                if (parsed.sideEffects) {
                  for (const fx of parsed.sideEffects) {
                    if (fx.type === "task_create" && fx.data?.title) {
                      createTask({
                        title: fx.data.title, priority: fx.data.priority ?? "medium",
                        status: "todo", assignee: fx.data.assignee,
                        due_date: fx.data.due_date, description: fx.data.description,
                      });
                    }
                    if (fx.type === "note_create" && fx.data?.title) {
                      const notes = JSON.parse(localStorage.getItem("jarvis_notes_v1") ?? "[]");
                      notes.unshift({
                        id: crypto.randomUUID(), title: fx.data.title, content: fx.data.content,
                        pinned: false, created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
                      });
                      localStorage.setItem("jarvis_notes_v1", JSON.stringify(notes));
                    }
                  }
                }
                // Speak, then resume ambient listening
                tts.speak(fullText, () => stt.resumeAmbient());
                if (!tts.enabled) stt.resumeAmbient();
              }
            } catch { /* non-JSON */ }
            eventType = "";
          }
        }
      }

      setMessages((prev) => prev.map((m) =>
        m.id === assistantId ? { ...m, streaming: false } : m
      ));
    } catch (err: any) {
      if (err?.name === "AbortError") { stt.resumeAmbient(); return; }
      setMessages((prev) => prev.map((m) =>
        m.id === assistantId
          ? { ...m, content: "I encountered an error. Please try again.", streaming: false }
          : m
      ));
      stt.resumeAmbient();
    } finally {
      setIsStreaming(false);
    }
  }, [input, session, userName, allTasks, docs, createTask, tts, stt]);

  // Always keep ref current
  useEffect(() => { sendMessageRef.current = sendMessage; }, [sendMessage]);

  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendMessage(); }
  }

  function handleClear() {
    if (isStreaming) abortRef.current?.abort();
    tts.stop();
    setMessages([]);
    historyRef.current = [];
    memoryRef.current = {};
    setIsStreaming(false);
    stt.resumeAmbient();
  }

  return (
    <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
      {/* Always-on voice status bar */}
      <VoiceStatusBar
        mode={stt.mode}
        interimText={stt.interimText}
        permissionDenied={stt.permissionDenied}
        ttsEnabled={tts.enabled}
        ttsSpeaking={tts.speaking}
        lang={lang}
        showLang={showLang}
        onToggleLang={() => setShowLang((v) => !v)}
        onSelectLang={(code) => { setLang(code); setShowLang(false); }}
        onToggleTTS={tts.toggle}
        onToggleMic={() => stt.mode === "off" ? stt.enable() : stt.disable()}
      />

      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-4 sm:px-8 py-6 space-y-5">
        {messages.length === 0 ? (
          <EmptyState userName={userName} onSuggest={sendMessage} />
        ) : (
          messages.map((msg) => (
            <MessageBubble key={msg.id} message={msg} session={session} />
          ))
        )}
        <div ref={bottomRef} />
      </div>

      {/* Text input */}
      <div className="flex-none px-4 sm:px-8 py-4 border-t border-border-default bg-background-base">
        <div className="flex items-end gap-3 bg-background-surface border border-border-default rounded-card px-4 py-3 focus-within:border-border-hover transition-colors duration-150">
          <textarea
            ref={textareaRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={stt.mode !== "off" ? 'Say "Jarvis…" or type here' : "Message JARVIS…"}
            rows={1}
            disabled={isStreaming}
            className="flex-1 bg-transparent text-text-primary placeholder:text-text-muted text-sm resize-none outline-none max-h-32 leading-relaxed disabled:opacity-60"
            style={{ height: "auto" }}
            onInput={(e) => {
              const t = e.currentTarget;
              t.style.height = "auto";
              t.style.height = `${Math.min(t.scrollHeight, 128)}px`;
            }}
          />
          {messages.length > 0 && (
            <button onClick={handleClear} title="Clear conversation"
              className="flex-none p-1.5 rounded-input text-text-muted hover:text-text-secondary transition-colors">
              <RotateCcw size={13} />
            </button>
          )}
          <button
            onClick={() => sendMessage()}
            disabled={!input.trim() || isStreaming}
            className={cn(
              "flex-none p-1.5 rounded-input transition-colors",
              input.trim() && !isStreaming ? "text-accent-blue hover:bg-accent-blue/10" : "text-text-muted cursor-not-allowed"
            )}
            title="Send (Enter)"
          >
            <Send size={15} />
          </button>
        </div>
        <p className="text-text-muted text-[11px] mt-2 text-center">
          {stt.mode !== "off"
            ? 'Say "Jarvis [your request]" · Enter to type · mic always on'
            : "Enter to send · Shift+Enter for new line"}
        </p>
      </div>
    </div>
  );
}

// ─── Voice Status Bar ────────────────────────────────────────────────────────

function VoiceStatusBar({
  mode, interimText, permissionDenied, ttsEnabled, ttsSpeaking,
  lang, showLang, onToggleLang, onSelectLang, onToggleTTS, onToggleMic,
}: {
  mode: VoiceMode;
  interimText: string;
  permissionDenied: boolean;
  ttsEnabled: boolean;
  ttsSpeaking: boolean;
  lang: string;
  showLang: boolean;
  onToggleLang: () => void;
  onSelectLang: (code: string) => void;
  onToggleTTS: () => void;
  onToggleMic: () => void;
}) {
  const modeConfig = {
    off: { label: "Voice off", color: "text-text-muted", bg: "bg-background-surface", dot: "bg-text-muted" },
    ambient: { label: 'Listening for "Jarvis…"', color: "text-text-secondary", bg: "bg-background-surface", dot: "bg-success" },
    activated: { label: "Go ahead…", color: "text-accent-blue", bg: "bg-accent-blue/5 border-accent-blue/20", dot: "bg-accent-blue" },
    busy: { label: ttsSpeaking ? "Speaking…" : "Processing…", color: "text-accent-violet", bg: "bg-accent-violet/5 border-accent-violet/20", dot: "bg-accent-violet" },
  } as const;

  const cfg = modeConfig[mode];

  return (
    <div className={cn(
      "flex-none flex items-center gap-3 px-4 sm:px-8 py-2.5 border-b border-border-default transition-all duration-300",
      mode !== "off" ? cfg.bg : ""
    )}>
      {/* Status dot + label */}
      <div className="flex items-center gap-2 flex-1 min-w-0">
        <span className={cn(
          "w-1.5 h-1.5 rounded-full flex-none",
          cfg.dot,
          (mode === "ambient" || mode === "activated") && "animate-pulse"
        )} />
        <span className={cn("text-xs font-mono truncate", cfg.color)}>
          {permissionDenied ? "Mic permission denied — check browser settings" : cfg.label}
        </span>

        {/* Live transcription */}
        {interimText && mode !== "off" && mode !== "busy" && (
          <>
            <span className="text-text-muted text-xs mx-1">·</span>
            <span className="text-text-primary text-xs italic truncate flex-1 min-w-0">
              {interimText}
            </span>
          </>
        )}

        {/* Waveform animation when activated */}
        {mode === "activated" && !interimText && (
          <div className="flex gap-0.5 items-center ml-2">
            {[0, 1, 2, 3, 4].map((i) => (
              <span
                key={i}
                className="w-0.5 rounded-full bg-accent-blue animate-bounce"
                style={{ height: `${6 + (i % 3) * 4}px`, animationDelay: `${i * 70}ms` }}
              />
            ))}
          </div>
        )}

        {permissionDenied && (
          <AlertCircle size={12} className="text-accent-red flex-none ml-1" />
        )}
      </div>

      {/* Controls */}
      <div className="flex items-center gap-1 flex-none relative">
        {/* Language picker */}
        <button onClick={onToggleLang}
          title={`Voice language: ${LANGUAGES.find((l) => l.code === lang)?.label ?? "Auto"}`}
          className={cn("p-1.5 rounded-input text-xs transition-colors",
            showLang ? "text-accent-blue" : "text-text-muted hover:text-text-secondary"
          )}>
          <Globe size={12} />
        </button>
        {showLang && (
          <div className="absolute top-8 right-0 bg-background-elevated border border-border-default rounded-card shadow-xl z-50 min-w-[200px] py-1 max-h-64 overflow-y-auto">
            {LANGUAGES.map((l) => (
              <button key={l.code} onClick={() => onSelectLang(l.code)}
                className={cn(
                  "w-full text-left px-3 py-1.5 text-xs transition-colors",
                  lang === l.code ? "text-accent-blue bg-accent-blue/10" : "text-text-secondary hover:text-text-primary hover:bg-background-surface"
                )}>
                {l.label}
              </button>
            ))}
          </div>
        )}

        {/* TTS toggle */}
        <button onClick={onToggleTTS}
          title={ttsEnabled ? "Mute JARVIS voice" : "Enable JARVIS voice"}
          className={cn("p-1.5 rounded-input transition-colors",
            ttsEnabled ? ttsSpeaking ? "text-accent-violet animate-pulse" : "text-accent-violet" : "text-text-muted hover:text-text-secondary"
          )}>
          {ttsEnabled ? <Volume2 size={13} /> : <VolumeX size={13} />}
        </button>

        {/* Mic on/off */}
        <button onClick={onToggleMic}
          title={mode === "off" ? "Enable always-on listening" : "Disable listening"}
          className={cn("p-1.5 rounded-input transition-colors",
            mode === "off" ? "text-text-muted hover:text-accent-blue" : "text-accent-blue"
          )}>
          {mode === "off" ? <MicOff size={13} /> : <Mic size={13} />}
        </button>
      </div>
    </div>
  );
}

// ─── Sub-components ──────────────────────────────────────────────────────────

function EmptyState({ userName, onSuggest }: { userName?: string; onSuggest: (text: string) => void }) {
  return (
    <div className="flex flex-col items-center justify-center h-full min-h-[50vh] gap-8 animate-fade-in">
      <div className="text-center">
        <div className="w-14 h-14 rounded-full bg-accent-blue/10 border border-accent-blue/20 flex items-center justify-center mx-auto mb-4">
          <Cpu size={22} className="text-accent-blue" />
        </div>
        <p className="text-text-primary font-semibold text-base mb-1">
          {userName ? `Good to see you, ${userName}.` : "JARVIS is online."}
        </p>
        <p className="text-text-secondary text-sm">Say "Jarvis" or type below.</p>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 w-full max-w-lg">
        {SUGGESTIONS.map((s) => (
          <button key={s} onClick={() => onSuggest(s)}
            className="text-left px-4 py-3 rounded-card bg-background-surface border border-border-default hover:border-accent-blue/30 hover:bg-accent-blue/5 transition-all text-sm text-text-secondary hover:text-text-primary">
            {s}
          </button>
        ))}
      </div>
    </div>
  );
}

function MessageBubble({ message, session }: { message: Message; session: any }) {
  const isUser = message.role === "user";
  return (
    <div className={cn("flex items-start gap-3 animate-slide-in", isUser && "flex-row-reverse")}>
      {isUser ? <UserAvatar session={session} /> : <AgentAvatar />}
      <div className={cn("max-w-[85%] sm:max-w-[75%]", isUser && "items-end flex flex-col")}>
        {message.toolsUsed && message.toolsUsed.length > 0 && (
          <div className="flex flex-wrap gap-1.5 mb-2">
            {message.toolsUsed.map((tool, i) => (
              <span key={i} className="inline-flex items-center gap-1 text-[11px] font-mono px-2 py-0.5 rounded-badge bg-accent-violet/10 border border-accent-violet/20 text-accent-violet">
                <Zap size={9} /> {tool}
              </span>
            ))}
          </div>
        )}
        <div className={cn(
          "rounded-card px-4 py-3 text-sm leading-relaxed",
          isUser ? "bg-accent-blue/10 border border-accent-blue/20 text-text-primary"
                 : "bg-background-surface border border-border-default text-text-primary"
        )}>
          {isUser ? (
            <span className="whitespace-pre-wrap">{message.content}</span>
          ) : (
            <>
              {message.content ? (
                <div className="prose-jarvis">
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>{message.content}</ReactMarkdown>
                </div>
              ) : message.streaming ? <ThinkingDots /> : null}
              {message.streaming && message.content && (
                <span className="inline-block w-0.5 h-3.5 bg-accent-blue ml-0.5 animate-pulse align-middle" />
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function AgentAvatar() {
  return (
    <div className="w-7 h-7 rounded-full bg-accent-blue/20 border border-accent-blue/30 flex-none flex items-center justify-center">
      <Cpu size={13} className="text-accent-blue" />
    </div>
  );
}

function UserAvatar({ session }: { session: any }) {
  if (session?.user?.image)
    return <img src={session.user.image} alt="" className="w-7 h-7 rounded-full flex-none object-cover" />;
  return (
    <div className="w-7 h-7 rounded-full bg-accent-violet/20 border border-accent-violet/30 flex-none flex items-center justify-center text-xs text-accent-violet font-medium">
      {session?.user?.name?.[0]?.toUpperCase() ?? "?"}
    </div>
  );
}

function ThinkingDots() {
  return (
    <div className="flex gap-1 py-0.5">
      {[0, 1, 2].map((i) => (
        <span key={i} className="w-1.5 h-1.5 rounded-full bg-text-muted animate-bounce"
          style={{ animationDelay: `${i * 150}ms` }} />
      ))}
    </div>
  );
}
