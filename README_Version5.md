```markdown
# Roblox Artist Monitor (with audio attachments)

Monitors a Roblox artist audio discovery page for uploads and sends notifications to a Discord webhook. This version will attempt to attach the mp3/ogg audio file to the webhook message when possible.

Features:
- Scans paginated artist pages for audio assets
- Sends Discord embed messages with link and title for each new upload
- Attempts to download the audio file (mp3/ogg) and attach it to the webhook
- If audio is larger than configured maxFileSizeMB, the monitor will include the audio URL in the embed instead of attaching the file
- Persists seen asset IDs to seen.json to avoid duplicate notifications
- Optionally send existing uploads on first run

Requirements:
- Node.js 16+ (tested with Node 18+)
- Internet access

Setup:
1. Copy `config.example.json` to `config.json` and edit:
   - `artistUrl`: artist discovery page (example: `https://create.roblox.com/store/audio/discoverNewAudio/distrokid-hits?artistName=SAD+Velvet&pageNumber=0`)
   - `https://discord.com/api/webhooks/1456400693132005489/N6ukYqPfflUyCp0JlnbkMKYXU77f4y_Z0HZ76n5ItoEtupe_F30tLSDRk48fd1Ojng5t`: your Discord webhook URL (don't commit this into the repo unless you understand the risks)
   - `pollIntervalSeconds`, `pagesToCheck`, `sendExistingOnFirstRun`
   - `maxFileSizeMB`: maximum size (MB) to attach to Discord (default 8). Set to 0 to disable size checks.
2. Install dependencies:
   ```bash
   npm install
   ```
3. Start:
   ```bash
   npm start
   ```

Notes & limitations:
- Discord webhook file upload limits apply (commonly 8 MB for non-Nitro servers). If the audio is larger than `maxFileSizeMB` the monitor will not attempt to upload it and will instead post the audio URL in the embed.
- The monitor finds audio URLs by scanning the asset HTML for .mp3/.ogg URLs or common JSON keys. If Roblox changes the asset page structure this may need adjustments.
- If a file upload fails, the script will fallback to sending the embed (with audio URL if available).
- The script stores seen asset IDs in `seen.json`. Delete it if you want to reset the history.

Possible enhancements:
- Use Roblox thumbnails or more metadata in embeds
- Use the official API (if available) to get stable audio URLs
- Add retry/backoff for downloads and more robust parsing

License: MIT
```