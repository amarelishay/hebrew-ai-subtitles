# Hebrew AI Subtitles (Stremio Addon)

A personal-use Stremio subtitle addon. It finds an existing English subtitle
via the OpenSubtitles API, translates the text to Hebrew with the OpenAI
API, caches the result as a WebVTT file, and serves it back to Stremio.

This addon never touches video files, torrents, or streaming sources. It
only works with subtitle text from the OpenSubtitles API. The LLM only ever
sees `{ id, text }` pairs - it never sees or controls timestamps, cue
numbering, or file formatting.

## How it works

1. Stremio asks `/subtitles/:type/:id.json` for a title.
2. The addon searches OpenSubtitles for an English subtitle and derives a
   stable cache key from `imdbId + season/episode + language + provider +
   source file id`.
3. If a Hebrew `.vtt` already exists for that key, it's returned immediately.
4. Otherwise the English subtitle is downloaded and parsed into
   `{ id, startMs, endMs, text }` blocks, a background translation job is
   started, and a Hebrew placeholder subtitle is returned right away
   ("translation in progress").
5. The background job sends the subtitle text (and only the text) to
   OpenAI in chunks, validates the JSON it gets back, and merges the
   translated text into the original blocks - timestamps are never touched.
6. Once done, a real Hebrew `.vtt` is written to `public/subtitles/` and
   future requests for the same title get it straight from cache.

## Project structure

```
src/
  index.js                        Express server entrypoint
  addon.js                        Stremio manifest + subtitle resolver
  providers/openSubtitlesProvider.js   OpenSubtitles REST API client
  services/translationService.js      OpenAI translation (chunk/validate/retry)
  services/jobManager.js               Background job orchestration
  services/cacheManager.js             File-system cache + job status store
  utils/srtParser.js                   Deterministic SRT/VTT parsing
  utils/vttBuilder.js                  Deterministic WebVTT writing
  utils/hash.js                        Stable cache key generation
  utils/logger.js                      Console logger
data/jobs.json                    Job status store (created automatically)
public/subtitles/                 Cached translated .vtt files
public/placeholders/              Static "processing" / "failed" .vtt files
```

## Setup

```bash
npm install
cp .env.example .env
# edit .env and fill in OPENAI_API_KEY and OPENSUBTITLES_API_KEY
npm start
```

The server starts on `http://127.0.0.1:7000` by default (see `PORT` in `.env`).

### Environment variables

| Variable                | Required | Notes                                                              |
|--------------------------|----------|---------------------------------------------------------------------|
| `OPENAI_API_KEY`        | Yes      | Used to translate subtitle text.                                    |
| `OPENAI_MODEL`          | No       | Defaults to `gpt-4.1-mini`.                                         |
| `OPENAI_BASE_URL`       | No       | Only set if using a proxy / OpenAI-compatible endpoint.             |
| `OPENSUBTITLES_API_KEY` | Yes      | Free key from opensubtitles.com (Consumer/API section).             |
| `OPENSUBTITLES_USERNAME`| No       | Raises your daily download quota when set with the password.        |
| `OPENSUBTITLES_PASSWORD`| No       | See above.                                                           |
| `PORT`                  | No       | Defaults to `7000`.                                                  |
| `PUBLIC_BASE_URL`       | Yes      | Base URL used to build subtitle URLs returned to Stremio.           |

`PUBLIC_BASE_URL` matters: it's what gets stitched onto `/subtitles/...vtt`
and `/manifest.json` links. Locally that's `http://127.0.0.1:7000`; on
Render it's `https://your-addon.onrender.com`.

## Installing in Stremio

1. Start the server (`npm start`).
2. Open Stremio → Addons → the search/"paste link" box.
3. Paste your manifest URL:
   - Local: `http://127.0.0.1:7000/manifest.json`
   - Render: `https://your-addon.onrender.com/manifest.json`
4. Install, then open any movie/series. A "Hebrew AI Subtitles" track will
   appear in the subtitle list. The first time you select it you'll see the
   "translation in progress" placeholder - reopen the subtitle menu after
   a minute or two and pick it again to get the real translation.

## Deploying to Render

1. Push this project to a GitHub repository.
2. In Render: **New → Web Service**, connect the repo.
3. Build command: `npm install`
4. Start command: `npm start`
5. Add the environment variables from `.env.example` in the Render
   dashboard (Settings → Environment). Set `PUBLIC_BASE_URL` to the Render
   URL Render assigns you, e.g. `https://your-addon.onrender.com`.
6. Deploy, then install in Stremio using
   `https://your-addon.onrender.com/manifest.json`.

Note: Render's free tier spins down idle services. The first request after
idling will be slow (cold start) and cached subtitles on local disk are not
guaranteed to persist across redeploys unless you attach a persistent disk.
That's expected for a personal MVP; add a Render Disk if you want the cache
to survive restarts/deploys.

## Test checklist

- [ ] `GET /health` returns `{ "status": "ok", ... }`.
- [ ] `GET /manifest.json` returns the addon manifest with `resources: ["subtitles"]`.
- [ ] Installing the manifest URL in Stremio shows "Hebrew AI Subtitles" in the addon list.
- [ ] Opening a movie with English subtitles on OpenSubtitles triggers a
      `processing` placeholder on first request (check server logs for
      "Job started").
- [ ] Re-requesting subtitles after the job finishes (check logs for "Job
      ready") returns a real Hebrew `.vtt` whose timestamps match the
      original English subtitle exactly.
- [ ] The translated `.vtt` file exists under `public/subtitles/` and opens
      as valid WebVTT (starts with `WEBVTT`, cues in chronological order).
- [ ] `data/jobs.json` shows a `ready` entry for that title's key.
- [ ] Requesting a title with no English subtitles available on
      OpenSubtitles returns an empty subtitle list (no crash).
- [ ] Temporarily setting an invalid `OPENAI_API_KEY` and triggering a new
      translation results in a `failed` job and the "התרגום נכשל" placeholder.

## Scope

This addon intentionally does **not** include user accounts, payments, a
UI, torrent/streaming integration, video downloading, or any pirate-site
scraping. It only calls the OpenSubtitles API for subtitle text and the
OpenAI API for translation.
