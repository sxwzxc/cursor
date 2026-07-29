"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Download, RefreshCw, CheckCircle2, AlertCircle, Loader2, FileDown, Zap, X, BookOpen } from "lucide-react";

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

function shortCommit(c: string | null | undefined): string {
  if (!c) return "—";
  return c.slice(0, 8);
}

export default function Home() {
  const [platform, setPlatform] = useState("win32-x64-user");
  const [checking, setChecking] = useState(false);
  const [updating, setUpdating] = useState(false);
  const [checkResult, setCheckResult] = useState<CheckResult | null>(null);
  const [error, setError] = useState<string>("");
  const [elapsed, setElapsed] = useState(0);
  const [updateProgress, setUpdateProgress] = useState<StepProgress | null>(null);
  const [downloadProgress, setDownloadProgress] = useState<DownloadProgressInfo | null>(null);
  const [downloading, setDownloading] = useState(false);
  const [autoChecked, setAutoChecked] = useState(false);
  const [changelog, setChangelog] = useState<{ text: string; fetchedAt: string; sourceUrl: string } | null>(null);
  const [changelogLoading, setChangelogLoading] = useState(false);
  const [showChangelog, setShowChangelog] = useState(false);
  const platformRef = useRef(platform);
  platformRef.current = platform;

  const handleCheck = useCallback(async () => {
    setChecking(true);
    setError("");
    try {
      const resp = await fetch(`/koa/api/check?platform=${platformRef.current}`);
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.detail || data.error || "检查失败");
      setCheckResult(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : "检查失败");
      setCheckResult(null);
    } finally {
      setChecking(false);
    }
  }, []);

  // Auto-check on mount so the download button appears immediately.
  useEffect(() => {
    handleCheck().then(() => setAutoChecked(true));
  }, [handleCheck]);

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
      // Refresh the check view so the UI reflects the new cache state.
      await handleCheck();
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
          setDownloadProgress({ received, total: fileSize, fileName, chunkIndex: chunk.index + 1, chunkTotal: chunks.length });
          setElapsed(Date.now() - start);
        }
        await writable.close();
        setDownloadProgress({ received: fileSize, total: fileSize, fileName, chunkIndex: chunks.length, chunkTotal: chunks.length });
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
        setDownloadProgress({ received, total: fileSize, fileName, chunkIndex: chunk.index + 1, chunkTotal: chunks.length });
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

  const handleChangelog = async () => {
    setShowChangelog(true);
    if (changelog) return;
    setChangelogLoading(true);
    try {
      const resp = await fetch("/koa/api/changelog");
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.detail || data.error || "获取更新日志失败");
      setChangelog(data.changelog);
    } catch (e) {
      setError(e instanceof Error ? e.message : "获取更新日志失败");
    } finally {
      setChangelogLoading(false);
    }
  };

  const onPlatformChange = (id: string) => {
    setPlatform(id);
    setCheckResult(null);
    setError("");
  };

  // Re-check when platform changes (after the initial auto-check).
  useEffect(() => {
    if (!autoChecked) return;
    handleCheck();
  }, [platform, autoChecked, handleCheck]);

  const cached = checkResult?.cached ?? null;
  const hasValidCache = !!cached && cached.status === "ready" && !checkResult?.needsUpdate;
  const downloadPct = downloadProgress && downloadProgress.total > 0
    ? Math.round((downloadProgress.received / downloadProgress.total) * 100)
    : 0;
  const updatePct = updateProgress && updateProgress.chunksTotal > 0
    ? Math.round((updateProgress.chunksDone / updateProgress.chunksTotal) * 100)
    : 0;

  return (
    <div className="min-h-screen bg-black text-white">
      {/* Header */}
      <header className="border-b border-gray-800 bg-black/80 backdrop-blur sticky top-0 z-10">
        <div className="container mx-auto px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-md bg-[#1c66e5] flex items-center justify-center font-bold">
              C
            </div>
            <div>
              <h1 className="text-lg font-semibold leading-tight">Cursor 安装包镜像</h1>
              <p className="text-xs text-gray-500 leading-tight">cursor.sxwzxc.cn</p>
            </div>
          </div>
          <button
            onClick={handleChangelog}
            className="text-sm text-gray-400 hover:text-white transition-colors flex items-center gap-1 cursor-pointer"
          >
            <BookOpen className="w-4 h-4" />
            更新日志
          </button>
        </div>
      </header>

      {/* Main */}
      <main className="max-w-3xl mx-auto px-6 py-12">
        {/* Hero */}
        <div className="text-center mb-10">
          <h2 className="text-4xl sm:text-5xl font-bold mb-4 tracking-tight">
            Cursor 最新版安装包
          </h2>
          <p className="text-gray-400 leading-relaxed max-w-xl mx-auto">
            本站从 Cursor 官方源（cursor.com）同步最新版安装包并缓存于 EdgeOne 边缘节点。
            <br />
            适用于无法访问 cursor.com 官网的网络环境。
          </p>
        </div>

        {/* Platform selector */}
        <Card className="bg-gray-900 border-gray-700 mb-6">
          <CardContent className="pt-6">
            <label className="block text-xs uppercase tracking-wider text-gray-500 mb-3">
              选择平台
            </label>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              {PLATFORMS.map((p) => (
                <button
                  key={p.id}
                  onClick={() => onPlatformChange(p.id)}
                  className={`text-left px-4 py-3 rounded-md border transition-all ${
                    platform === p.id
                      ? "border-[#1c66e5] bg-[#1c66e5]/10"
                      : "border-gray-700 bg-gray-800/40 hover:border-gray-500"
                  }`}
                >
                  <div className="font-medium text-sm">{p.label}</div>
                  <div className="text-xs text-gray-500 mt-0.5">{p.desc}</div>
                </button>
              ))}
            </div>
          </CardContent>
        </Card>

        {/* Update progress bar (mirroring chunks to mirror station) */}
        {updating && updateProgress && (
          <Card className="bg-gray-900 border-[#1c66e5]/50 mb-6">
            <CardContent className="pt-6">
              <div className="flex items-center justify-between mb-2">
                <span className="text-sm text-gray-300 flex items-center gap-2">
                  <Loader2 className="w-4 h-4 animate-spin" />
                  同步到镜像站…
                </span>
                <span className="text-xs font-mono text-gray-400">
                  {updateProgress.chunksDone}/{updateProgress.chunksTotal} 分片 · {formatBytes(updateProgress.bytesDownloaded)}/{formatBytes(updateProgress.bytesTotal)}
                  {elapsed > 0 && ` · ${Math.floor(elapsed / 1000)}s`}
                </span>
              </div>
              <div className="w-full h-2 bg-gray-800 rounded-full overflow-hidden">
                <div
                  className="h-full bg-[#1c66e5] rounded-full transition-all duration-300"
                  style={{ width: `${updatePct}%` }}
                />
              </div>
            </CardContent>
          </Card>
        )}

        {/* Download progress bar */}
        {downloading && downloadProgress && (
          <Card className="bg-gray-900 border-green-600/50 mb-6">
            <CardContent className="pt-6">
              <div className="flex items-center justify-between mb-2">
                <span className="text-sm text-gray-300 flex items-center gap-2">
                  <Loader2 className="w-4 h-4 animate-spin" />
                  下载 {downloadProgress.fileName}…
                </span>
                <span className="text-xs font-mono text-gray-400">
                  {downloadProgress.chunkIndex}/{downloadProgress.chunkTotal} 分片 · {formatBytes(downloadProgress.received)}/{formatBytes(downloadProgress.total)}
                  {elapsed > 0 && ` · ${Math.floor(elapsed / 1000)}s`}
                </span>
              </div>
              <div className="w-full h-2 bg-gray-800 rounded-full overflow-hidden">
                <div
                  className="h-full bg-green-500 rounded-full transition-all duration-300"
                  style={{ width: `${downloadPct}%` }}
                />
              </div>
              <div className="text-right mt-1 text-xs font-mono text-green-400">{downloadPct}%</div>
            </CardContent>
          </Card>
        )}

        {/* Action row */}
        <div className="flex flex-wrap gap-3 justify-center mb-6">
          <Button
            onClick={handleCheck}
            disabled={checking || updating || downloading}
            className="bg-[#1c66e5] hover:bg-[#1c66e5]/90 text-white px-6 cursor-pointer"
          >
            {checking ? (
              <>
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                检查中…
              </>
            ) : (
              <>
                <RefreshCw className="w-4 h-4 mr-2" />
                检查更新
              </>
            )}
          </Button>

          {checkResult?.needsUpdate && (
            <Button
              onClick={() => handleUpdate(false)}
              disabled={checking || updating || downloading}
              variant="outline"
              className="border-gray-600 text-white hover:bg-gray-800 px-6 cursor-pointer"
            >
              {updating ? (
                <>
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  同步中…
                </>
              ) : (
                <>
                  <Download className="w-4 h-4 mr-2" />
                  下载最新版到镜像站
                </>
              )}
            </Button>
          )}

          {hasValidCache && (
            <Button
              onClick={handleDownload}
              disabled={updating || downloading}
              className="bg-green-600 hover:bg-green-700 text-white px-6 cursor-pointer"
            >
              {downloading ? (
                <>
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  下载中… {downloadPct}%
                </>
              ) : (
                <>
                  <FileDown className="w-4 h-4 mr-2" />
                  下载安装包
                </>
              )}
            </Button>
          )}

          {checkResult && !checkResult.needsUpdate && (
            <Button
              onClick={() => handleUpdate(true)}
              disabled={checking || updating || downloading}
              variant="ghost"
              className="text-gray-400 hover:text-white hover:bg-gray-800 cursor-pointer"
            >
              <Zap className="w-4 h-4 mr-2" />
              强制刷新
            </Button>
          )}
        </div>

        {/* Error */}
        {error && (
          <Card className="bg-red-950/30 border-red-800 mb-6">
            <CardContent className="pt-6">
              <div className="flex items-start gap-3">
                <AlertCircle className="w-5 h-5 text-red-400 flex-shrink-0 mt-0.5" />
                <div>
                  <p className="text-red-400 font-medium text-sm mb-1">出错了</p>
                  <p className="text-red-300 font-mono text-xs break-all">{error}</p>
                </div>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Status panel */}
        {checkResult && (
          <Card className="bg-gray-900 border-gray-700 mb-6">
            <CardHeader className="pb-3">
              <CardTitle className="text-base flex items-center gap-2">
                {checkResult.needsUpdate ? (
                  <AlertCircle className="w-4 h-4 text-yellow-400" />
                ) : (
                  <CheckCircle2 className="w-4 h-4 text-green-400" />
                )}
                状态
                <span className="text-xs text-gray-500 font-normal ml-auto">
                  耗时 {checkResult.durationMs}ms
                </span>
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-sm">
              <Row label="官方最新版">
                <span className="font-mono">
                  {checkResult.latest.version || "未知"}
                </span>
                <span className="text-gray-500 ml-2 font-mono text-xs">
                  {shortCommit(checkResult.latest.commit)}
                </span>
              </Row>
              <Row label="镜像站缓存">
                {checkResult.cached ? (
                  <>
                    <span className="font-mono">
                      {checkResult.cached.version || "未知"}
                    </span>
                    <span className="text-gray-500 ml-2 font-mono text-xs">
                      {shortCommit(checkResult.cached.commit)}
                    </span>
                  </>
                ) : (
                  <span className="text-gray-500">无缓存</span>
                )}
              </Row>
              <Row label="文件名">
                <span className="font-mono text-xs">
                  {checkResult.latest.fileName || "—"}
                </span>
              </Row>
              <Row label="文件大小">
                <span className="font-mono">
                  {formatBytes(checkResult.latest.fileSize)}
                </span>
              </Row>
              {checkResult.cached && (
                <Row label="缓存时间">
                  <span className="font-mono text-xs">
                    {new Date(checkResult.cached.cachedAt).toLocaleString("zh-CN")}
                  </span>
                </Row>
              )}
              <Row label="结果">
                {checkResult.needsUpdate ? (
                  <span className="text-yellow-400">需要更新</span>
                ) : (
                  <span className="text-green-400">已是最新版，可直接下载</span>
                )}
                <span className="text-gray-600 ml-2 text-xs">({checkResult.reason})</span>
              </Row>
            </CardContent>
          </Card>
        )}

        {/* Cache card — always shown if there is a valid cache, even before any check */}
        {hasValidCache && cached && (
          <Card className="bg-gray-900 border-gray-700">
            <CardContent className="pt-6">
              <div className="flex items-center justify-between gap-4">
                <div className="min-w-0">
                  <p className="text-xs uppercase tracking-wider text-gray-500 mb-1">
                    当前缓存文件
                  </p>
                  <p className="font-mono text-sm truncate">{cached.fileName}</p>
                  <p className="text-xs text-gray-500 mt-1">
                    {cached.version || "未知"} · {formatBytes(cached.fileSize)} ·{" "}
                    {cached.chunkCount} 分片
                  </p>
                </div>
                <Button
                  onClick={handleDownload}
                  disabled={downloading}
                  className="bg-[#1c66e5] hover:bg-[#1c66e5]/90 text-white cursor-pointer flex-shrink-0"
                >
                  <Download className="w-4 h-4 mr-2" />
                  下载
                </Button>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Help / API docs */}
        <Card className="bg-gray-900/50 border-gray-800 mt-10">
          <CardContent className="pt-6 text-xs text-gray-500 space-y-2">
            <p className="text-gray-400 font-medium">API 列表（用于自动化测试）</p>
            <pre className="font-mono leading-relaxed overflow-x-auto">
{`GET  /koa                       API 说明
GET  /koa/api/platforms        平台列表
GET  /koa/api/latest?platform=  官方最新版信息
GET  /koa/api/status?platform=  镜像站缓存信息
GET  /koa/api/check?platform=   对比最新版与缓存
POST /koa/api/update-step?platform=  下载一个分片（前端循环调用）
POST /koa/api/auto-update?platform=   自动检查+下载（定时任务用）
GET  /koa/api/download-manifest?platform=  分片清单
GET  /koa/api/download-chunk?platform=&index=  下载单个分片
GET  /koa/api/changelog?force=<bool>   获取并缓存更新日志`}
            </pre>
          </CardContent>
        </Card>
      </main>

      {/* Footer */}
      <footer className="border-t border-gray-800 mt-16">
        <div className="container mx-auto px-6 py-6 text-center text-gray-500 text-xs space-y-1">
          <p>数据源：cursor.com 官方 API · 镜像缓存于 EdgeOne Pages Blob 存储</p>
          <p>本站仅做镜像缓存，不修改任何安装包内容 · 每天 0:00 自动同步最新版</p>
        </div>
      </footer>

      {/* Changelog modal */}
      {showChangelog && (
        <div
          className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4"
          onClick={() => setShowChangelog(false)}
        >
          <div
            className="bg-gray-900 border border-gray-700 rounded-lg max-w-2xl w-full max-h-[80vh] flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between px-6 py-4 border-b border-gray-800">
              <h3 className="text-base font-semibold flex items-center gap-2">
                <BookOpen className="w-4 h-4 text-[#1c66e5]" />
                Cursor 更新日志
                {changelog && (
                  <span className="text-xs text-gray-500 font-normal ml-2">
                    更新于 {new Date(changelog.fetchedAt).toLocaleString("zh-CN")}
                  </span>
                )}
              </h3>
              <div className="flex items-center gap-2">
                {changelog && (
                  <a
                    href={changelog.sourceUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-xs text-gray-400 hover:text-white transition-colors"
                  >
                    原文 ↗
                  </a>
                )}
                <button
                  onClick={() => setShowChangelog(false)}
                  className="text-gray-400 hover:text-white transition-colors cursor-pointer"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>
            </div>
            <div className="overflow-y-auto px-6 py-4 flex-1">
              {changelogLoading ? (
                <div className="flex items-center justify-center py-12">
                  <Loader2 className="w-6 h-6 animate-spin text-gray-400" />
                  <span className="ml-3 text-gray-400 text-sm">加载中…</span>
                </div>
              ) : changelog ? (
                <pre className="text-xs text-gray-300 whitespace-pre-wrap font-mono leading-relaxed">{changelog.text}</pre>
              ) : (
                <p className="text-gray-500 text-sm text-center py-12">无内容</p>
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
    <div className="flex justify-between items-center gap-4 py-1">
      <span className="text-gray-400">{label}</span>
      <span className="text-right truncate">{children}</span>
    </div>
  );
}
