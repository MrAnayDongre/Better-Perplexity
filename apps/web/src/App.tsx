import { useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import clsx from "clsx";
import { motion, AnimatePresence } from "framer-motion";
import {
  Sparkles,
  Plus,
  Search,
  ShieldCheck,
  Clock,
  FileText,
  Link as LinkIcon,
  ListTree,
  CheckCircle2
} from "lucide-react";

type ChatMode = "normal" | "reliability";
type ChatMessage = { role: "user" | "assistant"; content: string };
type StatusEvt = { message: string; step?: number; total?: number };

type RunView = {
  id: string;
  mode: ChatMode;
  userMessage: string;
  finalAnswer: string;
  trace: any[];
  claims: any[];
  sources: Array<{ url: string; title: string; domain: string; excerpt: string }>;
};

type Thread = {
  id: string;
  title: string;
  conversationId?: string;
  messages: ChatMessage[];
  lastRunId?: string;
};

const API_BASE = import.meta.env.VITE_API_BASE ?? "http://localhost:8787";

async function* chatStream(args: {
  conversationId?: string;
  message: string;
  mode: ChatMode;
}): AsyncGenerator<{ event: string; data: any }, void, void> {
  const res = await fetch(`${API_BASE}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
    body: JSON.stringify(args)
  });

  if (!res.ok || !res.body) {
    const t = await res.text().catch(() => "");
    throw new Error(`Chat failed (${res.status}): ${t}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    buffer = buffer.replace(/\r\n/g, "\n");

    const parts = buffer.split("\n\n");
    buffer = parts.pop() ?? "";

    for (const part of parts) {
      const lines = part.split("\n");
      const eventLine = lines.find((l) => l.startsWith("event: "));
      const dataLine = lines.find((l) => l.startsWith("data: "));
      if (!eventLine || !dataLine) continue;

      const event = eventLine.slice("event: ".length).trim();
      const data = JSON.parse(dataLine.slice("data: ".length));
      yield { event, data };
    }
  }
}

async function getRun(runId: string): Promise<RunView> {
  const res = await fetch(`${API_BASE}/api/runs/${runId}`);
  if (!res.ok) throw new Error("Failed to load run");
  return res.json();
}



async function getRunWithRetry(runId: string, attempts = 4): Promise<RunView> {
  let lastErr: unknown = null;
  for (let i = 0; i < attempts; i++) {
    try {
      return await getRun(runId);
    } catch (e) {
      lastErr = e;
      // small backoff: 150ms, 300ms, 450ms...
      await new Promise((r) => setTimeout(r, 150 * (i + 1)));
    }
  }
  throw lastErr ?? new Error("Failed to load run");
}

function pct(step?: number, total?: number) {
  if (!step || !total || total <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((step / total) * 100)));
}

function linkifyCitations(md: string): string {
  // convert Source[2] → link chip
  return md.replace(/\(?Source\[(\d+)\]\)?/g, (_m, n) => `[Source[${n}]](#source-${n})`);
}

function titleFromPrompt(prompt: string) {
  const t = prompt.trim().replace(/\s+/g, " ");
  return t.length > 42 ? t.slice(0, 42) + "…" : t;
}

export default function App() {
  const [mode, setMode] = useState<ChatMode>("reliability");

  const [threads, setThreads] = useState<Thread[]>([
    {
      id: "t1",
      title: "New thread",
      conversationId: undefined,
      messages: [
        {
          role: "assistant",
          content:
            "Ask anything. I’ll search, cite sources, and (in Reliability Mode) verify claims.\n\nTry: **Explain photosynthesis**"
        }
      ]
    }
  ]);
  const [activeThreadId, setActiveThreadId] = useState("t1");
  const activeThread = threads.find((t) => t.id === activeThreadId)!;

  const [activeRun, setActiveRun] = useState<RunView | null>(null);
  const [runById, setRunById] = useState<Record<string, RunView>>({});
  const [panel, setPanel] = useState<"answer" | "sources" | "trace" | "claims">("answer");

  const [status, setStatus] = useState<StatusEvt | null>(null);
  const [steps, setSteps] = useState<string[]>([]);
  const [highlightSource, setHighlightSource] = useState<number | null>(null);

  const [input, setInput] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);

  const tokenBuf = useRef<string>("");
  const raf = useRef<number | null>(null);
  const streamedCharsRef = useRef<number>(0);

  const canSend = useMemo(() => input.trim().length > 0 && !isStreaming, [input, isStreaming]);

  function patchActiveThread(patch: (t: Thread) => Thread) {
    setThreads((prev) => prev.map((t) => (t.id === activeThreadId ? patch(t) : t)));
  }

  function ensureAssistantPlaceholder() {
    patchActiveThread((t) => {
      const msgs = [...t.messages];
      const last = msgs[msgs.length - 1];
      if (!last || last.role !== "assistant") msgs.push({ role: "assistant", content: "" });
      return { ...t, messages: msgs };
    });
  }

  function appendAssistantChunk(chunk: string) {
    patchActiveThread((t) => {
      const msgs = [...t.messages];
      const last = msgs[msgs.length - 1];
      if (!last || last.role !== "assistant") {
        msgs.push({ role: "assistant", content: chunk });
      } else {
        msgs[msgs.length - 1] = { role: "assistant", content: last.content + chunk };
      }
      return { ...t, messages: msgs };
    });
  }

  function flushBufferedTokens() {
    if (!tokenBuf.current) return;
    const chunk = tokenBuf.current;
    tokenBuf.current = "";
    appendAssistantChunk(chunk);
  }

  function newThread() {
    const id = `t${Date.now()}`;
    const t: Thread = {
      id,
      title: "New thread",
      conversationId: undefined,
      messages: [{ role: "assistant", content: "What are you curious about?" }]
    };
    setThreads((prev) => [t, ...prev]);
    setActiveThreadId(id);
    setActiveRun(null);
    setPanel("answer");
  }

  async function onSend() {
    if (!canSend) return;

    setIsStreaming(true);
    setActiveRun(null);
    setPanel("answer");
    setStatus({ message: "Starting…", step: 0, total: 4 });
    setSteps([]);

    const userText = input.trim();
    setInput("");

    if (activeThread.title === "New thread") {
      patchActiveThread((t) => ({ ...t, title: titleFromPrompt(userText) }));
    }

    patchActiveThread((t) => ({ ...t, messages: [...t.messages, { role: "user", content: userText }] }));
    ensureAssistantPlaceholder();
    streamedCharsRef.current = 0;

    try {
      for await (const evt of chatStream({
        conversationId: activeThread.conversationId,
        message: userText,
        mode
      })) {
        if (evt.event === "meta") {
          patchActiveThread((t) => ({ ...t, conversationId: evt.data.conversationId }));
        }

        if (evt.event === "status") {
          setStatus(evt.data);
          const msg = evt.data?.message;
          if (msg) setSteps((prev) => (prev[prev.length - 1] === msg ? prev : [...prev, msg]));
        }

        if (evt.event === "error") {
          const msg = evt.data?.message ?? "Unknown error";
          patchActiveThread((t) => ({ ...t, messages: [...t.messages, { role: "assistant", content: `⚠️ ${msg}` }] }));
        }

        if (evt.event === "token") {
          const ch = String(evt.data.chunk ?? "");
          tokenBuf.current += ch;
          streamedCharsRef.current += ch.length;

          if (raf.current == null) {
            raf.current = window.requestAnimationFrame(() => {
              raf.current = null;
              flushBufferedTokens();
            });
          }
        }

        if (evt.event === "done") {
          if (raf.current != null) {
            window.cancelAnimationFrame(raf.current);
            raf.current = null;
          }
          flushBufferedTokens();

          patchActiveThread((t) => ({ ...t, lastRunId: evt.data.runId }));

          const run = await getRunWithRetry(evt.data.runId);
          setRunById((prev) => ({ ...prev, [evt.data.runId]: run }));
          setActiveRun(run);
          setPanel("answer");
          setStatus({ message: "Done", step: 4, total: 4 });
          window.setTimeout(() => setStatus(null), 1200);

          // Hydrate only if streaming stalled (keeps premium typing feel)
          if (streamedCharsRef.current < 120) {
            patchActiveThread((t) => {
              const msgs = [...t.messages];
              for (let i = msgs.length - 1; i >= 0; i--) {
                if (msgs[i].role === "assistant") {
                  msgs[i] = { role: "assistant", content: run.finalAnswer || msgs[i].content };
                  break;
                }
              }
              return { ...t, messages: msgs };
            });
          }
        }
      }
    } catch (e: any) {
      patchActiveThread((t) => ({
        ...t,
        messages: [...t.messages, { role: "assistant", content: `⚠️ ${e?.message ?? "Request failed"}` }]
      }));
      setStatus(null);
    } finally {
      setIsStreaming(false);
    }
  }

  const progress = pct(status?.step, status?.total);

  function handleCitationJump(n: number) {
    setPanel("sources");
    setHighlightSource(n);
    window.setTimeout(() => setHighlightSource(null), 1100);
    const el = document.getElementById(`source-${n}`);
    if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  
  useEffect(() => {
    const t = threads.find((x) => x.id === activeThreadId);
    const rid = t?.lastRunId;
    setActiveRun(rid ? runById[rid] ?? null : null);
  }, [activeThreadId, threads, runById]);

useEffect(() => {
    const fn = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        (document.getElementById("bp-input") as HTMLInputElement | null)?.focus();
      }
    };
    window.addEventListener("keydown", fn);
    return () => window.removeEventListener("keydown", fn);
  }, []);

  const TopTabs = (
    <div className="flex items-center gap-3 text-sm">
      {([
        { k: "answer", icon: FileText, label: "Answer" },
        { k: "sources", icon: LinkIcon, label: "Links" },
        { k: "trace", icon: ListTree, label: "Trace" },
        { k: "claims", icon: CheckCircle2, label: "Claims" }
      ] as const).map((t) => {
        const Icon = t.icon;
        const active = panel === t.k;
        return (
          <button
            key={t.k}
            onClick={() => setPanel(t.k)}
            className={clsx(
              "flex items-center gap-2 rounded-full px-3 py-2 transition",
              active
                ? "bg-white/10 text-white ring-1 ring-white/10"
                : "text-gray-300 hover:bg-white/5 hover:text-white"
            )}
          >
            <Icon size={16} />
            {t.label}
          </button>
        );
      })}
    </div>
  );

  return (
    <div className="h-screen w-full overflow-hidden">
      {/* Top nav (Perplexity-ish) */}
      <div className="sticky top-0 z-30 border-b border-white/10 bg-black/30 backdrop-blur">
        <div className="mx-auto flex max-w-7xl items-center justify-between px-4 py-3">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-white/10 ring-1 ring-white/10">
              <Sparkles className="text-indigo-200" size={18} />
            </div>
            <div>
              <div className="text-sm font-semibold text-white">Better-Perplexity</div>
              <div className="text-[11px] text-gray-400">⌘K focus • SSE • citations • reliability</div>
            </div>
          </div>

          <div className="hidden md:block">{TopTabs}</div>

          <div className="flex items-center gap-3">
            <button
              onClick={newThread}
              className="flex items-center gap-2 rounded-full bg-white/10 px-3 py-2 text-sm text-white ring-1 ring-white/10 hover:bg-white/15 transition"
            >
              <Plus size={16} />
              New
            </button>

            <button
              onClick={() => setMode((m) => (m === "reliability" ? "normal" : "reliability"))}
              className={clsx(
                "flex items-center gap-2 rounded-full px-3 py-2 text-sm ring-1 transition",
                mode === "reliability"
                  ? "bg-emerald-500/15 text-emerald-100 ring-emerald-400/20 hover:bg-emerald-500/20"
                  : "bg-white/10 text-white ring-white/10 hover:bg-white/15"
              )}
              title="Toggle Reliability"
            >
              <ShieldCheck size={16} />
              {mode === "reliability" ? "Reliability" : "Fast"}
            </button>
          </div>
        </div>

        {/* Progress + steps */}
        <AnimatePresence>
          {status ? (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: "auto", opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              className="border-t border-white/10"
            >
              <div className="mx-auto max-w-7xl px-4 py-3">
                <div className="flex items-center justify-between text-xs text-gray-300">
                  <div className="flex items-center gap-2">
                    <Clock size={14} className="text-gray-400" />
                    <span>{status.message}</span>
                  </div>
                  <span>{progress}%</span>
                </div>

                <div className="mt-2 h-2 w-full rounded-full bg-white/5 ring-1 ring-white/10 overflow-hidden">
                  <motion.div
                    initial={{ width: 0 }}
                    animate={{ width: `${progress}%` }}
                    transition={{ type: "spring", stiffness: 120, damping: 18 }}
                    className="h-2 rounded-full bg-gradient-to-r from-indigo-400/80 via-emerald-400/70 to-pink-400/70"
                  />
                </div>

                {steps.length ? (
                  <div className="mt-2 flex flex-wrap gap-2">
                    {steps.slice(-6).map((s, i) => (
                      <span
                        key={i}
                        className="rounded-full bg-white/5 px-3 py-1 text-[11px] text-gray-200 ring-1 ring-white/10"
                      >
                        {s}
                      </span>
                    ))}
                  </div>
                ) : null}
              </div>
            </motion.div>
          ) : null}
        </AnimatePresence>
      </div>

      {/* Layout */}
      <div className="mx-auto grid h-[calc(100vh-64px)] max-w-7xl grid-cols-12 gap-0 overflow-hidden">
        {/* Sidebar */}
        <aside className="col-span-3 hidden border-r border-white/10 md:block h-full overflow-y-auto">
          <div className="p-4">
            <div className="mb-3 flex items-center gap-2 text-xs font-semibold text-gray-400">
              <Search size={14} /> History
            </div>

            <div className="space-y-2">
              {threads.map((t) => {
                const active = t.id === activeThreadId;
                return (
                  <button
                    key={t.id}
                    onClick={() => {
                      setActiveThreadId(t.id);
                      const rid = t.lastRunId;
                      setActiveRun(rid ? runById[rid] ?? null : null);
                      setPanel("answer");
                    }}
                    className={clsx(
                      "w-full rounded-2xl px-3 py-3 text-left transition ring-1",
                      active
                        ? "bg-white/10 text-white ring-white/15"
                        : "bg-white/5 text-gray-200 ring-white/10 hover:bg-white/8"
                    )}
                  >
                    <div className="truncate text-sm font-semibold">{t.title}</div>
                    <div className="mt-1 truncate text-[11px] text-gray-400">
                      {t.messages.filter((m) => m.role === "user").slice(-1)[0]?.content ?? "—"}
                    </div>
                  </button>
                );
              })}
            </div>

            <div className="mt-4 text-[11px] text-gray-500">
              API <span className="text-gray-300">{API_BASE}</span>
            </div>
          </div>
        </aside>

        {/* Center */}
        <main className="col-span-12 md:col-span-6 h-full overflow-y-auto">
          <div className="px-4 py-8">
            <div className="mx-auto max-w-2xl space-y-4">
              <AnimatePresence initial={false}>
                {activeThread.messages.map((m, i) => {
                  const isUser = m.role === "user";
                  return (
                    <motion.div
                      key={i}
                      initial={{ opacity: 0, y: 10 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, y: 10 }}
                      transition={{ duration: 0.18 }}
                      className={clsx(
                        "rounded-3xl px-5 py-4 ring-1 min-w-0",
                        isUser
                          ? "ml-auto max-w-[92%] bg-gradient-to-b from-indigo-500/20 to-emerald-500/10 ring-white/10"
                          : "glass max-w-[100%]"
                      )}
                    >
                      {isUser ? (
                        <div className="text-sm leading-relaxed text-white">{m.content}</div>
                      ) : (
                        <div className="prose prose-invert prose-sm max-w-none break-words">
                          <ReactMarkdown
                            components={{
                              a({ href, children, ...props }) {
                                if (href?.startsWith("#source-")) {
                                  const n = Number(href.replace("#source-", ""));
                                  return (
                                    <a
                                      {...props}
                                      href={href}
                                      onClick={(e) => {
                                        e.preventDefault();
                                        handleCitationJump(n);
                                      }}
                                      className="no-underline"
                                    >
                                      <span className="inline-flex items-center rounded-full bg-white/10 px-2 py-0.5 text-[11px] text-white ring-1 ring-white/10 hover:bg-white/15">
                                        {children}
                                      </span>
                                    </a>
                                  );
                                }
                                return (
                                  <a {...props} href={href} target="_blank" rel="noreferrer" className="underline">
                                    {children}
                                  </a>
                                );
                              }
                            }}
                          >
                            {linkifyCitations(m.content)}
                          </ReactMarkdown>
                        </div>
                      )}
                    </motion.div>
                  );
                })}
              </AnimatePresence>

              <div className="h-24" />
            </div>
          </div>

          {/* Premium input dock */}
          <div className="sticky bottom-0 border-t border-white/10 bg-black/30 backdrop-blur">
            <div className="mx-auto max-w-2xl px-4 py-4">
              <div className="glass rounded-3xl p-3">
                <div className="flex items-center gap-2">
                  <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-white/5 ring-1 ring-white/10">
                    <Search className="text-gray-300" size={18} />
                  </div>

                  <input
                    id="bp-input"
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    placeholder="Ask anything…"
                    className="w-full bg-transparent px-2 py-2 text-sm text-white outline-none placeholder:text-gray-400"
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !e.shiftKey) {
                        e.preventDefault();
                        onSend();
                      }
                    }}
                  />

                  <button
                    onClick={onSend}
                    disabled={!canSend}
                    className={clsx(
                      "rounded-2xl px-4 py-2 text-sm font-semibold transition ring-1",
                      canSend
                        ? "bg-white text-black ring-white/20 hover:bg-gray-100"
                        : "bg-white/10 text-gray-400 ring-white/10"
                    )}
                  >
                    Send
                  </button>
                </div>

                <div className="mt-2 flex items-center justify-between text-[11px] text-gray-400">
                  <span>Mode: {mode === "reliability" ? "Reliability (verify claims)" : "Fast (quick answer)"}</span>
                  <span className="hidden sm:inline">Tip: cite chips jump to sources</span>
                </div>
              </div>
            </div>
          </div>
        </main>

        {/* Right panel */}
        <aside className="col-span-3 hidden border-l border-white/10 md:block h-full overflow-y-auto">
          <div className="p-4">
            <div className="mb-3 md:hidden">{TopTabs}</div>

            {!activeRun ? (
              <div className="glass rounded-3xl p-4 text-sm text-gray-300">
                No run loaded yet. Ask something to see Sources / Trace / Claims.
              </div>
            ) : panel === "sources" ? (
              <div className="space-y-3">
                {activeRun.sources.map((s, idx) => (
                  <div
                    key={s.url}
                    id={`source-${idx + 1}`}
                    className={clsx(
                      "glass rounded-3xl p-4 transition",
                      highlightSource === idx + 1 && "ring-2 ring-indigo-400/40"
                    )}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div className="text-sm font-semibold text-white">
                        Source[{idx + 1}] —{" "}
                        <a className="underline decoration-white/20 hover:decoration-white/60" href={s.url} target="_blank" rel="noreferrer">
                          {s.domain}
                        </a>
                      </div>
                    </div>
                    <div className="mt-1 text-xs text-gray-300">{s.title}</div>
                    <div className="mt-2 text-xs text-gray-200/90">{s.excerpt}</div>
                  </div>
                ))}
              </div>
            ) : panel === "trace" ? (
              <pre className="glass rounded-3xl p-4 text-xs text-gray-200 whitespace-pre-wrap max-w-full overflow-x-auto max-w-full overflow-x-auto break-words">
                {JSON.stringify(activeRun.trace, null, 2)}
              </pre>
            ) : panel === "claims" ? (
              <div className="space-y-3">
                {activeRun.claims?.length ? (
                  activeRun.claims.map((c: any) => (
                    <div key={c.id} className="glass rounded-3xl p-4">
                      <div className="flex items-center justify-between">
                        <div className="text-xs font-semibold text-gray-200">{String(c.label).toUpperCase()}</div>
                        <div className="text-xs text-gray-400">score {c.score}</div>
                      </div>
                      <div className="mt-2 text-sm text-white">{c.claim}</div>
                    </div>
                  ))
                ) : (
                  <div className="glass rounded-3xl p-4 text-sm text-gray-300">No claims for this run.</div>
                )}
              </div>
            ) : (
              <div className="glass rounded-3xl p-4 text-sm text-gray-300">
                The answer is in the middle pane. Use Links/Trace/Claims here.
              </div>
            )}
          </div>
        </aside>
      </div>
    </div>
  );
}
