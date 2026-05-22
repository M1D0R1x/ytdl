import React, { useEffect, useMemo, useRef, useState } from 'react';
import { io } from 'socket.io-client';

/* ----------------------- helpers ----------------------- */
function uuid() { return (crypto.randomUUID?.() || Math.random().toString(36).slice(2)); }
function fmtBytes(n) {
  if (!n) return '—';
  const u = ['B','KB','MB','GB']; let i = 0; while (n >= 1024 && i < u.length-1) { n /= 1024; i++; }
  return `${n.toFixed(1)} ${u[i]}`;
}
function fmtDur(s) {
  if (!s) return '—'; s = Math.floor(s);
  const h = Math.floor(s/3600), m = Math.floor((s%3600)/60), sec = s%60;
  return h ? `${h}:${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}` : `${m}:${String(sec).padStart(2,'0')}`;
}

/* mode-aware quality options */
const VIDEO_QUALITIES = [
  { id: 'best', label: 'BEST' },
  { id: '4320', label: '8K' },
  { id: '2160', label: '4K' },
  { id: '1440', label: '1440p' },
  { id: '1080', label: '1080p' },
  { id: '720', label: '720p' },
  { id: '480', label: '480p' },
  { id: '360', label: '360p' },
  { id: '240', label: '240p' },
  { id: '144', label: '144p' },
];
const AUDIO_BITRATES = [
  { id: '320', label: '320 kbps' },
  { id: '256', label: '256 kbps' },
  { id: '192', label: '192 kbps' },
  { id: '128', label: '128 kbps' },
  { id: '64',  label: '64 kbps' },
];
const VIDEO_CONTAINERS = ['mp4', 'mkv', 'webm'];
const AUDIO_CONTAINERS = ['mp3', 'm4a', 'opus', 'wav', 'flac'];

function estimateSize({ mode, quality, formats, duration }) {
  if (!Array.isArray(formats) || !formats.length) {
    // pure audio estimate from bitrate × duration
    if (mode === 'audio' && duration) {
      const br = parseInt(quality, 10);
      if (br) return (br * 1000 / 8) * duration; // bytes
    }
    return null;
  }
  const audios = formats.filter((f) => f.type === 'audio' && f.filesize);
  const bestAudio = audios.sort((a, b) => (b.filesize || 0) - (a.filesize || 0))[0];

  if (mode === 'audio') {
    if (duration) {
      const br = parseInt(quality, 10);
      if (br) return (br * 1000 / 8) * duration;
    }
    return bestAudio?.filesize || null;
  }
  let cap = Infinity;
  if (quality !== 'best') cap = parseInt(quality, 10) || Infinity;
  const videos = formats
    .filter((f) => (f.type === 'video' || f.type === 'muxed') && f.height && f.height <= cap && f.filesize)
    .sort((a, b) => (b.height - a.height) || ((b.filesize || 0) - (a.filesize || 0)));
  const v = videos[0];
  if (!v) return null;
  if (mode === 'video') return v.type === 'muxed' ? Math.round(v.filesize * 0.92) : v.filesize;
  return v.type === 'muxed' ? v.filesize : v.filesize + (bestAudio?.filesize || 0);
}

/* ----------------------- app ----------------------- */
export default function App() {
  const [url, setUrl] = useState('');
  const [info, setInfo] = useState(null);
  const [loading, setLoading] = useState(false);
  const [jobs, setJobs] = useState([]);
  const [progressMap, setProgressMap] = useState({});
  const [toasts, setToasts] = useState([]);
  const [showQueue, setShowQueue] = useState(true);

  // shared config
  const [mode, setMode] = useState('both');                // 'both' | 'video' | 'audio'
  const [quality, setQuality] = useState('1080');
  const [container, setContainer] = useState('mp4');
  const [subs, setSubs] = useState({ enabled: false, langs: ['en'], embed: false, auto: false });
  const [embed, setEmbed] = useState({ thumbnail: false, metadata: true, chapters: false });

  // batch state
  const [batchMode, setBatchMode] = useState(false);
  const [batchTitle, setBatchTitle] = useState('');
  const [batchItems, setBatchItems] = useState([]);        // [{url,title,thumbnail,duration,formats,subtitles}]
  const [batchUrlInput, setBatchUrlInput] = useState('');
  const [adding, setAdding] = useState(false);

  const socketRef = useRef(null);

  useEffect(() => {
    const s = io({ path: '/socket.io' });
    socketRef.current = s;
    s.on('connect', () => toast('LINK ESTABLISHED', 'ok'));
    s.on('queue:update', refreshQueue);
    s.on('job:progress', (p) => setProgressMap((m) => ({ ...m, [p.jobId]: p })));
    s.on('job:done', (p) => {
      setProgressMap((m) => ({ ...m, [p.jobId]: { ...m[p.jobId], percent: 100, done: true } }));
      toast(`READY ▸ ${p.jobId}`, 'ok');
      const a = document.createElement('a');
      a.href = `/api/download/${p.jobId}/file`;
      a.download = '';
      document.body.appendChild(a); a.click(); a.remove();
    });
    s.on('job:error', (p) => toast(`ERR ▸ ${p.message}`, 'err'));
    refreshQueue();
    return () => s.disconnect();
  }, []);

  // keyboard shortcuts
  useEffect(() => {
    const h = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'b') {
        e.preventDefault(); toggleBatchMode();
      } else if (e.key === 'Escape' && batchMode) {
        cancelBatch();
      }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [batchMode]);

  // re-pick default quality/container when mode changes
  useEffect(() => {
    if (mode === 'audio') {
      if (!AUDIO_BITRATES.find((q) => q.id === quality)) setQuality('192');
      if (!AUDIO_CONTAINERS.includes(container)) setContainer('mp3');
    } else {
      if (!VIDEO_QUALITIES.find((q) => q.id === quality)) setQuality('1080');
      if (!VIDEO_CONTAINERS.includes(container)) setContainer('mp4');
    }
  }, [mode]);

  function toast(msg, kind='ok') {
    const id = uuid();
    setToasts((t) => [...t, { id, msg, kind }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 4000);
  }

  async function refreshQueue() {
    try {
      const r = await fetch('/api/queue').then((r) => r.json());
      setJobs(r.jobs || []);
    } catch {}
  }

  async function apiFetchInfo(targetUrl) {
    const r = await fetch('/api/fetch-info', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: targetUrl }),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'failed');
    return data;
  }

  async function fetchInfo() {
    if (!url) return;
    setLoading(true); setInfo(null);
    try { setInfo(await apiFetchInfo(url)); toast('METADATA ACQUIRED', 'ok'); }
    catch (e) { toast(e.message, 'err'); }
    finally { setLoading(false); }
  }

  function buildPayload(extra = {}) {
    return {
      mode, quality, container,
      subtitles: subs,
      embed,
      ...extra,
    };
  }

  /* ---------- single download ---------- */
  async function startDownload(targetUrl = url, meta = {}) {
    try {
      const r = await fetch('/api/download', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(buildPayload({ url: targetUrl, ...meta })),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || 'failed');
      socketRef.current?.emit('subscribe', data.job_id);
      toast(`QUEUED ▸ ${data.job_id}`, 'ok');
      refreshQueue();
    } catch (e) { toast(e.message, 'err'); }
  }

  /* ---------- batch ---------- */
  function toggleBatchMode() {
    setBatchMode((b) => {
      const next = !b;
      if (next) {
        setBatchTitle(`Batch ${new Date().toLocaleString()}`);
        setBatchItems([]);
      }
      return next;
    });
  }
  function cancelBatch() {
    setBatchMode(false); setBatchItems([]); setBatchUrlInput('');
  }
  async function addBatchUrl() {
    const u = batchUrlInput.trim();
    if (!u) return;
    if (batchItems.some((x) => x.url === u)) { toast('ALREADY IN BATCH', 'err'); return; }
    setAdding(true);
    try {
      const data = await apiFetchInfo(u);
      if (data.type === 'playlist') {
        const items = data.entries.map((e) => ({
          url: e.url, title: e.title, thumbnail: null, duration: e.duration, formats: [],
        }));
        setBatchItems((arr) => [...arr, ...items]);
        toast(`+${items.length} FROM PLAYLIST`, 'ok');
      } else {
        setBatchItems((arr) => [...arr, {
          url: u, title: data.title, thumbnail: data.thumbnail,
          duration: data.duration, formats: data.formats,
        }]);
        toast('ADDED', 'ok');
      }
      setBatchUrlInput('');
    } catch (e) { toast(e.message, 'err'); }
    finally { setAdding(false); }
  }
  function removeBatchItem(u) {
    setBatchItems((arr) => arr.filter((x) => x.url !== u));
  }
  async function downloadAll() {
    if (!batchItems.length) { toast('BATCH IS EMPTY', 'err'); return; }
    try {
      const r = await fetch('/api/download', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(buildPayload({
          items: batchItems.map((b) => ({ url: b.url, title: b.title, thumbnail: b.thumbnail })),
          groupId: uuid(),
          groupTitle: batchTitle || 'Batch',
        })),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || 'failed');
      toast(`QUEUED ▸ ${data.job_ids?.length || 0} JOBS`, 'ok');
      data.job_ids?.forEach((id) => socketRef.current?.emit('subscribe', id));
      refreshQueue();
      cancelBatch();
    } catch (e) { toast(e.message, 'err'); }
  }

  async function cancelJob(id) {
    await fetch(`/api/job/${id}`, { method: 'DELETE' });
    refreshQueue();
  }

  const qualityOptions = mode === 'audio' ? AUDIO_BITRATES : VIDEO_QUALITIES;
  const containerOptions = mode === 'audio' ? AUDIO_CONTAINERS : VIDEO_CONTAINERS;

  return (
    <div className="min-h-full flex flex-col">
      <Header
        batchMode={batchMode}
        onToggleBatch={toggleBatchMode}
        onCopy={() => { navigator.clipboard.writeText(url); toast('COPIED', 'ok'); }}
      />

      <main className="flex-1 px-4 md:px-10 pb-32 max-w-6xl w-full mx-auto">
        <h1 className="text-2xl md:text-4xl mt-8 neon-text cursor">root@neon:~$ ytdl --target</h1>
        <p className="text-cyan/70 text-sm mt-2">
          paste a youtube URL, pick a quality, and let the daemon do its thing.
          <span className="text-neon/50 ml-2">[⌘/Ctrl+B = batch mode]</span>
        </p>

        {!batchMode && (
          <>
            <div className="pulse-border mt-8 border border-neon/40 bg-black/60 rounded-md flex items-stretch focus-within:border-neon">
              <span className="px-4 py-4 text-neon/60 select-none">▸</span>
              <input
                value={url} onChange={(e) => setUrl(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && fetchInfo()}
                placeholder="https://www.youtube.com/watch?v=..."
                className="flex-1 bg-transparent outline-none py-4 pr-3 text-neon placeholder:text-neon/30"
              />
              <button
                onClick={fetchInfo} disabled={loading}
                className="px-5 md:px-8 border-l border-neon/40 hover:bg-neon hover:text-black transition-colors text-xs md:text-sm tracking-widest"
              >
                {loading ? <span className="cursor">PROCESSING</span> : 'INITIALIZE'}
              </button>
            </div>

            {info && info.type === 'video' && (
              <section className="mt-8 space-y-6">
                <VideoCard info={info} />
                <ConfigPanel
                  mode={mode} setMode={setMode}
                  quality={quality} setQuality={setQuality}
                  qualityOptions={qualityOptions}
                  container={container} setContainer={setContainer}
                  containerOptions={containerOptions}
                  subs={subs} setSubs={setSubs}
                  embed={embed} setEmbed={setEmbed}
                  availableSubs={info.subtitles || []}
                  availableAutoSubs={info.auto_subtitles || []}
                  formats={info.formats}
                  duration={info.duration}
                />
                <button
                  onClick={() => startDownload(url, { title: info.title, thumbnail: info.thumbnail })}
                  className="w-full md:w-auto px-8 py-3 border-2 border-neon bg-neon/10 hover:bg-neon hover:text-black text-neon tracking-widest text-sm shadow-neon transition-all"
                >
                  ▸ DOWNLOAD
                </button>
              </section>
            )}
            {info && info.type === 'playlist' && (
              <PlaylistView
                info={info}
                onDownloadOne={(u, t) => startDownload(u, { title: t })}
                onSendToBatch={() => {
                  setBatchMode(true);
                  setBatchTitle(info.title || 'Playlist');
                  setBatchItems(info.entries.map((e) => ({
                    url: e.url, title: e.title, duration: e.duration, formats: [],
                  })));
                  toast(`SENT ${info.entries.length} TO BATCH`, 'ok');
                }}
              />
            )}
          </>
        )}

        {batchMode && (
          <BatchPanel
            title={batchTitle} setTitle={setBatchTitle}
            items={batchItems}
            onRemove={removeBatchItem}
            urlInput={batchUrlInput} setUrlInput={setBatchUrlInput}
            adding={adding} onAdd={addBatchUrl}
            mode={mode} setMode={setMode}
            quality={quality} setQuality={setQuality}
            qualityOptions={qualityOptions}
            container={container} setContainer={setContainer}
            containerOptions={containerOptions}
            subs={subs} setSubs={setSubs}
            embed={embed} setEmbed={setEmbed}
            onDownloadAll={downloadAll} onCancel={cancelBatch}
          />
        )}
      </main>

      <QueuePanel
        jobs={jobs} progressMap={progressMap} open={showQueue}
        onToggle={() => setShowQueue((s) => !s)} onCancel={cancelJob}
      />

      <div className="fixed top-4 right-4 z-50 space-y-2">
        {toasts.map((t) => (
          <div key={t.id}
            className={`px-3 py-2 border text-xs neon-text ${t.kind==='err' ? 'border-magenta text-magenta animate-pulse' : 'border-neon text-neon'}`}>
            ▸ {t.msg}
          </div>
        ))}
      </div>
    </div>
  );
}

/* ----------------------- chrome ----------------------- */
function Header({ batchMode, onToggleBatch, onCopy }) {
  return (
    <header className="border-b border-neon/30 px-4 md:px-10 py-3 flex items-center justify-between bg-black/70 backdrop-blur sticky top-0 z-40">
      <div className="flex items-center gap-3">
        <div className="w-3 h-3 rounded-full bg-magenta shadow-[0_0_10px_#ff0080]" />
        <div className="w-3 h-3 rounded-full bg-cyan shadow-[0_0_10px_#00d4ff]" />
        <div className="w-3 h-3 rounded-full bg-neon shadow-[0_0_10px_#00ff88]" />
        <span className="ml-3 text-cyan tracking-[0.3em] text-xs">NEON://YTDL.SYS</span>
      </div>
      <div className="flex items-center gap-3">
        <button
          onClick={onToggleBatch}
          className={`text-xs tracking-widest border px-3 py-1.5 transition-all ${
            batchMode
              ? 'border-neon text-black bg-neon shadow-neon'
              : 'border-neon/40 text-neon/80 hover:border-neon hover:text-neon'
          }`}
          title="⌘/Ctrl+B"
        >
          {batchMode ? '◉ BATCH MODE' : '○ START BATCH'}
        </button>
        <button onClick={onCopy} className="text-xs text-neon/70 hover:text-neon">[COPY URL]</button>
      </div>
    </header>
  );
}

function VideoCard({ info }) {
  return (
    <div className="border border-neon/40 bg-black/60 grid md:grid-cols-[280px,1fr] gap-6 p-4 md:p-6">
      <div className="overflow-hidden border border-neon/20 glitch">
        <img src={info.thumbnail} alt="" className="w-full h-full object-cover" />
      </div>
      <div className="space-y-3">
        <h2 className="text-cyan neon-text text-lg md:text-xl break-words">{info.title}</h2>
        <div className="text-xs text-neon/70 grid grid-cols-2 md:grid-cols-3 gap-2">
          <span>UPLOADER: {info.uploader || '—'}</span>
          <span>DURATION: {fmtDur(info.duration)}</span>
          <span>VIEWS: {info.view_count?.toLocaleString() || '—'}</span>
          <span>FORMATS: {info.formats?.length || 0}</span>
          <span>SUBS: {info.subtitles?.length || 0}</span>
          <span>AUTO-SUBS: {info.auto_subtitles?.length || 0}</span>
        </div>
      </div>
    </div>
  );
}

/* ----------------------- config panel ----------------------- */
function ConfigPanel(props) {
  const {
    mode, setMode,
    quality, setQuality, qualityOptions,
    container, setContainer, containerOptions,
    subs, setSubs, embed, setEmbed,
    availableSubs, availableAutoSubs,
    formats, duration,
  } = props;

  return (
    <div className="border border-neon/40 bg-black/60 p-4 md:p-6 space-y-5">
      <StreamTypeToggle mode={mode} setMode={setMode} />
      <QualityPicker
        mode={mode} quality={quality} setQuality={setQuality}
        options={qualityOptions} formats={formats} duration={duration}
      />
      <div className="flex items-center gap-3">
        <label className="text-xs text-neon/60 tracking-widest">CONTAINER</label>
        <select
          value={container} onChange={(e) => setContainer(e.target.value)}
          className="bg-black border border-neon/40 text-neon px-3 py-1.5 text-xs focus:border-neon outline-none"
        >
          {containerOptions.map((c) => <option key={c} value={c}>{c.toUpperCase()}</option>)}
        </select>
      </div>
      <SubtitlePicker
        subs={subs} setSubs={setSubs}
        available={availableSubs} availableAuto={availableAutoSubs}
        disabled={mode === 'audio'}
      />
      <EmbedOptions embed={embed} setEmbed={setEmbed} mode={mode} container={container} />
    </div>
  );
}

function StreamTypeToggle({ mode, setMode }) {
  const opts = [
    { id: 'both',  label: 'VIDEO + AUDIO' },
    { id: 'video', label: 'VIDEO ONLY' },
    { id: 'audio', label: 'AUDIO ONLY' },
  ];
  return (
    <div>
      <div className="text-xs text-neon/60 tracking-widest mb-2">STREAM TYPE</div>
      <div className="grid grid-cols-3 gap-2">
        {opts.map((o) => (
          <button key={o.id} onClick={() => setMode(o.id)}
            className={`py-2 text-xs border tracking-widest transition-all ${
              mode === o.id
                ? 'border-neon bg-neon text-black shadow-neon'
                : 'border-neon/30 text-neon/80 hover:border-neon'
            }`}>
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function QualityPicker({ mode, quality, setQuality, options, formats, duration }) {
  return (
    <div>
      <div className="text-xs text-neon/60 tracking-widest mb-2">
        {mode === 'audio' ? 'BITRATE' : 'RESOLUTION'}
      </div>
      <div className="flex flex-wrap gap-2">
        {options.map((q) => {
          const size = estimateSize({ mode, quality: q.id, formats, duration });
          return (
            <button key={q.id} onClick={() => setQuality(q.id)}
              className={`px-3 py-1.5 text-xs border transition-all flex flex-col items-start leading-tight min-w-[78px] ${
                quality === q.id ? 'border-neon bg-neon text-black' : 'border-neon/30 text-neon/80 hover:border-neon'
              }`}>
              <span>{q.label}</span>
              <span className={`text-[10px] ${quality === q.id ? 'text-black/70' : 'text-neon/50'}`}>
                {size ? `~${fmtBytes(size)}` : 'size n/a'}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function SubtitlePicker({ subs, setSubs, available, availableAuto, disabled }) {
  const all = useMemo(() => {
    const set = new Set([...(available || []), ...(availableAuto || [])]);
    return Array.from(set).sort();
  }, [available, availableAuto]);

  return (
    <div className={disabled ? 'opacity-40 pointer-events-none' : ''}>
      <div className="text-xs text-neon/60 tracking-widest mb-2">SUBTITLES</div>
      <label className="flex items-center gap-2 text-xs text-neon/80 cursor-pointer">
        <input type="checkbox" checked={subs.enabled}
          onChange={(e) => setSubs({ ...subs, enabled: e.target.checked })}
          className="accent-[#00ff88]" />
          download subtitles
      </label>
      {subs.enabled && (
        <div className="mt-3 pl-5 space-y-2">
          <div className="flex flex-wrap gap-1.5">
            {(all.length ? all : ['en','es','fr','de','ja','pt','ru','ar','hi','zh']).slice(0, 24).map((l) => {
              const on = subs.langs.includes(l);
              return (
                <button key={l} onClick={() => {
                  setSubs({ ...subs, langs: on ? subs.langs.filter((x) => x !== l) : [...subs.langs, l] });
                }}
                  className={`px-2 py-0.5 text-[10px] border ${on ? 'border-cyan bg-cyan text-black' : 'border-cyan/30 text-cyan/70 hover:border-cyan'}`}>
                  {l}
                </button>
              );
            })}
          </div>
          <label className="flex items-center gap-2 text-xs text-neon/80 cursor-pointer">
            <input type="checkbox" checked={subs.embed}
              onChange={(e) => setSubs({ ...subs, embed: e.target.checked })}
              className="accent-[#00ff88]" />
            embed into video (mkv recommended)
          </label>
          <label className="flex items-center gap-2 text-xs text-neon/80 cursor-pointer">
            <input type="checkbox" checked={subs.auto}
              onChange={(e) => setSubs({ ...subs, auto: e.target.checked })}
              className="accent-[#00ff88]" />
            include auto-generated captions
          </label>
        </div>
      )}
    </div>
  );
}

function EmbedOptions({ embed, setEmbed, mode, container }) {
  const cb = (k, label, hint) => (
    <label className="flex items-center gap-2 text-xs text-neon/80 cursor-pointer">
      <input type="checkbox" checked={!!embed[k]}
        onChange={(e) => setEmbed({ ...embed, [k]: e.target.checked })}
        className="accent-[#00ff88]" />
      {label} {hint && <span className="text-neon/40 text-[10px]">{hint}</span>}
    </label>
  );
  return (
    <div>
      <div className="text-xs text-neon/60 tracking-widest mb-2">EMBED</div>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
        {cb('thumbnail', 'thumbnail', mode === 'audio' ? '(into audio file)' : '')}
        {cb('metadata', 'metadata', '(title / artist / album)')}
        {cb('chapters', 'chapters', '(if available)')}
      </div>
    </div>
  );
}

/* ----------------------- batch panel ----------------------- */
function BatchPanel(props) {
  const {
    title, setTitle, items, onRemove,
    urlInput, setUrlInput, adding, onAdd,
    mode, setMode, quality, setQuality, qualityOptions,
    container, setContainer, containerOptions,
    subs, setSubs, embed, setEmbed,
    onDownloadAll, onCancel,
  } = props;

  return (
    <section className="mt-8 border-2 border-neon bg-black/60 shadow-neon p-4 md:p-6 space-y-5">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-3 flex-1 min-w-0">
          <span className="text-neon/70 text-xs tracking-widest">BATCH ▸</span>
          <input
            value={title} onChange={(e) => setTitle(e.target.value)}
            className="flex-1 bg-transparent border-b border-neon/30 focus:border-neon text-cyan neon-text outline-none py-1 text-sm"
          />
          <span className="text-neon/60 text-xs">{items.length} ITEMS</span>
        </div>
        <button onClick={onCancel} className="text-xs text-magenta border border-magenta/50 px-3 py-1 hover:bg-magenta hover:text-black">
          CANCEL BATCH
        </button>
      </div>

      {/* add URL */}
      <div className="border border-neon/40 bg-black/60 flex items-stretch">
        <span className="px-3 py-2 text-neon/60">+</span>
        <input
          value={urlInput} onChange={(e) => setUrlInput(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && onAdd()}
          placeholder="paste URL and press Enter…"
          className="flex-1 bg-transparent outline-none text-neon placeholder:text-neon/30 text-sm"
        />
        <button onClick={onAdd} disabled={adding}
          className="px-4 border-l border-neon/40 text-xs tracking-widest hover:bg-neon hover:text-black">
          {adding ? <span className="cursor">ADDING</span> : 'ADD'}
        </button>
      </div>

      {/* URL list */}
      <div className="space-y-2 max-h-72 overflow-y-auto scrollbar">
        {items.length === 0 && (
          <div className="text-center text-neon/40 text-xs py-8 border border-dashed border-neon/20">
            no URLs yet — paste one above
          </div>
        )}
        {items.map((it) => (
          <div key={it.url} className="flex items-center gap-3 border border-neon/20 hover:border-neon/60 bg-black/40 p-2 group">
            {it.thumbnail ? (
              <img src={it.thumbnail} alt="" className="w-16 h-10 object-cover border border-neon/30" />
            ) : (
              <div className="w-16 h-10 border border-neon/20 grid place-items-center text-neon/40 text-[10px]">—</div>
            )}
            <div className="flex-1 min-w-0">
              <div className="text-cyan text-xs truncate">{it.title || it.url}</div>
              <div className="text-neon/50 text-[10px] truncate">{it.url}</div>
            </div>
            <span className="text-neon/60 text-[10px]">{fmtDur(it.duration)}</span>
            <button onClick={() => onRemove(it.url)}
              className="text-magenta border border-magenta/30 px-2 py-1 text-[10px] opacity-60 group-hover:opacity-100 hover:bg-magenta hover:text-black">
              ✕
            </button>
          </div>
        ))}
      </div>

      {/* shared config */}
      <ConfigPanel
        mode={mode} setMode={setMode}
        quality={quality} setQuality={setQuality}
        qualityOptions={qualityOptions}
        container={container} setContainer={setContainer}
        containerOptions={containerOptions}
        subs={subs} setSubs={setSubs}
        embed={embed} setEmbed={setEmbed}
        availableSubs={[]} availableAutoSubs={[]}
        formats={[]} duration={null}
      />

      <button onClick={onDownloadAll}
        disabled={!items.length}
        className="w-full px-8 py-3 border-2 border-neon bg-neon/10 hover:bg-neon hover:text-black text-neon tracking-widest text-sm shadow-neon transition-all disabled:opacity-40 disabled:cursor-not-allowed">
        ▸ DOWNLOAD ALL ({items.length})
      </button>
    </section>
  );
}

/* ----------------------- playlist view ----------------------- */
function PlaylistView({ info, onDownloadOne, onSendToBatch }) {
  return (
    <section className="mt-8 border border-neon/40 bg-black/60 p-4 md:p-6 space-y-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <h2 className="text-cyan neon-text">{info.title} <span className="text-neon/50 text-xs">({info.count} items)</span></h2>
        <button onClick={onSendToBatch}
          className="text-xs tracking-widest border border-neon px-3 py-1.5 hover:bg-neon hover:text-black">
          ▸ SEND ALL TO BATCH
        </button>
      </div>
      <div className="max-h-96 overflow-y-auto scrollbar divide-y divide-neon/10">
        {info.entries.map((e) => (
          <div key={e.id} className="flex items-center justify-between gap-2 py-2">
            <div className="text-xs text-neon/80 truncate">{e.title}</div>
            <button onClick={() => onDownloadOne(e.url, e.title)}
              className="text-[10px] border border-neon/40 px-2 py-1 hover:bg-neon hover:text-black tracking-widest">
              GET
            </button>
          </div>
        ))}
      </div>
    </section>
  );
}

/* ----------------------- queue panel ----------------------- */
function QueuePanel({ jobs, progressMap, open, onToggle, onCancel }) {
  // group by groupId
  const groups = useMemo(() => {
    const g = new Map(); const single = [];
    for (const j of jobs) {
      const gid = j.data?.groupId;
      if (gid) {
        if (!g.has(gid)) g.set(gid, { title: j.data.groupTitle || 'Batch', jobs: [] });
        g.get(gid).jobs.push(j);
      } else single.push(j);
    }
    for (const grp of g.values()) grp.jobs.sort((a,b) => (a.data.orderInGroup||0)-(b.data.orderInGroup||0));
    return { groups: Array.from(g.entries()), single };
  }, [jobs]);

  return (
    <aside className={`fixed bottom-0 left-0 right-0 z-30 border-t-2 border-neon/50 bg-black/95 backdrop-blur transition-transform ${open ? 'translate-y-0' : 'translate-y-[calc(100%-2.5rem)]'}`}>
      <div className="flex items-center justify-between px-4 md:px-10 py-2 cursor-pointer" onClick={onToggle}>
        <div className="flex items-center gap-3">
          <span className="text-neon neon-text tracking-widest text-xs">▸ QUEUE [{jobs.length}]</span>
          <span className="text-cyan/60 text-[10px]">click to {open ? 'collapse' : 'expand'}</span>
        </div>
        <span className="text-neon/60 text-xs">{open ? '▼' : '▲'}</span>
      </div>
      <div className="max-h-[40vh] overflow-y-auto scrollbar px-4 md:px-10 pb-4 space-y-3">
        {jobs.length === 0 && <div className="text-neon/40 text-xs py-4">queue is empty.</div>}

        {groups.groups.map(([gid, g]) => (
          <div key={gid} className="border border-neon/30 p-2">
            <div className="text-cyan text-xs tracking-widest mb-2">▣ {g.title} ({g.jobs.length})</div>
            <div className="space-y-1.5 pl-3 border-l border-neon/20">
              {g.jobs.map((j) => <JobRow key={j.id} job={j} progress={progressMap[j.id]} onCancel={onCancel} compact />)}
            </div>
          </div>
        ))}
        {groups.single.map((j) => (
          <JobRow key={j.id} job={j} progress={progressMap[j.id]} onCancel={onCancel} />
        ))}
      </div>
    </aside>
  );
}

function JobRow({ job, progress, onCancel, compact }) {
  const p = progress?.percent ?? job.progress ?? 0;
  const state = progress?.done ? 'completed' : job.state;
  const badge = {
    completed: 'border-neon text-neon',
    active: 'border-cyan text-cyan animate-pulse',
    waiting: 'border-neon/40 text-neon/60',
    failed: 'border-magenta text-magenta',
  }[state] || 'border-neon/30 text-neon/60';

  const title = job.data.title || job.data.url;

  return (
    <div className={`grid grid-cols-[1fr,auto] gap-2 items-center ${compact ? '' : 'border border-neon/20 p-2'}`}>
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span className={`text-[10px] border px-1.5 py-0.5 ${badge}`}>{state}</span>
          <span className="text-neon/80 text-xs truncate">{title}</span>
        </div>
        <div className="mt-1 h-1.5 bg-neon/10 relative overflow-hidden">
          <div className="absolute inset-y-0 left-0 bg-neon shadow-neon transition-all"
               style={{ width: `${Math.min(100, p)}%` }} />
        </div>
        <div className="flex justify-between text-[10px] text-neon/50 mt-0.5">
          <span>{job.data.mode?.toUpperCase() || 'BOTH'} · {job.data.quality || ''} {job.data.container ? `· ${job.data.container}` : ''}</span>
          <span>{p.toFixed(0)}% {progress?.speed ? `· ${progress.speed}` : ''} {progress?.eta ? `· ETA ${progress.eta}` : ''}</span>
        </div>
      </div>
      <div className="flex gap-1">
        {state === 'completed' && (
          <a href={`/api/download/${job.id}/file`} download
            className="text-[10px] border border-neon px-2 py-1 hover:bg-neon hover:text-black">SAVE</a>
        )}
        <button onClick={() => onCancel(job.id)}
          className="text-[10px] border border-magenta/40 text-magenta px-2 py-1 hover:bg-magenta hover:text-black">✕</button>
      </div>
    </div>
  );
}
