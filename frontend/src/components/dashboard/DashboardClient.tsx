"use client";

import { useState, useEffect } from "react";
import { useLocalTasks } from "@/hooks/useLocalTasks";
import { cn, formatRelativeTime } from "@/lib/utils";
import {
  CheckSquare, MessageSquare, Zap, Brain, ArrowRight, Clock,
  Target, FileText, Cpu, Shield, Mic, Globe, TrendingUp, AlertTriangle,
} from "lucide-react";
import Link from "next/link";

const PRIORITY_DOT: Record<string, string> = {
  low: "bg-text-muted", medium: "bg-accent-blue", high: "bg-warning", urgent: "bg-accent-red",
};
const PRIORITY_RING: Record<string, string> = {
  low: "border-text-muted/20", medium: "border-accent-blue/30", high: "border-warning/30", urgent: "border-accent-red/40",
};

function useClock() {
  const [time, setTime] = useState("");
  const [date, setDate] = useState("");
  useEffect(() => {
    function tick() {
      const now = new Date();
      setTime(now.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", second: "2-digit" }));
      setDate(now.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" }));
    }
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, []);
  return { time, date };
}

export function DashboardClient() {
  const { allTasks, ready } = useLocalTasks();
  const { time, date } = useClock();

  const open = allTasks.filter((t) => t.status !== "done" && t.status !== "cancelled");
  const urgent = open.filter((t) => t.priority === "urgent" || t.priority === "high");
  const doneToday = allTasks.filter((t) => {
    if (t.status !== "done" || !t.completed_at) return false;
    return new Date(t.completed_at).toDateString() === new Date().toDateString();
  });
  const overdue = open.filter((t) => {
    if (!t.due_date) return false;
    return new Date(t.due_date) < new Date(new Date().toDateString());
  });

  return (
    <div className="space-y-4 animate-fade-in">

      {/* ── Row 1: Hero HUD ──────────────────────────────────────────── */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">

        {/* Clock + Status */}
        <div className="lg:col-span-2 bg-background-surface border border-border-default rounded-card p-6 relative overflow-hidden hud-grid">
          <div className="absolute inset-0 bg-gradient-to-br from-accent-blue/3 to-transparent pointer-events-none" />
          <div className="relative">
            <div className="flex items-center gap-2 mb-4">
              <span className="status-dot" />
              <span className="text-xs font-mono text-success tracking-widest uppercase">JARVIS · ONLINE</span>
            </div>
            <div className="font-mono text-4xl sm:text-5xl font-bold text-text-primary tracking-tight mb-1">
              {time || "––:––:––"}
            </div>
            <div className="text-text-secondary text-sm font-mono">{date}</div>

            <div className="mt-5 flex flex-wrap gap-4">
              <MiniStat icon={<CheckSquare size={13} />} label="Open" value={ready ? open.length : "—"} color="blue" />
              <MiniStat icon={<AlertTriangle size={13} />} label="Urgent" value={ready ? urgent.length : "—"} color="red" />
              <MiniStat icon={<Zap size={13} />} label="Done today" value={ready ? doneToday.length : "—"} color="green" />
              {overdue.length > 0 && (
                <MiniStat icon={<Clock size={13} />} label="Overdue" value={overdue.length} color="orange" />
              )}
            </div>
          </div>
        </div>

        {/* System Status */}
        <div className="bg-background-surface border border-border-default rounded-card p-5 relative overflow-hidden">
          <div className="absolute top-0 right-0 w-24 h-24 bg-accent-violet/3 rounded-full blur-3xl pointer-events-none" />
          <p className="text-[10px] font-mono text-text-muted tracking-widest uppercase mb-4">System Status</p>
          <div className="space-y-3">
            <SystemLine icon={<Cpu size={12} />} label="AI Engine" value="claude-sonnet-4-6" status="online" />
            <SystemLine icon={<Brain size={12} />} label="Memory" value="Session active" status="online" />
            <SystemLine icon={<Mic size={12} />} label="Voice" value="STT + TTS ready" status="online" />
            <SystemLine icon={<Shield size={12} />} label="Auth" value="Google OAuth" status="online" />
            <SystemLine icon={<Globe size={12} />} label="Knowledge" value="Upload ready" status="idle" />
            <SystemLine icon={<TrendingUp size={12} />} label="Finance" value="Phase 2" status="pending" />
          </div>
        </div>
      </div>

      {/* ── Row 2: Tasks + Actions ──────────────────────────────────── */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">

        {/* Task list */}
        <div className="lg:col-span-2 bg-background-surface border border-border-default rounded-card overflow-hidden">
          <div className="flex items-center justify-between px-5 py-4 border-b border-border-default">
            <div className="flex items-center gap-2">
              <CheckSquare size={14} className="text-accent-blue" />
              <h2 className="text-sm font-semibold text-text-primary">Open Tasks</h2>
              {ready && urgent.length > 0 && (
                <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-accent-red/10 text-accent-red border border-accent-red/20">
                  {urgent.length} urgent
                </span>
              )}
            </div>
            <Link href="/tasks" className="flex items-center gap-1 text-xs text-text-muted hover:text-accent-blue transition-colors">
              View all <ArrowRight size={11} />
            </Link>
          </div>

          {!ready ? (
            <div className="flex justify-center py-10">
              <div className="w-4 h-4 border-2 border-accent-blue/20 border-t-accent-blue rounded-full animate-spin" />
            </div>
          ) : open.length === 0 ? (
            <div className="px-5 py-10 text-center">
              <p className="text-text-muted text-sm">No open tasks.</p>
              <Link href="/tasks" className="text-accent-blue text-xs hover:underline mt-1 inline-block">Create one →</Link>
            </div>
          ) : (
            <ul className="divide-y divide-border-default">
              {[...open]
                .sort((a, b) => {
                  const order = { urgent: 0, high: 1, medium: 2, low: 3 };
                  return (order[a.priority] ?? 4) - (order[b.priority] ?? 4);
                })
                .slice(0, 8)
                .map((t) => {
                  const od = t.due_date && new Date(t.due_date) < new Date(new Date().toDateString());
                  return (
                    <li key={t.id} className="flex items-center gap-3 px-5 py-3 hover:bg-background-elevated/60 transition-colors group">
                      <span className={cn(
                        "w-2 h-2 rounded-full flex-none border",
                        PRIORITY_DOT[t.priority],
                        PRIORITY_RING[t.priority]
                      )} />
                      <span className="flex-1 text-sm text-text-primary truncate">{t.title}</span>
                      {t.assignee && <span className="text-text-muted text-xs hidden sm:block">{t.assignee}</span>}
                      {t.due_date && (
                        <span className={cn("text-xs flex-none font-mono", od ? "text-accent-red" : "text-text-muted")}>
                          {od ? "overdue" : new Date(t.due_date).toLocaleDateString("en-US", { month: "short", day: "numeric" })}
                        </span>
                      )}
                      <span className={cn(
                        "hidden md:inline text-[10px] font-mono px-1.5 py-0.5 rounded border",
                        t.status === "in_progress" ? "text-accent-blue border-accent-blue/20 bg-accent-blue/5" : "text-text-muted border-border-default"
                      )}>
                        {t.status === "in_progress" ? "In Progress" : "To Do"}
                      </span>
                    </li>
                  );
                })}
            </ul>
          )}
        </div>

        {/* Quick actions */}
        <div className="space-y-3">
          <QuickCard
            href="/assistant"
            icon={<MessageSquare size={16} />}
            label="Ask JARVIS"
            sub="AI assistant · Online"
            color="blue"
            primary
          />
          <QuickCard
            href="/tasks"
            icon={<CheckSquare size={16} />}
            label="Action Tracker"
            sub={ready ? `${open.length} open · ${urgent.length} urgent` : "Manage tasks"}
            color="violet"
          />
          <QuickCard
            href="/notes"
            icon={<FileText size={16} />}
            label="Notes"
            sub="Quick capture"
            color="green"
          />
          <QuickCard
            href="/goals"
            icon={<Target size={16} />}
            label="Goals"
            sub="Track progress"
            color="orange"
          />
        </div>
      </div>

      {/* ── Row 3: JARVIS Capabilities ──────────────────────────────── */}
      <div className="bg-background-surface border border-border-default rounded-card p-5">
        <p className="text-[10px] font-mono text-text-muted tracking-widest uppercase mb-4">JARVIS Capabilities</p>
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
          {[
            { label: "Streaming AI", icon: "⚡", active: true },
            { label: "Task Creation", icon: "✓", active: true },
            { label: "Voice I/O", icon: "🎙", active: true },
            { label: "Memory", icon: "🧠", active: true },
            { label: "Knowledge Base", icon: "📚", active: true },
            { label: "Web Search", icon: "🌐", active: false },
            { label: "Email", icon: "✉", active: false },
            { label: "Calendar", icon: "📅", active: false },
            { label: "Finance AI", icon: "💹", active: false },
            { label: "Agents", icon: "🤖", active: false },
            { label: "Automation", icon: "⚙", active: false },
            { label: "Digital Twin", icon: "🪞", active: false },
          ].map(({ label, icon, active }) => (
            <div key={label} className={cn(
              "flex items-center gap-2 px-3 py-2.5 rounded-input border text-xs transition-colors",
              active
                ? "border-accent-blue/20 bg-accent-blue/5 text-text-secondary"
                : "border-border-default bg-background-elevated text-text-muted opacity-50"
            )}>
              <span className="text-sm">{icon}</span>
              <span className="truncate">{label}</span>
              {active && <span className="ml-auto w-1.5 h-1.5 rounded-full bg-success flex-none" />}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function MiniStat({ icon, label, value, color }: { icon: React.ReactNode; label: string; value: number | string; color: string }) {
  const cls: Record<string, string> = {
    blue: "text-accent-blue", green: "text-success", red: "text-accent-red", orange: "text-warning",
  };
  return (
    <div className="flex items-center gap-2">
      <span className={cls[color] ?? "text-text-muted"}>{icon}</span>
      <span className={cn("font-display font-bold text-lg", cls[color])}>{value}</span>
      <span className="text-text-muted text-xs">{label}</span>
    </div>
  );
}

function SystemLine({ icon, label, value, status }: {
  icon: React.ReactNode; label: string; value: string; status: "online" | "idle" | "pending";
}) {
  const dotCls = { online: "bg-success animate-pulse-glow", idle: "bg-accent-blue/50", pending: "bg-text-muted" }[status];
  return (
    <div className="flex items-center gap-3">
      <span className="text-text-muted flex-none">{icon}</span>
      <span className="text-text-secondary text-xs flex-1">{label}</span>
      <span className="text-text-muted text-[11px] font-mono hidden sm:block">{value}</span>
      <span className={cn("w-1.5 h-1.5 rounded-full flex-none", dotCls)} />
    </div>
  );
}

function QuickCard({ href, icon, label, sub, color, primary }: {
  href: string; icon: React.ReactNode; label: string; sub: string; color: string; primary?: boolean;
}) {
  const accent: Record<string, string> = {
    blue: "text-accent-blue border-accent-blue/20 hover:border-accent-blue/40 hover:bg-accent-blue/5",
    violet: "text-accent-violet border-accent-violet/20 hover:border-accent-violet/40 hover:bg-accent-violet/5",
    green: "text-success border-success/20 hover:border-success/40 hover:bg-success/5",
    orange: "text-warning border-warning/20 hover:border-warning/40 hover:bg-warning/5",
  };
  return (
    <Link href={href} className={cn(
      "flex items-center gap-3 px-4 py-3.5 rounded-card border transition-all",
      "bg-background-surface",
      accent[color]
    )}>
      <span className={cn("flex-none", accent[color].split(" ")[0])}>{icon}</span>
      <div className="min-w-0">
        <p className="text-sm font-medium text-text-primary">{label}</p>
        <p className="text-xs text-text-muted truncate">{sub}</p>
      </div>
      <ArrowRight size={13} className="ml-auto text-text-muted flex-none" />
    </Link>
  );
}
