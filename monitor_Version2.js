const fs = require('fs');
const path = require('path');
const axios = require('axios');
const FormData = require('form-data');

const CONFIG_FILE = path.resolve(__dirname, 'config.json');
const SEEN_FILE = path.resolve(__dirname, 'seen.json');

if (!fs.existsSync(CONFIG_FILE)) {
  console.error('Missing config.json. Copy config.example.json -> config.json and edit it.');
  process.exit(1);
}

const config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
const {
  artistUrl,
  webhookUrl,
  pollIntervalSeconds = 60,
  pagesToCheck = 1,
  sendExistingOnFirstRun = false,
  userAgent = 'RobloxArtistMonitor/1.0',
  maxFileSizeMB = 8
} = config;

if (!artistUrl || !webhookUrl) {
  console.error('Please set artistUrl and webhookUrl in config.json');
  process.exit(1);
}

const MAX_FILE_BYTES = Math.max(0, Number(maxFileSizeMB)) * 1024 * 1024;

let seen = new Set();
let isFirstRun = true;
if (fs.existsSync(SEEN_FILE)) {
  try {
    const data = JSON.parse(fs.readFileSync(SEEN_FILE, 'utf8'));
    if (Array.isArray(data)) data.forEach(id => seen.add(String(id)));
  } catch (e) {
    console.warn('Could not parse seen.json, starting fresh.');
  }
}

function saveSeen() {
  fs.writeFileSync(SEEN_FILE, JSON.stringify(Array.from(seen), null, 2));
}

async function fetchUrl(url, opts = {}) {
  try {
    const res = await axios.get(url, {
      headers: { 'User-Agent': userAgent, Accept: 'text/html,application/xhtml+xml' },
      timeout: 20000,
      ...opts
    });
    return res.data;
  } catch (err) {
    console.error(`Error fetching ${url}:`, err.message || err);
    return null;
  }
}

function extractAssetIdsFromHtml(html) {
  const ids = new Set();
  const regex = /\/store\/asset\/(\d+)(?:\/[^\s"'<>]*)?/g;
  let m;
  while ((m = regex.exec(html)) !== null) {
    ids.add(m[1]);
  }
  const fullRegex = /https?:\/\/create\.roblox\.com\/store\/asset\/(\d+)(?:\/[^\s"'<>]*)?/g;
  while ((m = fullRegex.exec(html)) !== null) {
    ids.add(m[1]);
  }
  return Array.from(ids);
}

function extractTitleFromHtml(html, fallbackId) {
  let title = null;
  const ogMatch = html.match(/<meta\s+property=["']og:title["']\s+content=["']([^"']+)["']/i);
  if (ogMatch) title = ogMatch[1].trim();
  if (!title) {
    const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
    if (titleMatch) title = titleMatch[1].trim();
  }
  if (!title) title = `Asset ${fallbackId}`;
  return title;
}

function findAudioUrlInHtml(html) {
  if (!html) return null;
  // Try to find .mp3 or .ogg links in page HTML or JS config
  const audioRegex = /https?:\/\/[^"'<>]+?\.(mp3|ogg)(\?[^"'<>]*)?/ig;
  let m;
  const found = [];
  while ((m = audioRegex.exec(html)) !== null) {
    found.push(m[0]);
  }
  if (found.length > 0) {
    const mp3 = found.find(u => u.toLowerCase().includes('.mp3'));
    if (mp3) return mp3;
    return found[0];
  }

  const jsonUrlRegex = /(["'](?:audio|downloadUrl|source|url)["']\s*:\s*["'])(https?:\/\/[^"']+\.(mp3|ogg)(\?[^"']*)?)["']/ig;
  while ((m = jsonUrlRegex.exec(html)) !== null) {
    return m[2];
  }

  return null;
}

async function fetchAssetTitleAndAudio(assetId) {
  const assetUrl = `https://create.roblox.com/store/asset/${assetId}`;
  const html = await fetchUrl(assetUrl);
  if (!html) return { title: `Asset ${assetId}`, assetUrl, audioUrl: null };

  const title = extractTitleFromHtml(html, assetId);
  const audioUrl = findAudioUrlInHtml(html);
  return { title, assetUrl, audioUrl, html };
}

async function fetchAudioBuffer(audioUrl) {
  if (!audioUrl) return null;
  try {
    const res = await axios.get(audioUrl, {
      responseType: 'arraybuffer',
      headers: { 'User-Agent': userAgent, Accept: '*/*' },
      timeout: 20000,
      maxContentLength: Infinity,
      maxBodyLength: Infinity
    });
    const buffer = Buffer.from(res.data);
    const contentType = res.headers['content-type'] || '';
    return { buffer, contentType, size: buffer.length, url: audioUrl };
  } catch (err) {
    console.error(`Failed to download audio from ${audioUrl}:`, err.message || err);
    return null;
  }
}

async function sendDiscordWebhook(webhook, assetId, title, assetUrl, audioAttachment) {
  const embed = {
    title: title,
    url: assetUrl,
    description: `Roblox audio upload (asset id: ${assetId})`,
    timestamp: new Date().toISOString(),
    footer: { text: 'Roblox Artist Monitor' }
  };

  if (audioAttachment && audioAttachment.buffer && (MAX_FILE_BYTES === 0 || audioAttachment.size <= MAX_FILE_BYTES)) {
    try {
      const form = new FormData();
      form.append('payload_json', JSON.stringify({ embeds: [embed] }));
      let ext = '.bin';
      const ct = (audioAttachment.contentType || '').toLowerCase();
      if (ct.includes('mpeg') || ct.includes('mp3')) ext = '.mp3';
      else if (ct.includes('ogg')) ext = '.ogg';
      else {
        const m = audioAttachment.url && audioAttachment.url.match(/\.([a-z0-9]+)(?:\?|$)/i);
        if (m) ext = '.' + m[1];
      }
      const filename = `${assetId}${ext}`;
      form.append('file', audioAttachment.buffer, { filename });

      const headers = form.getHeaders();
      await axios.post(webhook, form, { headers, maxContentLength: Infinity, maxBodyLength: Infinity, timeout: 20000 });
      console.log(`Sent webhook with audio attachment for asset ${assetId} - ${title}`);
      return;
    } catch (err) {
      console.error(`Failed to send webhook with attachment for ${assetId}:`, err.message || err.response?.data || err);
    }
  } else if (audioAttachment && audioAttachment.buffer) {
    embed.fields = embed.fields || [];
    embed.fields.push({ name: 'Audio (too large to attach)', value: audioAttachment.url });
  }

  if (audioAttachment && audioAttachment.url && !(audioAttachment.buffer)) {
    embed.fields = embed.fields || [];
    embed.fields.push({ name: 'Audio URL', value: audioAttachment.url });
  }

  try {
    await axios.post(webhook, { embeds: [embed] }, {
      headers: { 'Content-Type': 'application/json' },
      timeout: 15000
    });
    console.log(`Sent embed webhook for asset ${assetId} - ${title}`);
  } catch (err) {
    console.error(`Failed to send embed webhook for ${assetId}:`, err.message || err.response?.data || err);
  }
}

function buildPageUrl(baseArtistUrl, pageNumber) {
  try {
    const u = new URL(baseArtistUrl);
    u.searchParams.set('pageNumber', String(pageNumber));
    return u.toString();
  } catch (e) {
    if (baseArtistUrl.includes('pageNumber=')) {
      return baseArtistUrl.replace(/pageNumber=\d+/, `pageNumber=${pageNumber}`);
    }
    const sep = baseArtistUrl.includes('?') ? '&' : '?';
    return `${baseArtistUrl}${sep}pageNumber=${pageNumber}`;
  }
}

async function scanOnce() {
  console.log(`[${new Date().toISOString()}] Scanning artist pages...`);
  let allIds = new Set();

  for (let p = 0; p < Math.max(1, pagesToCheck); p++) {
    const pageUrl = buildPageUrl(artistUrl, p);
    const html = await fetchUrl(pageUrl);
    if (!html) continue;
    const ids = extractAssetIdsFromHtml(html);
    ids.forEach(id => allIds.add(id));
  }

  const idsArray = Array.from(allIds).sort((a, b) => Number(b) - Number(a));
  if (idsArray.length === 0) {
    console.log('No assets found on artist pages.');
  }

  const newIds = idsArray.filter(id => !seen.has(String(id)));
  if (isFirstRun && !sendExistingOnFirstRun) {
    console.log(`First run: skipping existing ${idsArray.length} items (sendExistingOnFirstRun=false).`);
    idsArray.forEach(id => seen.add(String(id)));
    saveSeen();
  } else {
    for (const id of newIds) {
      try {
        const { title, assetUrl, audioUrl } = await fetchAssetTitleAndAudio(id);
        let audioAttachment = null;
        if (audioUrl) {
          const audioBuf = await fetchAudioBuffer(audioUrl);
          if (audioBuf) audioAttachment = audioBuf;
        }
        await sendDiscordWebhook(webhookUrl, id, title, assetUrl, audioAttachment);
        seen.add(String(id));
        saveSeen();
        await new Promise(r => setTimeout(r, 500));
      } catch (e) {
        console.error(`Error processing asset ${id}:`, e);
      }
    }
    if (newIds.length === 0) {
      console.log('No new assets to notify.');
    }
  }

  isFirstRun = false;
}

(async () => {
  console.log('Roblox Artist Monitor starting...');
  console.log(`Artist URL: ${artistUrl}`);
  console.log(`Polling every ${pollIntervalSeconds}s, checking ${pagesToCheck} page(s) each scan.`);
  console.log(`Max file attachment size: ${maxFileSizeMB} MB (0 = no limit)`);
  await scanOnce();
  setInterval(async () => {
    try {
      await scanOnce();
    } catch (e) {
      console.error('Scan error:', e);
    }
  }, Math.max(5, pollIntervalSeconds) * 1000);
})();