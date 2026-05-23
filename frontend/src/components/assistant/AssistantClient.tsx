"use client";

import { useState, useRef, useEffect, useCallback, KeyboardEvent } from "react";
import { useSession } from "next-auth/react";
import { Send, Cpu, Zap, RotateCcw, Volume2, VolumeX, Mic, MicOff, Globe, AlertCircle, Info } from "lucide-react";
import { cn } from "@/lib/utils";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useAlwaysOn, useTTS, type VoiceMode, type AudioState } from "@/hooks/useVoice";
import { useLocalTasks } from "@/hooks/useLocalTasks";
import { useLocalKnowledge } from "@/hooks/useLocalKnowledge";

interface Message {
  id: string;
  role: "user" | "assistant";
  content: string;
  streaming?: boolean;
  toolsUsed?: string[];
  error?: string;
}

interface HistoryEntry {
  role: "user" | "assistant";
  content: string | object[];
}

const SUGGESTIONS = [
  'Say "Jarvis, what are my urgent tasks?"',
  'Say "Jarvis, add a task: review Q2 by Friday"',
  "What's today's date and time?",
  "Help me plan my week",
  "Search my knowledge base",
  "Draft a professional follow-up email",
];

const LANGUAGES = [
  { code: "", label: "Auto" },
  { code: "en-US", label: "English (US)" },
  { code: "en-GB", label: "English (UK)" },
  { code: "hi-IN", label: "हिन्दी" },
  { code: "es-ES", label: "Español" },
  { code: "fr-FR", label: "Français" },
  { code: "de-DE", label: "Deutsch" },
  { code: "pt-BR", label: "Português" },
  { code: "ja-JP", label: "日本語" },
  { code: "zh-CN", label: "中文" },
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
  const [apiError, setApiError] = useState<string | null>(null);

  const bottomRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const historyRef = useRef<HistoryEntry[]>([]);
  const memoryRef = useRef<Record<string, string>>({});
  const abortRef = useRef<AbortController | null>(null);
  const isStreamingRef = useRef(false);
  const sendRef = useRef<(text?: string) => Promise<void>>(async () => {});

  const { allTasks, create: createTask } = useLocalTasks();
  const { docs } = useLocalKnowledge();
  const tts = useTTS();

  const voice = useAlwaysOn({
    onCommand: useCallback((text: string) => { sendRef.current(text); }, []),
    lang: lang || undefined,
  });

  // Auto-start on mount
  useEffect(() => {
    if (voice.supported) voice.enable();
    return () => voice.disable();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [voice.supported]);

  useEffect(() => { isStreamingRef.current = isStreaming; }, [isStreaming]);
  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: "smooth" }); }, [messages]);

  const sendMessage = useCallback(async (text?: string) => {
    const msg = (text ?? input).trim();
    if (!msg || isStreamingRef.current) return;

    setInput("");
    setApiError(null);
    if (textareaRef.current) textareaRef.current.style.height = "auto";

    const userMsg: Message = { id: crypto.randomUUID(), role: "user", content: msg };
    const assistantId = crypto.randomUUID();
    setMessages((prev) => [...prev, userMsg, {
      id: assistantId, role: "assistant", content: "", streaming: true, toolsUsed: [],
    }]);
    setIsStreaming(true);
    voice.setBusy();

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

      if (!res.ok) {
        let errMsg = `HTTP ${res.status}`;
        try { const j = await res.json(); errMsg = j.error ?? errMsg; } catch {}
        throw new Error(errMsg);
      }
      if (!res.body) throw new Error("No response body");

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
              } else if (eventType === "error") {
                const errMsg = parsed.message ?? "Unknown error from JARVIS";
                setMessages((prev) => prev.map((m) =>
                  m.id === assistantId ? { ...m, content: "", error: errMsg, streaming: false } : m
                ));
                setApiError(errMsg);
                voice.resumeAmbient();
                return;
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
                      createTask({ title: fx.data.title, priority: fx.data.priority ?? "medium", status: "todo", assignee: fx.data.assignee, due_date: fx.data.due_date, description: fx.data.description });
                    }
                    if (fx.type === "note_create" && fx.data?.title) {
                      const notes = JSON.parse(localStorage.getItem("jarvis_notes_v1") ?? "[]");
                      notes.unshift({ id: crypto.randomUUID(), title: fx.data.title, content: fx.data.content, pinned: false, created_at: new Date().toISOString(), updated_at: new Date().toISOString() });
                      localStorage.setItem("jarvis_notes_v1", JSON.stringify(notes));
                    }
                  }
                }
                tts.speak(fullText, () => voice.resumeAmbient());
                if (!tts.enabled) voice.resumeAmbient();
              }
            } catch { /* non-JSON line */ }
            eventType = "";
          }
        }
      }

      setMessages((prev) => prev.map((m) =>
        m.id === assistantId ? { ...m, streaming: false } : m
      ));
    } catch (err: any) {
      if (err?.name === "AbortError") { voice.resumeAmbient(); return; }
      const errMsg = err?.message ?? "Unknown error";
      setApiError(errMsg);
      setMessages((prev) => prev.map((m) =>
        m.id === assistantId ? { ...m, content: "", error: errMsg, streaming: false } : m
      ));
      voice.resumeAmbient();
    } finally {
      setIsStreaming(false);
    }
  }, [input, session, userName, allTasks, docs, createTask, tts, voice]);

  useEffect(() => { sendRef.current = sendMessage; }, [sendMessage]);

  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendMessage(); }
  }

  function handleClear() {
    if (isStreaming) abortRef.current?.abort();
    tts.stop();
    setMessages([]);
    setApiError(null);
    historyRef.current = [];
    memoryRef.current = {};
    setIsStreaming(false);
    voice.resumeAmbient();
  }

  return (
    <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
      {/* Voice + API error status bar */}
      <VoiceBar
        mode={voice.mode}
        audioState={voice.audioState}
        level={voice.level}
        supported={voice.supported}
        whisperAvailable={voice.whisperAvailable}
        permissionDenied={voice.permissionDenied}
        ttsEnabled={tts.enabled}
        ttsSpeaking={tts.speaking}
        apiError={apiError}
        lang={lang}
        showLang={showLang}
        onToggleLang={() => setShowLang((v) => !v)}
        onSelectLang={(code) => { setLang(code); setShowLang(false); }}
        onToggleTTS={tts.toggle}
        onToggleMic={() => voice.mode === "off" ? voice.enable() : voice.disable()}
      />

      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-4 sm:px-8 py-6 space-y-5">
        {messages.length === 0 ? (
          <EmptyState userName={userName} supported={voice.supported} onSuggest={sendMessage} />
        ) : (
          messages.map((msg) => (
            <MessageBubble key={msg.id} message={msg} session={session} />
          ))
        )}
        <div ref={bottomRef} />
      </div>

      {/* Input */}
      <div className="flex-none px-4 sm:px-8 py-4 border-t border-border-default bg-background-base">
        <div className="flex items-end gap-3 bg-background-surface border border-border-default rounded-card px-4 py-3 focus-within:border-border-hover transition-colors duration-150">
          <textarea
            ref={textareaRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={voice.mode !== "off" ? 'Say "Jarvis…" or type here' : "Message JARVIS…"}
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
          <button onClick={() => sendMessage()} disabled={!input.trim() || isStreaming}
            className={cn("flex-none p-1.5 rounded-input transition-colors",
              input.trim() && !isStreaming ? "text-accent-blue hover:bg-accent-blue/10" : "text-text-muted cursor-not-allowed"
            )} title="Send (Enter)">
            <Send size={15} />
          </button>
        </div>
        <p className="text-text-muted text-[11px] mt-2 text-center">
          {voice.mode !== "off"
            ? 'Say "Jarvis [command]" · pause to send · or type + Enter'
            : "Enter to send · Shift+Enter for new line"}
        </p>
      </div>
    </div>
  );
}

// ─── Voice Status Bar ────────────────────────────────────────────────────────

function VoiceBar({
  mode, audioState, level, supported, whisperAvailable, permissionDenied,
  ttsEnabled, ttsSpeaking, apiError, lang, showLang,
  onToggleLang, onSelectLang, onToggleTTS, onToggleMic,
}: {
  mode: VoiceMode; audioState: AudioState; level: number;
  supported: boolean; whisperAvailable: boolean | null; permissionDenied: boolean;
  ttsEnabled: boolean; ttsSpeaking: boolean; apiError: string | null;
  lang: string; showLang: boolean;
  onToggleLang: () => void; onSelectLang: (c: string) => void;
  onToggleTTS: () => void; onToggleMic: () => void;
}) {
  const isActive = mode === "activated";
  const isBusy = mode === "busy";

  const statusLabel = () => {
    if (permissionDenied) return "Mic blocked — allow access in browser settings";
    if (mode === "off") return "Voice off — click mic to enable";
    if (isBusy) return ttsSpeaking ? "JARVIS speaking…" : "Processing…";
    if (isActive) return "Go ahead — I'm listening…";
    if (audioState === "transcribing") return "Transcribing…";
    if (audioState === "speaking") return 'Heard you — say "Jarvis" to activate';
    return 'Listening for "Jarvis…"';
  };

  const dotColor = () => {
    if (permissionDenied) return "bg-accent-red";
    if (mode === "off") return "bg-text-muted";
    if (isBusy) return "bg-accent-violet";
    if (isActive) return "bg-accent-blue";
    return "bg-success";
  };

  const barBg = isActive
    ? "bg-accent-blue/5 border-accent-blue/20"
    : isBusy
    ? "bg-accent-violet/5 border-accent-violet/20"
    : "";

  return (
    <div className={cn("flex-none border-b border-border-default transition-all", barBg)}>
      {/* API error banner */}
      {apiError && (
        <div className="flex items-center gap-2 px-4 sm:px-8 py-2 bg-accent-red/10 border-b border-accent-red/20">
          <AlertCircle size={12} className="text-accent-red flex-none" />
          <span className="text-xs text-accent-red flex-1 min-w-0 truncate">{apiError}</span>
          {apiError.includes("ANTHROPIC_API_KEY") && (
            <span className="text-[10px] text-accent-red/70 flex-none">→ Add key in Vercel Settings → Env Vars</span>
          )}
        </div>
      )}

      <div className="flex items-center gap-3 px-4 sm:px-8 py-2">
        {/* Dot + label */}
        <span className={cn("w-1.5 h-1.5 rounded-full flex-none", dotColor(),
          mode !== "off" && !isBusy && "animate-pulse")} />

        <span className={cn("text-xs font-mono flex-1 min-w-0 truncate",
          isActive ? "text-accent-blue" : isBusy ? "text-accent-violet" : "text-text-muted")}>
          {statusLabel()}
        </span>

        {/* Audio level waveform (while listening/speaking) */}
        {mode === "ambient" && audioState !== "idle" && audioState !== "transcribing" && (
          <Waveform level={level} active={audioState === "speaking"} />
        )}

        {/* Activated waveform */}
        {isActive && <Waveform level={level} active />}

        {/* Whisper not available warning */}
        {mode !== "off" && whisperAvailable === false && (
          <span className="text-[10px] font-mono text-warning flex items-center gap-1 flex-none">
            <Info size={10} /> Add OPENAI_API_KEY for Whisper
          </span>
        )}

        {/* Controls */}
        <div className="flex items-center gap-0.5 flex-none relative">
          <div className="relative">
            <button onClick={onToggleLang}
              className={cn("p-1.5 rounded-input transition-colors text-[10px] font-mono",
                showLang ? "text-accent-blue" : "text-text-muted hover:text-text-secondary")}>
              <Globe size={11} />
            </button>
            {showLang && (
              <div className="absolute top-7 right-0 bg-background-elevated border border-border-default rounded-card shadow-xl z-50 min-w-[180px] py-1 max-h-60 overflow-y-auto">
                {LANGUAGES.map((l) => (
                  <button key={l.code} onClick={() => onSelectLang(l.code)}
                    className={cn("w-full text-left px-3 py-1.5 text-xs transition-colors",
                      lang === l.code ? "text-accent-blue bg-accent-blue/10" : "text-text-secondary hover:text-text-primary hover:bg-background-surface")}>
                    {l.label}
                  </button>
                ))}
              </div>
            )}
          </div>

          <button onClick={onToggleTTS} title={ttsEnabled ? "Mute voice" : "Enable voice"}
            className={cn("p-1.5 rounded-input transition-colors",
              ttsEnabled ? ttsSpeaking ? "text-accent-violet animate-pulse" : "text-accent-violet"
                        : "text-text-muted hover:text-text-secondary")}>
            {ttsEnabled ? <Volume2 size={13} /> : <VolumeX size={13} />}
          </button>

          <button onClick={onToggleMic} title={mode === "off" ? "Enable listening" : "Disable listening"}
            className={cn("p-1.5 rounded-input transition-colors",
              mode !== "off" ? "text-accent-blue" : "text-text-muted hover:text-text-secondary")}>
            {mode !== "off" ? <Mic size={13} /> : <MicOff size={13} />}
          </button>
        </div>
      </div>
    </div>
  );
}

function Waveform({ level, active }: { level: number; active: boolean }) {
  const bars = [0.4, 0.7, 1.0, 0.8, 0.5];
  return (
    <div className="flex gap-0.5 items-center h-4 flex-none">
      {bars.map((mult, i) => {
        const h = active ? Math.max(3, Math.round(level * mult * 0.14)) : 3;
        return (
          <span key={i} className={cn("w-0.5 rounded-full transition-all duration-75",
            active ? "bg-accent-blue" : "bg-text-muted/40")}
            style={{ height: `${h}px` }} />
        );
      })}
    </div>
  );
}

// ─── Sub-components ──────────────────────────────────────────────────────────

function EmptyState({ userName, supported, onSuggest }: { userName?: string; supported: boolean; onSuggest: (text: string) => void }) {
  return (
    <div className="flex flex-col items-center justify-center h-full min-h-[50vh] gap-8 animate-fade-in">
      <div className="text-center">
        <div className="w-14 h-14 rounded-full bg-accent-blue/10 border border-accent-blue/20 flex items-center justify-center mx-auto mb-4">
          <Cpu size={22} className="text-accent-blue" />
        </div>
        <p className="text-text-primary font-semibold text-base mb-1">
          {userName ? `Good to see you, ${userName}.` : "JARVIS is online."}
        </p>
        <p className="text-text-secondary text-sm">
          {supported ? 'Say "Jarvis" to begin, or type below.' : "Type below to begin."}
        </p>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 w-full max-w-lg">
        {SUGGESTIONS.map((s) => (
          <button key={s} onClick={() => onSuggest(s.replace(/^Say "(.+)"$/, "$1").replace(/^Jarvis, /, ""))}
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
        <div className={cn("rounded-card px-4 py-3 text-sm leading-relaxed",
          isUser ? "bg-accent-blue/10 border border-accent-blue/20 text-text-primary"
                 : message.error ? "bg-accent-red/5 border border-accent-red/20"
                 : "bg-background-surface border border-border-default text-text-primary")}>
          {isUser ? (
            <span className="whitespace-pre-wrap">{message.content}</span>
          ) : message.error ? (
            <div className="flex items-start gap-2">
              <AlertCircle size={13} className="text-accent-red flex-none mt-0.5" />
              <div>
                <p className="text-accent-red text-sm font-medium">Error</p>
                <p className="text-accent-red/80 text-xs mt-0.5">{message.error}</p>
                {message.error.includes("ANTHROPIC_API_KEY") && (
                  <p className="text-text-muted text-xs mt-2">
                    Add <code className="font-mono bg-background-elevated px-1 rounded">ANTHROPIC_API_KEY</code> in Vercel → Settings → Environment Variables, then redeploy.
                  </p>
                )}
              </div>
            </div>
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
