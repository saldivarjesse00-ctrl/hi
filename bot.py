import asyncio
import json
import os
import re
import requests
from langdetect import detect
from playwright.async_api import async_playwright, TimeoutError
import discord
from discord import app_commands
from discord.ext import commands

# ================= CONFIG =================
TOKEN = "MTQ1Njc3NTE1NDE1NDYwNjcyNQ.GtwZBO.c10z2PHo4Y_ww2uGAc9E_kxmCOtUlELtTQCuTI"
CHANNEL_NAME = "free-logger-stuff-shows-here"

PROFILE_DIR = "roblox_profile"
DOWNLOAD_DIR = "downloads"
DATA_FILE = "monitored_artists.json"

CHECK_INTERVAL = 2
SCROLL_TIMES = 6

MONITOR_TABS = 20
SEARCH_TABS = 20
# =========================================

os.makedirs(DOWNLOAD_DIR, exist_ok=True)

# ---------------- DATA ----------------
if os.path.exists(DATA_FILE):
    with open(DATA_FILE, "r", encoding="utf-8") as f:
        data = json.load(f)
else:
    data = {}  # {artist: [asset_ids]}

def save_data():
    with open(DATA_FILE, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2)

# ---------------- HELPERS ----------------
def detect_language(text):
    try:
        return detect(text)
    except:
        return "unknown"

def download_audio(asset_id):
    url = f"https://assetdelivery.roblox.com/v1/asset?id={asset_id}"
    path = os.path.join(DOWNLOAD_DIR, f"{asset_id}.ogg")
    try:
        r = requests.get(url, timeout=30)
        if r.status_code == 200:
            with open(path, "wb") as f:
                f.write(r.content)
            return path
    except:
        pass
    return None

async def send_to_channel(channel, name, artist, asset_id, url, lang, image, audio):
    content = (
        f"🎵 **New Roblox Audio**\n"
        f"**Artist:** {artist}\n"
        f"**Name:** {name}\n"
        f"**Language:** {lang}\n"
        f"**Asset ID:** `{asset_id}`\n"
        f"{url}"
    )
    files = []
    if image and os.path.exists(image):
        files.append(discord.File(image))
    if audio and os.path.exists(audio):
        files.append(discord.File(audio))
    await channel.send(content=content, files=files)

# ---------------- GLOBAL BROWSER ----------------
playwright = None
context = None
monitor_pages = []
search_pages = []
search_index = 0

# ---------------- SCAN ARTIST ----------------
async def scan_artist(page, artist):
    url = f"https://create.roblox.com/store/audio?artistName={artist}&keyword={artist}"
    await page.goto(url, timeout=60000)
    await page.wait_for_timeout(4000)

    for _ in range(SCROLL_TIMES):
        await page.mouse.wheel(0, 4000)
        await page.wait_for_timeout(1200)

    links = await page.query_selector_all("a[href^='/store/asset/']")
    return links

# ---------------- MONITOR WORKER ----------------
async def monitor_worker(page, artists):
    while True:
        try:
            for artist in artists:
                links = await scan_artist(page, artist)

                for link in links:
                    href = await link.get_attribute("href")
                    m = re.search(r"/asset/(\d+)", href or "")
                    if not m:
                        continue

                    asset_id = m.group(1)
                    if asset_id in data[artist]:
                        continue

                    name = (await link.inner_text()).split("\n")[0].strip()
                    if not name:
                        continue

                    asset_url = f"https://create.roblox.com/store/asset/{asset_id}"
                    try:
                        await page.goto(asset_url, timeout=60000)
                    except Exception as e:
                        print(f"❌ Page.goto error: {e}")
                        continue
                    await page.wait_for_timeout(3000)

                    screenshot = os.path.join(DOWNLOAD_DIR, f"{asset_id}.png")
                    await page.screenshot(path=screenshot, full_page=True)

                    audio = download_audio(asset_id)
                    lang = detect_language(name)

                    channel = discord.utils.get(
                        bot.get_all_channels(),
                        name=CHANNEL_NAME
                    )
                    if channel:
                        await send_to_channel(
                            channel,
                            name,
                            artist,
                            asset_id,
                            asset_url,
                            lang,
                            screenshot,
                            audio
                        )

                    data[artist].append(asset_id)
                    save_data()

            await asyncio.sleep(CHECK_INTERVAL)

        except Exception as e:
            print("Monitor tab error:", e)
            await asyncio.sleep(5)

# ---------------- SUPERVISOR ----------------
async def browser_supervisor():
    global playwright, context, monitor_pages, search_pages

    while True:  # keeps reopening browser if it crashes/closes
        try:
            if playwright is None:
                print("🚀 Launching persistent browser...")
                playwright = await async_playwright().start()

            # Check if context is closed or invalid
            if context is None or (hasattr(context, 'is_closed') and context.is_closed()):
                print("🚀 Launching new browser context...")
                context = await playwright.chromium.launch_persistent_context(
                    PROFILE_DIR,
                    headless=False
                )

                # Create tabs
                monitor_pages = [await context.new_page() for _ in range(MONITOR_TABS)]
                search_pages = [await context.new_page() for _ in range(SEARCH_TABS)]

                # Distribute artists across monitor tabs
                artist_lists = [[] for _ in range(MONITOR_TABS)]
                for i, artist in enumerate(data.keys()):
                    artist_lists[i % MONITOR_TABS].append(artist)

                for i in range(MONITOR_TABS):
                    bot.loop.create_task(monitor_worker(monitor_pages[i], artist_lists[i]))

                print(f"✅ Browser ready with {MONITOR_TABS} monitor tabs and {SEARCH_TABS} search tabs.")
            
            await asyncio.sleep(10)  # Sleep to avoid tight loops

        except Exception as e:
            print("❌ Failed to maintain browser context, retrying in 5s:", e)
            if playwright:
                await playwright.stop()  # Ensure we clean up any existing context
            context = None  # Reset context to trigger reopening
            await asyncio.sleep(5)  # Retry after delay

# ---------------- SLASH COMMANDS ----------------
intents = discord.Intents.default()
bot = commands.Bot(command_prefix="/", intents=intents)

@bot.event
async def on_ready():
    await bot.tree.sync()
    bot.loop.create_task(browser_supervisor())
    print(f"Logged in as {bot.user}")

@bot.tree.command(name="track", description="Track an artist and monitor for new audios")
async def track(interaction: discord.Interaction, artist: str):
    global search_index
    if artist in data:
        await interaction.response.send_message(f"ℹ️ Already monitoring **{artist}**")
        return

    data[artist] = []
    save_data()

    # Use next search tab
    page = search_pages[search_index % SEARCH_TABS]
    search_index += 1
    await scan_artist(page, artist)

    await interaction.response.send_message(f"✅ Now monitoring **{artist}**")

@bot.tree.command(name="list", description="List all monitored artists")
async def list_artists(interaction: discord.Interaction):
    if not data:
        await interaction.response.send_message("No artists are currently being monitored.")
        return

    msg = "**🎧 Currently Monitored Artists:**\n"
    for artist, assets in data.items():
        msg += f"- **{artist}** ({len(assets)} audios)\n"
    await interaction.response.send_message(msg)

# ---------------- RUN ----------------
bot.run(TOKEN)
