"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Download, RefreshCw, CheckCircle2, AlertCircle, Loader2, FileDown, Zap, X, BookOpen, Languages, Layers } from "lucide-react";

interface LatestInfo {
  platform: string;
  version: string | null;
  commit: string | null;
  fileName: string;
  fileSize: number;
  url: string;
  contentType: string;
  lastModified: string | null;
  fetchedAt: string;
}

interface CachedInfo {
  platform: string;
  version: string | null;
  commit: string | null;
  fileName: string;
  fileSize: number;
  chunkCount: number;
  chunkSize: number;
  contentType: string;
  sourceUrl: string;
  sourceLastModified: string | null;
  cachedAt: string;
  status?: string;
  completedAt?: string | null;
}

interface CheckResult {
  latest: LatestInfo;
  cached: CachedInfo | null;
  needsUpdate: boolean;
  reason: string;
  durationMs: number;
}

interface StatusResult {
  cached: CachedInfo | null;
}

interface StepProgress {
  chunksDone: number;
  chunksTotal: number;
  bytesDownloaded: number;
  bytesTotal: number;
  chunkIndex: number;
}

interface DownloadProgressInfo {
  received: number;
  total: number;
  fileName: string;
  chunkIndex: number;
  chunkTotal: number;
  speedBps: number; // bytes per second (rolling average)
}

interface ChangelogData {
  text: string;
  sourceUrl: string;
  fetchedAt: string;
  translationStatus?: "none" | "pending" | "done" | "failed";
  translatedAt?: string;
}

const PLATFORMS = [
  { id: "win32-x64-user", label: "Windows x64", desc: "User Setup · .exe" },
  { id: "darwin-arm64", label: "macOS Apple Silicon", desc: "ARM64 · .dmg" },
  { id: "darwin-x64", label: "macOS Intel", desc: "x64 · .dmg" },
  { id: "linux-x64", label: "Linux x64", desc: "AppImage" },
];

function formatBytes(bytes: number): string {
  if (!bytes || bytes <= 0) return "—";
  const units = ["B", "KB", "MB", "GB"];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / Math.pow(1024, i)).toFixed(2)} ${units[i]}`;
}

// Format a download speed (bytes/sec) into a human-readable string like "2.35 MB/s".
function formatSpeed(bps: number): string {
  if (!bps || bps <= 0) return "—";
  const units = ["B/s", "KB/s", "MB/s", "GB/s"];
  const i = Math.min(Math.floor(Math.log(bps) / Math.log(1024)), units.length - 1);
  return `${(bps / Math.pow(1024, i)).toFixed(2)} ${units[i]}`;
}

function shortCommit(c: string | null | undefined): string {
  if (!c) return "—";
  return c.slice(0, 8);
}

export default function Home() {
  const [platform, setPlatform] = useState("win32-x64-user");
  const [checking, setChecking] = useState(false);
  const [updating, setUpdating] = useState(false);
  const [checkResult, setCheckResult] = useState<CheckResult | null>(null);
  const [statusResult, setStatusResult] = useState<StatusResult | null>(null);
  const [error, setError] = useState<string>("");
  const [elapsed, setElapsed] = useState(0);
  const [updateProgress, setUpdateProgress] = useState<StepProgress | null>(null);
  const [downloadProgress, setDownloadProgress] = useState<DownloadProgressInfo | null>(null);
  const [downloading, setDownloading] = useState(false);
  const [changelog, setChangelog] = useState<ChangelogData | null>(null);
  const [changelogZh, setChangelogZh] = useState<ChangelogData | null>(null);
  const [changelogLoading, setChangelogLoading] = useState(false);
  const [changelogLang, setChangelogLang] = useState<"orig" | "zh">("orig");
  const [zhLoading, setZhLoading] = useState(false);
  const [showChangelog, setShowChangelog] = useState(false);
  const [models, setModels] = useState<ChangelogData | null>(null);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [showModels, setShowModels] = useState(false);
  const platformRef = useRef(platform);
  platformRef.current = platform;

  // Lightweight status-only fetch (no cursor.com ping) — used on mount so the
  // page can show the cached version + download button instantly without
  // triggering any "auto update" behaviour against cursor.com.
  const handleStatus = useCallback(async (id?: string) => {
    const p = id ?? platformRef.current;
    try {
      const resp = await fetch(`/koa/api/status?platform=${p}`);
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.detail || data.error || "状态获取失败");
      setStatusResult(data);
    } catch (e) {
      // Silent — status is best-effort on mount.
      setStatusResult({ cached: null });
    }
  }, []);

  const handleCheck = useCallback(async () => {
    setChecking(true);
    setError("");
    try {
      const resp = await fetch(`/koa/api/check?platform=${platformRef.current}`);
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.detail || data.error || "检查失败");
      setCheckResult(data);
      setStatusResult({ cached: data.cached });
    } catch (e) {
      setError(e instanceof Error ? e.message : "检查失败");
      setCheckResult(null);
    } finally {
      setChecking(false);
    }
  }, []);

  // On mount: only fetch cached status — NEVER auto-call /api/check, which
  // would ping cursor.com. The user explicitly opted out of auto-updates.
  useEffect(() => {
    handleStatus();
  }, [handleStatus]);

  // Loop through /api/update-step — each call downloads one chunk and returns
  // progress. The backend has no single-shot /api/update endpoint; update-step
  // is the resumable per-chunk endpoint designed for frontend loops.
  const handleUpdate = async (force = false) => {
    setUpdating(true);
    setError("");
    setUpdateProgress(null);
    const start = Date.now();
    const timer = setInterval(() => setElapsed(Date.now() - start), 500);
    try {
      let maxCalls = 200; // 32 chunks + headroom for retries
      let lastAction = "";
      while (maxCalls-- > 0) {
        const url = `/koa/api/update-step?platform=${platform}${force ? "&force=true" : ""}`;
        const resp = await fetch(url, { method: "POST" });
        const data = await resp.json();
        if (!resp.ok) throw new Error(data.detail || data.error || "更新失败");
        lastAction = data.action;
        if (data.progress) setUpdateProgress(data.progress);
        if (data.action === "completed" || data.action === "skipped") break;
        if (data.action === "error") throw new Error(data.detail || "更新失败");
        // action === 'started' | 'chunk_done' | 'retry' → loop again
        await new Promise((r) => setTimeout(r, 200));
      }
      // Refresh views so the UI reflects the new cache state.
      await Promise.all([handleCheck(), handleStatus()]);
      if (lastAction !== "completed" && lastAction !== "skipped") {
        setError("更新未完成，请重试");
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "更新失败");
    } finally {
      clearInterval(timer);
      setElapsed(0);
      setUpdating(false);
    }
  };

  const handleDownload = async () => {
    setError("");
    setDownloading(true);
    setDownloadProgress(null);
    const start = Date.now();
    const timer = setInterval(() => setElapsed(Date.now() - start), 500);

    // Rolling-average speed tracker. Each chunk download updates the speed
    // estimate based on elapsed time and bytes received so far. We keep the
    // last few samples to smooth out per-chunk variance.
    const speedSamples: { t: number; bytes: number }[] = [];
    const trackSpeed = (received: number) => {
      const now = Date.now();
      speedSamples.push({ t: now, bytes: received });
      // keep last 6 samples (~each chunk) for a stable rolling average
      if (speedSamples.length > 6) speedSamples.shift();
      if (speedSamples.length < 2) return 0;
      const first = speedSamples[0];
      const dt = (now - first.t) / 1000;
      if (dt <= 0) return 0;
      return (received - first.bytes) / dt;
    };

    try {
      // 1. Fetch the manifest describing how to reassemble the installer.
      const manifestResp = await fetch(`/koa/api/download-manifest?platform=${platform}`);
      const manifest = await manifestResp.json();
      if (!manifestResp.ok) throw new Error(manifest.detail || manifest.error || "获取下载清单失败");
      const { fileName, fileSize, chunks } = manifest as {
        fileName: string;
        fileSize: number;
        chunks: { index: number; url: string; size: number }[];
      };

      // 2. Try the File System Access API (Chromium) to stream straight to
      // disk without holding the full file in memory.
      const w = window as unknown as {
        showSaveFilePicker?: (opts: {
          suggestedName?: string;
          types?: { description?: string; accept: Record<string, string[]> }[];
        }) => Promise<FileSystemFileHandle>;
      };
      if (typeof w.showSaveFilePicker === "function") {
        let handle: FileSystemFileHandle;
        try {
          handle = await w.showSaveFilePicker({
            suggestedName: fileName,
            types: [
              {
                description: "Installer",
                accept: { "application/octet-stream": [".exe", ".dmg", ".AppImage"] },
              },
            ],
          });
        } catch (e) {
          if (e instanceof DOMException && e.name === "AbortError") return;
          throw e;
        }
        const writable = await (handle as unknown as { createWritable: () => Promise<FileSystemWritableFileStream> }).createWritable();
        let received = 0;
        for (const chunk of chunks) {
          const r = await fetch(chunk.url);
          if (!r.ok) throw new Error(`分片 ${chunk.index} 下载失败: HTTP ${r.status}`);
          const buf = await r.arrayBuffer();
          await writable.write(buf);
          received += buf.byteLength;
          const speed = trackSpeed(received);
          setDownloadProgress({ received, total: fileSize, fileName, chunkIndex: chunk.index + 1, chunkTotal: chunks.length, speedBps: speed });
          setElapsed(Date.now() - start);
        }
        await writable.close();
        const speed = trackSpeed(fileSize);
        setDownloadProgress({ received: fileSize, total: fileSize, fileName, chunkIndex: chunks.length, chunkTotal: chunks.length, speedBps: speed });
        return;
      }

      // 3. Fallback: fetch all chunks into memory, then trigger a Blob download.
      const parts: BlobPart[] = [];
      let received = 0;
      for (const chunk of chunks) {
        const r = await fetch(chunk.url);
        if (!r.ok) throw new Error(`分片 ${chunk.index} 下载失败: HTTP ${r.status}`);
        const buf = await r.arrayBuffer();
        parts.push(buf);
        received += buf.byteLength;
        const speed = trackSpeed(received);
        setDownloadProgress({ received, total: fileSize, fileName, chunkIndex: chunk.index + 1, chunkTotal: chunks.length, speedBps: speed });
        setElapsed(Date.now() - start);
      }
      const blob = new Blob(parts, { type: "application/octet-stream" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = fileName;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 30000);
    } catch (e) {
      setError(e instanceof Error ? e.message : "下载失败");
    } finally {
      clearInterval(timer);
      setElapsed(0);
      setDownloading(false);
    }
  };

  // Fetch the original changelog (cached on the server). The server also kicks
  // off an LLM translation in the background whenever the source text changes.
  const handleChangelog = async () => {
    setShowChangelog(true);
    setChangelogLang("orig");
    if (changelog) return;
    setChangelogLoading(true);
    try {
      const resp = await fetch("/koa/api/changelog");
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.detail || data.error || "获取更新日志失败");
      setChangelog(data.changelog);
      // If a translation already exists server-side, prefetch it so the toggle
      // feels instant when the user clicks 简体中文.
      if (data.changelog?.translationStatus === "done") {
        try {
          const zhResp = await fetch("/koa/api/changelog?lang=zh");
          const zhData = await zhResp.json();
          if (zhResp.ok && zhData.changelog) setChangelogZh(zhData.changelog);
        } catch (_) {}
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "获取更新日志失败");
    } finally {
      setChangelogLoading(false);
    }
  };

  // Lazily fetch the Chinese translation when the user toggles to it.
  const handleSwitchToZh = async () => {
    setChangelogLang("zh");
    if (changelogZh) return;
    setZhLoading(true);
    try {
      const resp = await fetch("/koa/api/changelog?lang=zh");
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.detail || data.error || "翻译获取失败");
      setChangelogZh(data.changelog);
      // Keep the original's translationStatus in sync so the badge updates.
      if (changelog && data.changelog) {
        setChangelog({
          ...changelog,
          translationStatus: data.changelog.translationStatus,
          translatedAt: data.changelog.translatedAt,
        });
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "翻译获取失败");
    } finally {
      setZhLoading(false);
    }
  };

  // Open the pricing mirror. Lazily fetches the cached text on first open.
  // Content is shown in English as-is (no translation) per the plan.
  const handleModels = async () => {
    setShowModels(true);
    if (models) return;
    setModelsLoading(true);
    try {
      const resp = await fetch("/koa/api/models");
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.detail || data.error || "获取价目表失败");
      setModels(data.models);
    } catch (e) {
      setError(e instanceof Error ? e.message : "获取价目表失败");
    } finally {
      setModelsLoading(false);
    }
  };

  const onPlatformChange = (id: string) => {
    setPlatform(id);
    setCheckResult(null);
    setStatusResult(null);
    setError("");
    handleStatus(id);
  };

  const cached = (statusResult?.cached ?? checkResult?.cached ?? null);
  const cacheReady = !!cached && cached.status === "ready";
  const needsUpdate = checkResult?.needsUpdate ?? false;
  const hasValidCache = cacheReady;
  const downloadPct = downloadProgress && downloadProgress.total > 0
    ? Math.round((downloadProgress.received / downloadProgress.total) * 100)
    : 0;
  const updatePct = updateProgress && updateProgress.chunksTotal > 0
    ? Math.round((updateProgress.chunksDone / updateProgress.chunksTotal) * 100)
    : 0;

  // What the "current version" should read: prefer the latest-checked value
  // when we have it (most accurate), otherwise fall back to cached version.
  const currentVersion = checkResult?.latest?.version || cached?.version || null;

  return (
    <div className="relative min-h-screen overflow-hidden bg-[#05070d] text-white">
      {/* Animated flowing background */}
      <div className="pointer-events-none fixed inset-0 -z-10 overflow-hidden">
        <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_top,rgba(28,102,229,0.15),transparent_55%)]" />
        <div className="blob blob-1" />
        <div className="blob blob-2" />
        <div className="blob blob-3" />
        <div className="absolute inset-0 bg-[linear-gradient(to_bottom,transparent_0%,rgba(5,7,13,0.65)_70%,rgba(5,7,13,0.95)_100%)]" />
        {/* subtle grid overlay */}
        <div
          className="absolute inset-0 opacity-[0.04]"
          style={{
            backgroundImage:
              "linear-gradient(rgba(255,255,255,0.6) 1px,transparent 1px),linear-gradient(90deg,rgba(255,255,255,0.6) 1px,transparent 1px)",
            backgroundSize: "48px 48px",
          }}
        />
      </div>

      {/* Header */}
      <header className="sticky top-0 z-20 border-b border-white/5 bg-[#05070d]/70 backdrop-blur-xl">
        <div className="container mx-auto flex max-w-3xl items-center justify-between px-6 py-3.5">
          <div className="flex items-center gap-3">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br from-[#3b82f6] to-[#1c66e5] font-bold shadow-lg shadow-[#1c66e5]/30">
              C
            </div>
            <div className="leading-tight">
              <h1 className="text-sm font-semibold">Cursor 安装包镜像</h1>
              <p className="text-[10px] text-gray-500">cursor.sxwzxc.cn</p>
            </div>
          </div>
          <div className="flex items-center gap-1">
            <button
              onClick={handleModels}
              className="flex cursor-pointer items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs text-gray-400 transition-colors hover:bg-white/5 hover:text-white"
            >
              <Layers className="h-3.5 w-3.5" />
              价目表
            </button>
            <button
              onClick={handleChangelog}
              className="flex cursor-pointer items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs text-gray-400 transition-colors hover:bg-white/5 hover:text-white"
            >
              <BookOpen className="h-3.5 w-3.5" />
              更新日志
            </button>
          </div>
        </div>
      </header>

      {/* Main */}
      <main className="mx-auto max-w-3xl px-6 py-8">
        {/* Hero — single line description, no title row to save space */}
        <div className="mb-6 text-center">
          <p className="mx-auto max-w-2xl text-[13px] leading-relaxed text-gray-400">
            本站从 Cursor 官方源（cursor.com）同步最新版安装包并缓存于 EdgeOne 边缘节点，适用于无法访问 cursor.com 官网的网络环境。
          </p>
        </div>

        {/* Platform selector */}
        <Card className="mb-4 border-white/5 bg-white/[0.03] shadow-2xl shadow-black/40 backdrop-blur-sm">
          <CardContent className="px-5 py-4">
            <div className="mb-2.5 flex items-center justify-between">
              <label className="text-[10px] uppercase tracking-wider text-gray-500">选择平台</label>
              {currentVersion && (
                <span className="rounded-full bg-[#1c66e5]/15 px-2 py-0.5 font-mono text-[10px] text-[#6fa0ff]">
                  官方 v{currentVersion}
                </span>
              )}
            </div>
            <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-4">
              {PLATFORMS.map((p) => (
                <button
                  key={p.id}
                  onClick={() => onPlatformChange(p.id)}
                  className={`rounded-md border px-3 py-2 text-left transition-all ${
                    platform === p.id
                      ? "border-[#1c66e5] bg-[#1c66e5]/15 shadow-sm shadow-[#1c66e5]/20"
                      : "border-white/5 bg-white/[0.02] hover:border-white/20 hover:bg-white/[0.05]"
                  }`}
                >
                  <div className="text-xs font-medium">{p.label}</div>
                  <div className="mt-0.5 text-[10px] text-gray-500">{p.desc}</div>
                </button>
              ))}
            </div>
          </CardContent>
        </Card>

        {/* Update progress bar (mirroring chunks to mirror station) */}
        {updating && updateProgress && (
          <Card className="mb-4 border-[#1c66e5]/30 bg-white/[0.03]">
            <CardContent className="px-5 py-4">
              <div className="mb-2 flex items-center justify-between">
                <span className="flex items-center gap-2 text-sm text-gray-300">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  同步到镜像站…
                </span>
                <span className="font-mono text-[11px] text-gray-400">
                  {updateProgress.chunksDone}/{updateProgress.chunksTotal} 分片 · {formatBytes(updateProgress.bytesDownloaded)}/{formatBytes(updateProgress.bytesTotal)}
                  {elapsed > 0 && ` · ${Math.floor(elapsed / 1000)}s`}
                </span>
              </div>
              <div className="h-1.5 w-full overflow-hidden rounded-full bg-gray-800">
                <div
                  className="h-full rounded-full bg-gradient-to-r from-[#1c66e5] to-[#3b82f6] transition-all duration-300"
                  style={{ width: `${updatePct}%` }}
                />
              </div>
            </CardContent>
          </Card>
        )}

        {/* Download progress bar */}
        {downloading && downloadProgress && (
          <Card className="mb-4 border-green-600/30 bg-white/[0.03]">
            <CardContent className="px-5 py-4">
              <div className="mb-2 flex items-center justify-between">
                <span className="flex items-center gap-2 text-sm text-gray-300">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  下载 {downloadProgress.fileName}…
                </span>
                <span className="font-mono text-[11px] text-gray-400">
                  {downloadProgress.chunkIndex}/{downloadProgress.chunkTotal} 分片 · {formatBytes(downloadProgress.received)}/{formatBytes(downloadProgress.total)}
                  {elapsed > 0 && ` · ${Math.floor(elapsed / 1000)}s`}
                </span>
              </div>
              <div className="h-1.5 w-full overflow-hidden rounded-full bg-gray-800">
                <div
                  className="h-full rounded-full bg-gradient-to-r from-green-500 to-emerald-400 transition-all duration-300"
                  style={{ width: `${downloadPct}%` }}
                />
              </div>
              <div className="mt-2 flex items-center justify-between">
                <span className="font-mono text-[11px] text-green-400">
                  {downloadPct}% · {formatSpeed(downloadProgress.speedBps)}
                  {downloadProgress.speedBps > 0 && downloadPct < 100 && (() => {
                    const remaining = downloadProgress.total - downloadProgress.received;
                    const etaSec = remaining / downloadProgress.speedBps;
                    if (etaSec > 0 && etaSec < 3600) {
                      return ` · 剩余约 ${Math.ceil(etaSec)}s`;
                    }
                    return "";
                  })()}
                </span>
                <span className="font-mono text-[11px] text-gray-500">
                  {formatBytes(downloadProgress.received)} / {formatBytes(downloadProgress.total)}
                </span>
              </div>
              <div className="mt-3 flex items-start gap-2 rounded-md border border-yellow-800/40 bg-yellow-950/20 px-3 py-2">
                <AlertCircle className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-yellow-400" />
                <p className="text-[11px] leading-relaxed text-yellow-300/90">
                  由于分片下载方式特殊，<span className="font-medium text-yellow-200">请保持此页面打开，不要关闭或切换标签页</span>，直至下载完成（100%）。关闭网页将中断下载。
                </p>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Action row + downloadable version info */}
        <Card className="mb-4 border-white/5 bg-white/[0.03] shadow-2xl shadow-black/40 backdrop-blur-sm">
          <CardContent className="px-5 py-5">
            <div className="flex flex-wrap items-center gap-2.5">
              <Button
                onClick={handleCheck}
                disabled={checking || updating || downloading}
                className="cursor-pointer bg-[#1c66e5] px-5 text-sm hover:bg-[#1c66e5]/90"
              >
                {checking ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    检查中…
                  </>
                ) : (
                  <>
                    <RefreshCw className="mr-2 h-4 w-4" />
                    检查更新
                  </>
                )}
              </Button>

              {hasValidCache && (
                <Button
                  onClick={handleDownload}
                  disabled={updating || downloading}
                  className="cursor-pointer bg-green-600 px-5 text-sm hover:bg-green-700"
                >
                  {downloading ? (
                    <>
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      下载中… {downloadPct}%
                    </>
                  ) : (
                    <>
                      <FileDown className="mr-2 h-4 w-4" />
                      下载安装包
                    </>
                  )}
                </Button>
              )}

              {checkResult && !needsUpdate && (
                <Button
                  onClick={() => handleUpdate(true)}
                  disabled={checking || updating || downloading}
                  variant="ghost"
                  className="cursor-pointer px-4 text-sm text-gray-400 hover:bg-white/5 hover:text-white"
                >
                  <Zap className="mr-2 h-4 w-4" />
                  强制刷新
                </Button>
              )}

              {needsUpdate && (
                <Button
                  onClick={() => handleUpdate(false)}
                  disabled={checking || updating || downloading}
                  variant="outline"
                  className="cursor-pointer border-gray-600 px-5 text-sm text-white hover:bg-gray-800"
                >
                  {updating ? (
                    <>
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      同步中…
                    </>
                  ) : (
                    <>
                      <Download className="mr-2 h-4 w-4" />
                      同步最新版到镜像站
                    </>
                  )}
                </Button>
              )}
            </div>

            {/* Downloadable version info — small text under the buttons */}
            <div className="mt-3 border-t border-white/5 pt-3">
              {cacheReady && cached ? (
                <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-gray-500">
                  <span className="flex items-center gap-1.5">
                    <CheckCircle2 className="h-3 w-3 text-green-400" />
                    可直接下载版本：<span className="font-mono text-gray-300">v{cached.version || "未知"}</span>
                  </span>
                  <span className="font-mono">{formatBytes(cached.fileSize)}</span>
                  <span className="font-mono text-gray-600">{shortCommit(cached.commit)}</span>
                  <span>缓存于 {new Date(cached.cachedAt).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })}</span>
                </div>
              ) : statusResult ? (
                <p className="text-[11px] text-gray-500">
                  当前平台暂无缓存。点击 <span className="text-gray-300">检查更新</span> 从 cursor.com 同步最新版到镜像站。
                </p>
              ) : (
                <p className="text-[11px] text-gray-500">正在读取本地缓存状态…</p>
              )}
            </div>
          </CardContent>
        </Card>

        {/* Error */}
        {error && (
          <Card className="mb-4 border-red-900/50 bg-red-950/20">
            <CardContent className="px-5 py-4">
              <div className="flex items-start gap-3">
                <AlertCircle className="mt-0.5 h-4 w-4 flex-shrink-0 text-red-400" />
                <div>
                  <p className="mb-0.5 text-xs font-medium text-red-400">出错了</p>
                  <p className="break-all font-mono text-[11px] text-red-300">{error}</p>
                </div>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Status panel — only shown after a manual check */}
        {checkResult && (
          <Card className="mb-4 border-white/5 bg-white/[0.03]">
            <CardContent className="px-5 py-4">
              <div className="mb-3 flex items-center gap-2">
                {needsUpdate ? (
                  <AlertCircle className="h-4 w-4 text-yellow-400" />
                ) : (
                  <CheckCircle2 className="h-4 w-4 text-green-400" />
                )}
                <span className="text-sm font-medium">状态</span>
                <span className="ml-auto font-mono text-[10px] text-gray-500">耗时 {checkResult.durationMs}ms</span>
              </div>
              <div className="space-y-1.5 text-xs">
                <Row label="官方最新版">
                  <span className="font-mono">{checkResult.latest.version || "未知"}</span>
                  <span className="ml-2 font-mono text-[10px] text-gray-500">{shortCommit(checkResult.latest.commit)}</span>
                </Row>
                <Row label="镜像站缓存">
                  {checkResult.cached ? (
                    <>
                      <span className="font-mono">{checkResult.cached.version || "未知"}</span>
                      <span className="ml-2 font-mono text-[10px] text-gray-500">{shortCommit(checkResult.cached.commit)}</span>
                    </>
                  ) : (
                    <span className="text-gray-500">无缓存</span>
                  )}
                </Row>
                <Row label="文件大小">
                  <span className="font-mono">{formatBytes(checkResult.latest.fileSize)}</span>
                </Row>
                <Row label="结果">
                  {needsUpdate ? (
                    <span className="text-yellow-400">需要更新</span>
                  ) : (
                    <span className="text-green-400">已是最新版，可直接下载</span>
                  )}
                  <span className="ml-2 text-[10px] text-gray-600">({checkResult.reason})</span>
                </Row>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Help / API docs */}
        <details className="mt-6 rounded-lg border border-white/5 bg-white/[0.02]">
          <summary className="cursor-pointer px-5 py-3 text-xs font-medium text-gray-400 transition-colors hover:text-white">
            API 列表（用于自动化测试）
          </summary>
          <div className="px-5 pb-4 text-[11px] text-gray-500">
            <pre className="overflow-x-auto font-mono leading-relaxed">
{`GET  /koa                       API 说明
GET  /koa/api/platforms        平台列表
GET  /koa/api/latest?platform=  官方最新版信息
GET  /koa/api/status?platform=  镜像站缓存信息
GET  /koa/api/check?platform=   对比最新版与缓存
POST /koa/api/update-step?platform=  下载一个分片（前端循环调用）
POST /koa/api/auto-update?platform=   自动检查+下载（定时任务用）
GET  /koa/api/download-manifest?platform=  分片清单
GET  /koa/api/download-chunk?platform=&index=  下载单个分片
GET  /koa/api/changelog?force=<bool>   获取并缓存更新日志
GET  /koa/api/changelog?lang=zh        获取简体中文翻译
GET  /koa/api/models?force=<bool>      获取并缓存订阅套餐价目表（原文）
GET  /koa/api/debug-llm               (调试) 检查 LLM 环境变量配置
GET  /koa/api/debug-translate          (调试) 测试一次 LLM 翻译调用`}
            </pre>
          </div>
        </details>
      </main>

      {/* Footer */}
      <footer className="border-t border-white/5">
        <div className="mx-auto max-w-3xl px-6 py-5 text-center text-[11px] text-gray-600">
          <p>数据源：cursor.com 官方 API · 镜像缓存于 EdgeOne Pages Blob 存储</p>
          <p className="mt-0.5">本站仅做镜像缓存，不修改任何安装包内容 · 每天 0:00 自动同步最新版</p>
        </div>
      </footer>

      {/* Changelog modal */}
      {showChangelog && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4 backdrop-blur-sm"
          onClick={() => setShowChangelog(false)}
        >
          <div
            className="flex max-h-[85vh] w-full max-w-3xl flex-col rounded-xl border border-white/10 bg-[#0a0d14] shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-white/5 px-6 py-4">
              <h3 className="flex items-center gap-2 text-base font-semibold">
                <BookOpen className="h-4 w-4 text-[#1c66e5]" />
                Cursor 更新日志
                {changelog && (
                  <span className="ml-2 text-[10px] font-normal text-gray-500">
                    更新于 {new Date(changelog.fetchedAt).toLocaleString("zh-CN")}
                  </span>
                )}
              </h3>
              <div className="flex items-center gap-2">
                {/* Language toggle */}
                <div className="flex items-center rounded-md border border-white/10 bg-white/[0.03] p-0.5">
                  <button
                    onClick={() => setChangelogLang("orig")}
                    className={`flex items-center gap-1 rounded px-2.5 py-1 text-[11px] transition-all ${
                      changelogLang === "orig"
                        ? "bg-[#1c66e5] text-white"
                        : "text-gray-400 hover:text-white"
                    }`}
                  >
                    原文
                  </button>
                  <button
                    onClick={handleSwitchToZh}
                    disabled={zhLoading}
                    className={`flex items-center gap-1 rounded px-2.5 py-1 text-[11px] transition-all ${
                      changelogLang === "zh"
                        ? "bg-[#1c66e5] text-white"
                        : "text-gray-400 hover:text-white"
                    } ${zhLoading ? "opacity-60" : ""}`}
                  >
                    {zhLoading ? (
                      <Loader2 className="h-3 w-3 animate-spin" />
                    ) : (
                      <Languages className="h-3 w-3" />
                    )}
                    简体中文
                    {changelog?.translationStatus === "done" && !zhLoading && (
                      <span className="ml-1 text-[9px] text-green-400">●</span>
                    )}
                  </button>
                </div>
                {changelog && (
                  <a
                    href={changelog.sourceUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-[11px] text-gray-400 transition-colors hover:text-white"
                  >
                    原文 ↗
                  </a>
                )}
                <button
                  onClick={() => setShowChangelog(false)}
                  className="cursor-pointer text-gray-400 transition-colors hover:text-white"
                >
                  <X className="h-5 w-5" />
                </button>
              </div>
            </div>
            <div className="flex-1 overflow-y-auto px-6 py-4">
              {changelogLoading ? (
                <div className="flex items-center justify-center py-12">
                  <Loader2 className="h-6 w-6 animate-spin text-gray-400" />
                  <span className="ml-3 text-sm text-gray-400">加载中…</span>
                </div>
              ) : changelogLang === "zh" ? (
                zhLoading ? (
                  <div className="flex flex-col items-center justify-center py-12">
                    <Loader2 className="h-6 w-6 animate-spin text-[#1c66e5]" />
                    <span className="mt-3 text-sm text-gray-400">正在获取翻译…</span>
                    <span className="mt-1 text-[11px] text-gray-600">首次翻译由大模型生成，可能需要数秒</span>
                  </div>
                ) : changelogZh ? (
                  <pre className="whitespace-pre-wrap font-mono text-xs leading-relaxed text-gray-300">{changelogZh.text}</pre>
                ) : (
                  <div className="py-12 text-center">
                    <p className="text-sm text-gray-400">翻译暂不可用</p>
                    <p className="mt-1 text-[11px] text-gray-600">服务端未配置翻译 LLM，请稍后再试或查看原文</p>
                  </div>
                )
              ) : changelog ? (
                <pre className="whitespace-pre-wrap font-mono text-xs leading-relaxed text-gray-300">{changelog.text}</pre>
              ) : (
                <p className="py-12 text-center text-sm text-gray-500">无内容</p>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Pricing modal */}
      {showModels && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4 backdrop-blur-sm"
          onClick={() => setShowModels(false)}
        >
          <div
            className="flex max-h-[85vh] w-full max-w-3xl flex-col rounded-xl border border-white/10 bg-[#0a0d14] shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-white/5 px-6 py-4">
              <h3 className="flex items-center gap-2 text-base font-semibold">
                <Layers className="h-4 w-4 text-[#1c66e5]" />
                订阅套餐价目表
                {models && (
                  <span className="ml-2 text-[10px] font-normal text-gray-500">
                    更新于 {new Date(models.fetchedAt).toLocaleString("zh-CN")}
                  </span>
                )}
              </h3>
              <div className="flex items-center gap-2">
                {models && (
                  <a
                    href={models.sourceUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-[11px] text-gray-400 transition-colors hover:text-white"
                  >
                    原文 ↗
                  </a>
                )}
                <button
                  onClick={() => setShowModels(false)}
                  className="cursor-pointer text-gray-400 transition-colors hover:text-white"
                >
                  <X className="h-5 w-5" />
                </button>
              </div>
            </div>
            <div className="flex-1 overflow-y-auto px-6 py-4">
              {modelsLoading ? (
                <div className="flex items-center justify-center py-12">
                  <Loader2 className="h-6 w-6 animate-spin text-gray-400" />
                  <span className="ml-3 text-sm text-gray-400">加载中…</span>
                </div>
              ) : models ? (
                <pre className="whitespace-pre-wrap break-words font-mono text-xs leading-relaxed text-gray-300">{models.text}</pre>
              ) : (
                <p className="py-12 text-center text-sm text-gray-500">无内容</p>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 py-0.5">
      <span className="text-gray-400">{label}</span>
      <span className="truncate text-right">{children}</span>
    </div>
  );
}
