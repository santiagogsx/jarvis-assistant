// Music: full Spotify control through the Spotify Web API (after the owner
// logs in once), Apple Music control through the Music app on a Mac, and
// system media keys on Windows (these drive Spotify, Apple Music, YouTube...).
const crypto = require('crypto');
const { execFile } = require('child_process');

const SCOPES = 'user-read-playback-state user-modify-playback-state user-read-currently-playing playlist-read-private';
const enc = encodeURIComponent;

function createMusic(store, browser) {
  let pkce = null;                 // { verifier, state, redirect }
  let access = { token: '', expires: 0 };

  const redirectUri = port => `http://127.0.0.1:${port}/api/spotify/callback`;

  function loginUrl(port) {
    const s = store.get();
    const clientId = s.music.spotifyClientId;
    if (!clientId) throw new Error('Add your Spotify Client ID in Settings → Music first.');
    const verifier = crypto.randomBytes(48).toString('base64url');
    const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
    pkce = { verifier, state: crypto.randomBytes(12).toString('hex'), redirect: redirectUri(port) };
    return 'https://accounts.spotify.com/authorize?' + new URLSearchParams({
      client_id: clientId, response_type: 'code', redirect_uri: pkce.redirect,
      code_challenge_method: 'S256', code_challenge: challenge, scope: SCOPES, state: pkce.state,
    });
  }

  async function tokenRequest(params) {
    const r = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: store.get().music.spotifyClientId, ...params }),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error_description || d.error || `Spotify login failed (HTTP ${r.status})`);
    access = { token: d.access_token, expires: Date.now() + (d.expires_in - 60) * 1000 };
    if (d.refresh_token) store.setSecret('spotifyRefresh', d.refresh_token);
  }

  async function finishLogin(code, state) {
    if (!pkce || state !== pkce.state) throw new Error('This Spotify login link expired. Start again from Settings.');
    const { verifier, redirect } = pkce;
    pkce = null;
    await tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: redirect, code_verifier: verifier });
  }

  function spotifyConnected() {
    const s = store.get();
    return !!(s.music.spotifyClientId && s.keys.spotifyRefresh);
  }

  function disconnect() {
    store.setSecret('spotifyRefresh', '');
    access = { token: '', expires: 0 };
  }

  async function token() {
    if (access.token && Date.now() < access.expires) return access.token;
    const refresh = store.get().keys.spotifyRefresh;
    if (!refresh) throw new Error('Spotify is not connected.');
    await tokenRequest({ grant_type: 'refresh_token', refresh_token: refresh });
    return access.token;
  }

  async function spotify(method, path, body) {
    const r = await fetch('https://api.spotify.com/v1' + path, {
      method,
      headers: { authorization: `Bearer ${await token()}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (r.status === 204) return null;
    const d = await r.json().catch(() => null);
    if (!r.ok) {
      const reason = d?.error?.reason || d?.error?.message || `HTTP ${r.status}`;
      if (reason === 'NO_ACTIVE_DEVICE' || r.status === 404) throw new Error('Spotify has no active device. Open Spotify on your phone or computer and play anything once, then ask again.');
      if (r.status === 403) throw new Error('Spotify only allows remote control with a Spotify Premium account.');
      throw new Error('Spotify: ' + reason);
    }
    return d;
  }

  async function spotifyControl(action, { query, kind = 'track', volume } = {}) {
    switch (action) {
      case 'play': {
        if (!query) { await spotify('PUT', '/me/player/play'); return { ok: true, said: 'Resumed.' }; }
        const type = ['track', 'artist', 'album', 'playlist'].includes(kind) ? kind : 'track';
        const d = await spotify('GET', `/search?q=${enc(query)}&type=${type}&limit=1`);
        const item = d?.[type + 's']?.items?.find(Boolean);
        if (!item) return { error: `Couldn't find ${type} "${query}" on Spotify.` };
        await spotify('PUT', '/me/player/play', type === 'track' ? { uris: [item.uri] } : { context_uri: item.uri });
        const by = item.artists ? ' by ' + item.artists.map(a => a.name).join(', ') : item.owner ? ' by ' + item.owner.display_name : '';
        return { ok: true, playing: `${item.name}${by}`, type };
      }
      case 'pause': await spotify('PUT', '/me/player/pause'); return { ok: true };
      case 'resume': await spotify('PUT', '/me/player/play'); return { ok: true };
      case 'next': await spotify('POST', '/me/player/next'); return { ok: true };
      case 'previous': await spotify('POST', '/me/player/previous'); return { ok: true };
      case 'volume': {
        const v = Math.min(Math.max(Math.round(Number(volume)), 0), 100);
        if (Number.isNaN(v)) return { error: 'Give a volume from 0 to 100.' };
        await spotify('PUT', `/me/player/volume?volume_percent=${v}`);
        return { ok: true, volume: v };
      }
      case 'now_playing': {
        const d = await spotify('GET', '/me/player/currently-playing');
        if (!d?.item) return { playing: false };
        return { playing: d.is_playing, track: d.item.name, artist: d.item.artists?.map(a => a.name).join(', '), album: d.item.album?.name };
      }
      default: return { error: 'Unknown music action ' + action };
    }
  }

  function run(cmd, args) {
    return new Promise((resolve, reject) =>
      execFile(cmd, args, { timeout: 15000, windowsHide: true }, (err, stdout) => (err ? reject(err) : resolve(String(stdout).trim()))));
  }

  // Windows' own media controls (the same ones the volume pop-up uses): they
  // drive and read Apple Music, Spotify, browsers… with no sign-in needed.
  const WIN_ACTIONS = { play: 'Play', resume: 'Play', pause: 'Pause', toggle: 'TogglePlayPause', next: 'SkipNext', previous: 'SkipPrevious', now_playing: 'info' };
  async function winMedia(action, filter = '') {
    const act = WIN_ACTIONS[action];
    if (!act) return { error: action === 'volume' ? 'Change the volume in the music app itself, or ask me on Spotify.' : `"${action}" isn't supported here.` };
    const safeFilter = String(filter).replace(/[^\w|.]/g, '');
    const script = [
      `$Action='${act}'; $Filter='${safeFilter}'`,
      "Add-Type -AssemblyName System.Runtime.WindowsRuntime",
      "$asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | ? { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' })[0]",
      "function Await($op, [Type]$t) { $x = $asTask.MakeGenericMethod($t).Invoke($null, @($op)); $x.Wait(-1) | Out-Null; $x.Result }",
      "[void][Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType = WindowsRuntime]",
      "$m = Await ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])",
      "$s = $null; if ($Filter) { $s = $m.GetSessions() | ? { $_.SourceAppUserModelId -match $Filter } | Select -First 1 }",
      "if (-not $s) { $s = $m.GetCurrentSession() }",
      "if (-not $s) { '{\"none\":true}'; exit }",
      "if ($Action -eq 'info') { $p = Await ($s.TryGetMediaPropertiesAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties]); @{ app = $s.SourceAppUserModelId; title = $p.Title; artist = $p.Artist; status = \"$($s.GetPlaybackInfo().PlaybackStatus)\" } | ConvertTo-Json -Compress }",
      "else { $ok = Await ($s.\"Try$($Action)Async\"()) ([bool]); @{ ok = $ok; app = $s.SourceAppUserModelId } | ConvertTo-Json -Compress }",
    ].join('\n');
    let out;
    try { out = JSON.parse(await run('powershell', ['-NoProfile', '-NonInteractive', '-Command', script])); }
    catch { return { error: "Couldn't reach the music player through Windows media controls." }; }
    if (out.none) return { error: 'Nothing is playing on this computer right now. Open Apple Music or Spotify and play something first.' };
    const appName = /apple/i.test(out.app) ? 'Apple Music' : /spotify/i.test(out.app) ? 'Spotify' : /chrome|edge|brave/i.test(out.app) ? 'the browser' : out.app;
    if (act === 'info') return { playing: out.status === 'Playing', status: out.status, track: out.title, artist: out.artist, app: appName };
    return { ok: !!out.ok, app: appName };
  }
  const mediaKey = winMedia; // kept for older callers

  // Apple Music web player in Jarvis's browser, after the person signs in there once.
  const appleWebConnected = () => !!store.get().music.appleWeb;

  // Spotify APP (no Spotify account connection needed): find the song's Spotify
  // link with a web search, open it in the app and press its Play button.
  async function spotifyAppPlay(query) {
    const research = require('./research');
    const found = await research.webSearch(`${query} site:open.spotify.com/track`, store.get(), 6).catch(() => ({ results: [] }));
    const id = (found.results || []).map(r => (String(r.url).match(/open\.spotify\.com\/(?:intl-[a-z]+\/)?track\/([A-Za-z0-9]{22})/) || [])[1]).find(Boolean);
    const uri = id ? `spotify:track:${id}` : `spotify:search:${encodeURIComponent(query)}`;

    if (process.platform === 'darwin') {
      if (!id) return { ok: true, open_url: `https://open.spotify.com/search/${encodeURIComponent(query)}`, note: 'Opened the search in Spotify. Tap play.' };
      try {
        await run('osascript', ['-e', `tell application "Spotify" to play track "${uri}"`]);
        const now = await macApp('Spotify', 'now_playing').catch(() => null);
        return { ok: true, playing: now?.track || query, app: 'Spotify app' };
      } catch { return null; }
    }
    if (process.platform !== 'win32') return null;

    const b64 = s => Buffer.from(String(s), 'utf8').toString('base64');
    const script = [
      "Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes",
      `$uri = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64(uri)}'))`,
      "$installed = (Test-Path \"$env:APPDATA\\Spotify\\Spotify.exe\") -or (Get-AppxPackage -Name '*Spotify*' -ErrorAction SilentlyContinue)",
      "if (-not $installed) { '{\"noApp\":true}'; exit }",
      "Start-Process $uri",
      "$A = [System.Windows.Automation.AutomationElement]; $S = [System.Windows.Automation.TreeScope]",
      "function Cond($p, $v) { New-Object System.Windows.Automation.PropertyCondition($p, $v) }",
      "$pressed = $false",
      "foreach ($i in 1..30) {",
      "  $p = Get-Process -Name Spotify -ErrorAction SilentlyContinue | ? { $_.MainWindowHandle -ne 0 } | Select -First 1",
      "  if ($p) { $win = $A::FromHandle($p.MainWindowHandle)",
      // The track page's big green Play button is the 'Play' button nearest the top (the player bar's is at the bottom).
      "    $b = $win.FindAll($S::Descendants, (Cond $A::ControlTypeProperty ([System.Windows.Automation.ControlType]::Button))) | ? { $_.Current.Name -match '^Play' -and $_.Current.BoundingRectangle.Height -gt 0 } | Sort-Object { $_.Current.BoundingRectangle.Y } | Select -First 1",
      "    if ($b -and $i -gt 4) { $b.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke(); $pressed = $true; break } }",
      "  Start-Sleep -Milliseconds 500 }",
      "@{ pressed = $pressed } | ConvertTo-Json -Compress",
    ].join('\n');
    let out;
    try { out = JSON.parse(await run('powershell', ['-NoProfile', '-NonInteractive', '-Command', script])); } catch { return null; }
    if (out.noApp) return null;
    if (!out.pressed || !id) return { ok: true, note: id ? 'Opened the song in your Spotify app. Press play.' : 'Opened the search in your Spotify app. Tap play on the song.' };
    await new Promise(r => setTimeout(r, 1500));
    const now = await winMedia('now_playing', 'Spotify').catch(() => null);
    return { ok: true, playing: now?.track ? `${now.track} by ${now.artist}` : query, app: 'Spotify app' };
  }

  // Apple Music APP on Windows: find the song in Apple's public catalog, open it
  // in the app with a music:// link, then press the song's own "Play" menu item
  // through Windows accessibility controls (no mouse, no browser).
  async function appleAppPlay(query, kind = 'track') {
    const entity = kind === 'album' ? 'album' : 'song';
    const term = encodeURIComponent(String(query).slice(0, 120));
    const res = await fetch(`https://itunes.apple.com/search?term=${term}&entity=${entity}&limit=5&country=us`, { signal: AbortSignal.timeout(12000) }).then(r => r.json()).catch(() => null);
    const hit = res?.results?.[0];
    if (!hit) return { error: `I couldn't find "${query}" on Apple Music.` };
    const link = String(hit.trackViewUrl || hit.collectionViewUrl).replace(/^https:\/\//, 'music://');
    const b64 = s => Buffer.from(String(s || ''), 'utf8').toString('base64');
    const script = [
      "Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes, System.Runtime.WindowsRuntime",
      `$link = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64(link)}'))`,
      `$want = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64(entity === 'song' ? hit.trackName : '')}'))`,
      "if (-not (Get-AppxPackage -Name 'AppleInc.AppleMusicWin' -ErrorAction SilentlyContinue)) { '{\"noApp\":true}'; exit }",
      "Start-Process $link",
      "$A = [System.Windows.Automation.AutomationElement]; $S = [System.Windows.Automation.TreeScope]",
      "function Cond($p, $v) { New-Object System.Windows.Automation.PropertyCondition($p, $v) }",
      "$win = $null; foreach ($i in 1..30) { $p = Get-Process -Name AppleMusic -ErrorAction SilentlyContinue | Select -First 1; if ($p) { $win = $A::RootElement.FindFirst($S::Children, (Cond $A::ProcessIdProperty $p.Id)) }; if ($win) { break }; Start-Sleep -Milliseconds 500 }",
      "if (-not $win) { '{\"opened\":true}'; exit }",
      "$pressed = $false",
      // Album (or no track name): the album's big Play button. Song: its row's More → Play "…".
      "if (-not $want) { Start-Sleep 3; $b = $win.FindAll($S::Descendants, (Cond $A::NameProperty 'Play')) | Select -Last 1; if ($b) { $b.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke(); $pressed = $true } }",
      "else { foreach ($i in 1..24) { $row = $win.FindAll($S::Descendants, (Cond $A::ControlTypeProperty ([System.Windows.Automation.ControlType]::ListItem))) | ? { $_.Current.Name -like 'Track *' -and $_.Current.Name.IndexOf($want, [StringComparison]::OrdinalIgnoreCase) -ge 0 } | Select -First 1; if ($row) { break }; Start-Sleep -Milliseconds 500 }",
      "  if ($row) { $more = $row.FindFirst($S::Descendants, (Cond $A::NameProperty 'More')); $more.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke(); Start-Sleep -Milliseconds 900",
      "    $item = $A::RootElement.FindAll($S::Descendants, (Cond $A::ControlTypeProperty ([System.Windows.Automation.ControlType]::MenuItem))) | ? { $_.Current.ProcessId -eq $win.Current.ProcessId -and $_.Current.Name -match '^Play [\\u201C\"]' } | Select -First 1",
      "    if ($item) { $item.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke(); $pressed = $true } } }",
      "@{ opened = $true; pressed = $pressed } | ConvertTo-Json -Compress",
    ].join('\n');
    let out;
    try { out = JSON.parse(await run('powershell', ['-NoProfile', '-NonInteractive', '-Command', script])); }
    catch { return { ok: false, open_url: hit.trackViewUrl || hit.collectionViewUrl, note: 'Opened it in Apple Music. Tap play.' }; }
    const label = entity === 'song' ? `${hit.trackName} by ${hit.artistName}` : `${hit.collectionName} by ${hit.artistName}`;
    if (out.noApp) return null; // no Apple Music app: caller falls back
    if (!out.pressed) return { ok: true, opened: label, note: 'Opened it in your Apple Music app. Press play on the song.' };
    // Make sure it really started.
    await new Promise(r => setTimeout(r, 1500));
    const now = await winMedia('now_playing', 'Apple').catch(() => null);
    return { ok: true, playing: now?.track ? `${now.track} by ${now.artist}` : label, app: 'Apple Music app' };
  }

  const asText = s => '"' + String(s).replace(/["\\]/g, '') + '"';
  async function macApp(appName, action, { query, volume } = {}) {
    const tell = body => run('osascript', ['-e', `tell application "${appName}" to ${body}`]);
    switch (action) {
      case 'play':
        if (!query) { await tell('play'); return { ok: true }; }
        if (appName === 'Music') {
          try {
            const name = await run('osascript', ['-e',
              `tell application "Music"\nset r to (every track of library playlist 1 whose name contains ${asText(query)} or artist contains ${asText(query)})\nif r is {} then return ""\nplay item 1 of r\nreturn (name of item 1 of r) & " by " & (artist of item 1 of r)\nend tell`]);
            if (name) return { ok: true, playing: name };
          } catch {}
          return { ok: false, open_url: `https://music.apple.com/search?term=${enc(query)}`, note: 'Not in the music library, so I opened it in Apple Music to play.' };
        }
        return { ok: false, open_url: `https://open.spotify.com/search/${enc(query)}` };
      case 'pause': await tell('pause'); return { ok: true };
      case 'resume': await tell('play'); return { ok: true };
      case 'next': await tell('next track'); return { ok: true };
      case 'previous': await tell('previous track'); return { ok: true };
      case 'volume': await tell(`set sound volume to ${Math.min(Math.max(Math.round(Number(volume) || 50), 0), 100)}`); return { ok: true };
      case 'now_playing': {
        const r = await run('osascript', ['-e', `tell application "${appName}" to if player state is playing then return (name of current track) & " — " & (artist of current track)`]).catch(() => '');
        return r ? { playing: true, track: r } : { playing: false };
      }
      default: return { error: 'Unknown music action ' + action };
    }
  }

  // service: 'spotify' | 'apple_music'. local = request came from the host computer.
  async function control({ service, action, query, kind, volume }, { local }) {
    service = service || store.get().music.service || 'spotify';
    action = action || 'play';

    if (service === 'spotify' && spotifyConnected()) return spotifyControl(action, { query, kind, volume });

    const searchUrl = service === 'apple_music'
      ? `https://music.apple.com/search?term=${enc(query || '')}`
      : `https://open.spotify.com/search/${enc(query || '')}`;

    // A phone/remote user: just open the song in their own music app.
    if (!local) {
      if (action === 'play' && query) return { ok: true, open_url: searchUrl, note: 'Opened it on your device. Tap play.' };
      return { error: service === 'spotify' ? 'Connect Spotify in Settings on the main computer to control playback from here.' : 'Apple Music can only be controlled on the main computer.' };
    }

    // Spotify app (when the Spotify account isn't connected): open the song in the app and press play.
    if (service === 'spotify' && action === 'play' && query && local) {
      const r = await spotifyAppPlay(query).catch(() => null);
      if (r) return r;
    }
    // Apple Music app on this Windows PC: open the song in the app and press play.
    if (service === 'apple_music' && action === 'play' && query && process.platform === 'win32') {
      const r = await appleAppPlay(query, kind).catch(() => null);
      if (r) return r;
    }
    // Otherwise, Apple Music in Jarvis's browser (if the person signed in there once).
    if (service === 'apple_music' && action === 'play' && query && appleWebConnected() && browser) {
      try { return await browser.appleMusicPlay(query); } catch (e) { /* fall through to the app */ }
    }
    if (process.platform === 'darwin') return macApp(service === 'apple_music' ? 'Music' : 'Spotify', action, { query, volume });
    if (action === 'play' && query) {
      return { ok: true, open_url: searchUrl, note: service === 'apple_music'
        ? 'Opened the search. Tap play. (Connect Apple Music in Settings → Music and I can press play for you.)'
        : 'Opened the search. Tap play (connect Spotify in Settings for hands-free play).' };
    }
    if (process.platform === 'win32') {
      const filter = service === 'apple_music' ? (appleWebConnected() ? 'Apple|chrome|msedge|brave' : 'Apple') : 'Spotify';
      return winMedia(action, filter);
    }
    return { error: 'Music control is not supported on this system yet.' };
  }

  // For Settings → Music: is Apple Music connected, and what's playing right now?
  async function appleStatus() {
    let playing = null;
    if (process.platform === 'win32') playing = await winMedia('now_playing', 'Apple').catch(() => null);
    else if (process.platform === 'darwin') playing = await macApp('Music', 'now_playing').catch(() => null);
    return { webConnected: appleWebConnected(), playing: playing && !playing.error ? playing : null };
  }

  return { control, loginUrl, finishLogin, spotifyConnected, disconnect, redirectUri, appleStatus, winMedia };
}

module.exports = { createMusic };
