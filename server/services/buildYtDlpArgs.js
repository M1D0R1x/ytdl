// Build yt-dlp argv from the new payload shape.
//
// payload = {
//   url, mode: 'both'|'video'|'audio',
//   quality: '1080'|'720'|...|'best'|'320'|'192'|...
//   container: 'mp4'|'mkv'|'webm'|'mp3'|'m4a'|'opus'|'wav'|'flac',
//   format_id (optional — overrides mode/quality),
//   subtitles: { enabled, langs:[], embed, auto },
//   embed: { thumbnail, metadata, chapters },
// }

const AUDIO_CONTAINERS = new Set(['mp3', 'm4a', 'opus', 'wav', 'flac']);

export function buildYtDlpArgs(payload, { outTpl, hasAria2c } = {}) {
  const {
    url,
    mode = 'both',
    quality = '1080',
    container,
    format_id,
    subtitles = {},
    embed = {},
  } = payload;

  const args = [];

  // ---- format selection ----
  if (format_id) {
    if (mode === 'audio') args.push('-f', format_id);
    else args.push('-f', `${format_id}+bestaudio/best`);
  } else if (mode === 'audio') {
    args.push('-f', 'bestaudio/best');
  } else if (mode === 'video') {
    const h = quality === 'best' ? null : parseInt(quality, 10);
    args.push('-f', h ? `bv*[height<=${h}]` : 'bv*');
  } else {
    // both
    if (quality === 'best') {
      args.push('-f', 'bv*+ba/best');
    } else {
      const h = parseInt(quality, 10) || 1080;
      args.push(
        '-f',
        `bv*[height<=${h}]+ba/b[height<=${h}]`,
      );
    }
  }

  // ---- output template ----
  if (outTpl) args.push('-o', outTpl);

  // ---- container / post-processing ----
  if (mode === 'audio') {
    const fmt = AUDIO_CONTAINERS.has(container) ? container : 'mp3';
    args.push('--extract-audio', '--audio-format', fmt);
    // quality is bitrate for audio mode
    const br = parseInt(quality, 10);
    if (Number.isFinite(br) && br > 0) {
      args.push('--audio-quality', `${br}K`);
    } else {
      args.push('--audio-quality', '0');
    }
  } else {
    const mergeFmt = container && ['mp4', 'mkv', 'webm'].includes(container) ? container : 'mp4';
    args.push('--merge-output-format', mergeFmt);
  }

  // ---- subtitles ----
  if (subtitles.enabled) {
    args.push('--write-subs');
    if (subtitles.auto) args.push('--write-auto-subs');
    if (Array.isArray(subtitles.langs) && subtitles.langs.length) {
      args.push('--sub-langs', subtitles.langs.join(','));
    } else {
      args.push('--sub-langs', 'en.*');
    }
    if (subtitles.embed && mode !== 'audio') args.push('--embed-subs');
  }

  // ---- thumbnail ----
  if (embed.thumbnail) {
    args.push('--write-thumbnail');
    if (mode === 'audio' || ['mp3', 'm4a', 'opus', 'flac'].includes(container)) {
      args.push('--embed-thumbnail');
    }
  }

  // ---- metadata / chapters ----
  if (embed.metadata) args.push('--embed-metadata');
  if (embed.chapters) args.push('--embed-chapters');

  // ---- baseline flags ----
  args.push(
    '--no-part',
    '--no-playlist',
    '--newline',
    '--progress',
    '--concurrent-fragments', '8',
    '--buffer-size', '16K',
    '--no-warnings',
  );

  if (hasAria2c) {
    args.push('--downloader', 'aria2c', '--downloader-args', 'aria2c:-x16 -s16 -k1M');
  }

  args.push(url);
  return args;
}
