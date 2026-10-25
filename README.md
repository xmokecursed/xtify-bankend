# Xtify Backend

The small server behind the [Xtify](https://github.com/xmokecursed/xtify) music app. It handles **search and recommendations** only. It does not stream or store any audio.

The Xtify app asks this server for things like "find this song", "what is similar to this artist" or "what is trending". The app itself then resolves and plays the audio on the phone.

## What it does

- **Song search** using yt-dlp, with Piped instances as a fast backup. Results are cached.
- **Recommendations** from two sources:
  - **Last.fm:** similar artists, similar tracks, artist radio, trending songs, album info.
  - **YouTube Music:** "up next" songs for a video and an artist's songs (through `ytmusic-api`).
- Basic protection for small servers: only a limited number of yt-dlp processes run at once and the server answers `503 busy` when memory is tight, so the app can fall back to Last.fm.

## Endpoints

| Method | Path | What it returns |
| --- | --- | --- |
| GET | `/search?q=…` | Songs matching a query (yt-dlp, Piped as backup) |
| GET | `/similar/:artist` | Artists similar to an artist (Last.fm) |
| GET | `/radio/:artist` | A mix of songs for an artist (Last.fm) |
| GET | `/similar-tracks/:artist/:track` | Songs similar to a song (Last.fm) |
| GET | `/trending` | Currently trending songs (Last.fm) |
| GET | `/related/:id` | Related videos for a YouTube video ID (503 `busy` when overloaded) |
| GET | `/ytm/similar/:id` | YouTube Music "up next" songs for a video ID |
| GET | `/ytm/artist/:name` | Songs by an artist from YouTube Music |
| GET | `/album/:artist/:album` | Album information (Last.fm) |
| GET | `/track/search?q=…&limit=10` | Song lookup on Last.fm |
| GET | `/test` | Health check, answers `OK` |

## Run it locally

You need **Node.js 18 or newer** and a free [Last.fm API key](https://www.last.fm/api/account/create).

```bash
git clone https://github.com/xmokecursed/xtify-backend.git
cd xtify-backend
npm install
LASTFM_API_KEY=your_key npm start
```

On Windows PowerShell:

```powershell
$env:LASTFM_API_KEY="your_key"; npm start
```

The server starts on `http://localhost:3000`. Check it with `http://localhost:3000/test`.

Run the tests with:

```bash
npm test
```

## Configuration

All settings are environment variables.

| Variable | Default | Purpose |
| --- | --- | --- |
| `LASTFM_API_KEY` | none (set your own) | Your Last.fm API key |
| `PORT` | `3000` | Port to listen on |
| `YOUTUBE_COOKIES_PATH` | `/etc/secrets/youtube_cookies.txt` if it exists | Optional cookies file for yt-dlp, which can help when YouTube blocks the server |
| `PIPED_INSTANCES` | built-in list | Comma-separated Piped API URLs for the search backup |
| `MAX_YTDLP` | `1` | How many yt-dlp processes may run at once |
| `MEM_LIMIT_MB` | `380` | Above this memory use, yt-dlp is skipped |

The defaults are tuned for a **512 MB** server.

## Deploy on Render (free tier)

1. Create a new **Web Service** from this repo.
2. Build command: `npm install`. Start command: `npm start`.
3. Add the environment variable `LASTFM_API_KEY`.
4. If the build fails with a Python version error from `yt-dlp-exec`, add `YOUTUBE_DL_SKIP_PYTHON_CHECK=1`.
5. Optional: add `youtube_cookies.txt` as a **Secret File**. It is then found automatically at `/etc/secrets/youtube_cookies.txt`.
6. Put the service URL into the app (`_baseUrl` in `lib/services/api_service.dart` in the Xtify repo).

Free instances **sleep after a while without traffic**, so the first request after a pause can take 30 to 60 seconds.

## Notes

- Never commit cookie files or API keys. Keep them in environment variables or secret files.
- This is an independent personal project. It is not affiliated with YouTube, Google or Last.fm, and it may stop working when those services change.
