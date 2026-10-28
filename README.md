# J.A.R.V.I.S. — your personal AI assistant

**Made and designed by Ricardo Santiago**

## ⬇ Download

Get the latest version for **Windows** (`Jarvis Setup x.x.x.exe`) or **Mac** (`Jarvis-x.x.x-universal.dmg`, works on Intel and Apple-chip Macs):
**https://github.com/santiagogsx/jarvis-assistant/releases/latest**

Installed copies update themselves for free when a new version comes out.
- Windows may say "Windows protected your PC": click **More info → Run anyway** (the app isn't paid-certificate signed).
- Mac: the first time, **right-click the app → Open**.

### Publishing an update (for the owner)
1. Change `"version"` in `package.json` (e.g. `1.0.0` → `1.1.0`).
2. Commit and push the change, then add and push a matching tag: `git tag v1.1.0` then `git push origin v1.1.0`.
3. GitHub builds Windows + Mac and publishes them; every installed Jarvis picks it up automatically.

A see-through, Iron Man style holographic assistant for **Windows and Mac**. You can also open it from **any phone or web browser**.
It talks in a British butler voice, listens when you speak, and works with **ChatGPT, Claude, Grok, Gemini, OpenRouter, Ollama** or any OpenAI-compatible AI.

What you can ask it:

| Ask… | What happens |
|---|---|
| "Research the best budget gaming laptops" | Searches the web, reads the top pages, answers with sources |
| "Any new emails?" / "Find the email from Amazon" / "Reply saying I'll be there" | Reads your inbox (Gmail, Yahoo, iCloud, Outlook, AOL, any IMAP). Replies show as a draft — **you** tap Send |
| "Play Drake on Spotify" / "Skip" / "What's playing?" | Controls Spotify (after you connect it) or Apple Music |
| "Find me AirPods under $150" / "Order the second one" | Compares Amazon, eBay, Walmart… and puts the item in your Amazon cart or opens the product page. **You** place the order |
| "Text me the grocery list" / "Call me in 20 minutes to wake me up" | Texts or calls **your own** phone (Twilio) |
| "Write a TikTok caption about my new shoes" | Opens a pre-filled post on X, LinkedIn, Threads, Bluesky, WhatsApp… or copies it for Instagram/TikTok. **You** press Post |
| "Remember my gym days are Mon/Wed/Fri" / "What do I have in my notes about the game?" | **Second Brain**: saves facts, searches your notes and folders, shown as a glowing map (🧠 button) |
| "What's on my calendar this week?" / "Add dentist Friday 3pm" | Reads Google/iCloud/Outlook calendars (private iCal link); new events open filled in for you to save |
| "What's on my screen?" / "What do you see?" | **Eyes** (👁): looks at your screen or through the camera |
| "How was igloo.inc made?" | Reverse-engineers a website's tech (3D, animation libraries, frameworks, fonts, colours) |
| Chip under the orb | Switch AI brains, including **🔒 Local only**: an AI running on your PC, nothing leaves it |
| "Remind me in 10 minutes to check the oven" | Pop-up + spoken reminder (or a text/call) |
| "What's the weather?" / "Top news?" / "Take a note…" / "Open calculator" | Done |

| "Add call mom to my list" / "Every weekday at 8:00 text me the weather and my unread emails" | To-do list + routines Jarvis runs by himself on schedule |
| "Write a packing list for my trip and save it" | Creates the file in Documents\Jarvis |

> Jarvis never posts, sends email, buys or pays on its own. It prepares everything and you make the final tap.

**Free by default.** Jarvis works with no subscription. Free AI mode uses the best free option you have: a free **Groq** key (no credit card, fastest), a free **Gemini** key, **Ollama** on your PC, or, with nothing set up, a no-signup starter AI (one reply about every 30 s). The wake word, voice input and built-in voice are free and offline. Paid AI is optional, and if it fails Jarvis falls back to the free one automatically. (ChatGPT Plus / Claude Pro subscriptions can't be used in apps. Those need a pay-per-use API key.)

**Also:** say **"Hey Jarvis"** to wake him (offline, on-device). **Rename** him to anything (Settings → You). Pick your **microphone and speaker** (Settings → This device). Run on **all your monitors**: each extra screen shows a different hologram display, click-through by default (Settings → This device → Monitors).

---

## 1. Run it on your computer (first time)

1. Install **Node.js LTS** from https://nodejs.org (one time).
2. Open a terminal in this folder and run:

```bash
npm install
```

```bash
npm start
```

3. Jarvis opens and shows **Settings**. Pick an AI platform and paste its key:
   - **ChatGPT**: https://platform.openai.com/api-keys (this one key also unlocks the best voice and voice input)
   - **Claude**: https://console.anthropic.com
   - **Grok**: https://console.x.ai
   - **Gemini** (has a free tier): https://aistudio.google.com/apikey
   - **Free and offline**: install https://ollama.com, run `ollama pull llama3.1`, choose "Ollama"

Press **Ctrl+Shift+J** (Cmd+Shift+J on Mac) from anywhere to make Jarvis listen.

## 2. Make an installer to share

```bash
npm run dist
```

This makes `dist/Jarvis Setup 1.0.0.exe` on Windows. A **Mac** `.dmg` has to be built on a Mac. Or skip that: push this folder to GitHub and run the **Build installers** action. It builds both and gives you the files to download.
The Mac build isn't signed with an Apple developer account, so the first time, Mac users **right-click → Open**.

## 3. Use Jarvis from phones and other browsers

**Same Wi-Fi (easiest):** Settings → **Phone access** → tick "Let phones…", choose a passcode, Save. A link appears, like `http://192.168.1.20:7777`. Open it on the phone, enter the passcode, and in the browser menu tap **Add to Home Screen** so it works like an app.

**From anywhere + phone microphone:** phones only allow the microphone on a secure `https://` link. The free way is a Cloudflare tunnel. Install `cloudflared` (https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/), then, with Jarvis running:

```bash
cloudflared tunnel --url http://localhost:7777
```

It prints a `https://….trycloudflare.com` link that works on any phone, anywhere, while your computer is on. The passcode is still required.

**Always on (no PC needed):** the server part runs by itself (`npm run server`). You can host it on Render, Railway or any Node host, setting `OPENAI_API_KEY` (or `ANTHROPIC_API_KEY`, `XAI_API_KEY`, `GEMINI_API_KEY`), `JARVIS_PROVIDER`, `JARVIS_PASSCODE` and optionally `TAVILY_API_KEY`, `EMAIL_PASSWORD`, `TWILIO_AUTH_TOKEN`.

> Anyone with the passcode uses **your** AI account, email and music. Only share it with people you trust.

## 4. Optional add-ons (all in Settings)

- **Better voice:** Voice → "OpenAI voice" (needs the OpenAI key) or ElevenLabs. Free option on Windows: Settings → Time & language → Speech → add **English (United Kingdom)** for a British built-in voice.
- **Voice input on the computer:** uses OpenAI Whisper (OpenAI key) or **Groq** (free key at https://console.groq.com/keys).
- **Better research:** a free **Tavily** key (https://app.tavily.com) or a Brave Search key. Without one, Jarvis uses DuckDuckGo/Wikipedia.
- **Email:** Settings → Email → pick your service, then enter your address and an **app password**. Don't use your normal password:
  - Gmail: turn on 2-Step Verification, then https://myaccount.google.com/apppasswords
  - Yahoo / AOL: Account security → Generate app password
  - iCloud: https://appleid.apple.com → App-Specific Passwords
  - Outlook.com/Hotmail: Microsoft is phasing out app passwords, so it may refuse. Gmail/Yahoo/iCloud work best.
- **Spotify:** https://developer.spotify.com/dashboard → Create app → redirect URI `http://127.0.0.1:7777/api/spotify/callback` → tick Web API → paste the Client ID in Settings → Music → Save → **Connect Spotify**. Remote control needs Spotify Premium.
- **Apple Music:** on a Mac it controls the Music app directly. On Windows it uses play/pause/skip media keys and opens songs in Apple Music.
- **Texts and calls:** make a Twilio account (https://twilio.com), buy a number (about $1/month), then fill in Settings → Phone. On a free trial account Twilio only reaches your verified number. That's fine, since Jarvis only ever contacts you.

## Privacy

Keys and passwords are stored **encrypted** on your computer (Windows Credential protection / Mac Keychain) and are never sent to phones. What you ask, including email text Jarvis reads for you, goes to the AI platform you chose.

## Project layout

```
main.js / preload.js   desktop window (transparent hologram)
server/                web server, AI providers, tools (research, email, music, shopping, phone…)
public/                the HUD screen used by the desktop app, browsers and phones
```

"J.A.R.V.I.S." and Iron Man belong to Marvel. This is a personal fan project. If you publish it publicly, give it your own name.
