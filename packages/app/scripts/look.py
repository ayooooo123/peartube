#!/usr/bin/env python3
"""cheap eyes: describe a video/image without ever handing it to the model that reasons.

look.py <file|url|files/id> [question...]            — Gemini eyes
look.py --opus [--at t1,t2,...] <file> [question...] — second opinion: frames -> Claude Opus vision
"""
import base64, functools, json, math, mimetypes, os, socket, subprocess, sys, tempfile, time
import urllib.error, urllib.parse, urllib.request

BASE = "https://generativelanguage.googleapis.com"
MODEL = os.environ.get("LOOK_MODEL", "gemini-3.5-flash")
try:
    THINK = int(os.environ.get("LOOK_THINK", "0"))  # 0 = no thinking tokens billed
except ValueError:
    THINK = 0
DEFAULT_Q = ("Describe this recording shot by shot: timestamps, every screen shown, "
             "all on-screen text, every click/scroll/interaction, everything said "
             "aloud, and any moments of hesitation, confusion, or UI glitches.")
INLINE_LIMIT = 19_000_000  # measured: 18.9MB raw (~25MB base64) returns 200 — do not lower this
MIMES = {  # what the Gemini API accepts, plus the aliases Python's mimetypes emits
    "video/mp4", "video/mpeg", "video/mov", "video/quicktime", "video/avi", "video/x-msvideo",
    "video/x-flv", "video/mpg", "video/webm", "video/wmv", "video/x-ms-wmv", "video/3gpp",
    "image/png", "image/jpeg", "image/webp", "image/heic", "image/heif",
    "audio/wav", "audio/x-wav", "audio/mp3", "audio/mpeg", "audio/aac", "audio/x-aac",
    "audio/ogg", "audio/flac", "audio/x-flac", "audio/aiff", "audio/x-aiff", "audio/mp4",
}
HINT = ""  # extra stderr advice printed alongside a 400

ANTHROPIC = "https://api.anthropic.com/v1/messages"
OPUS_MODEL = os.environ.get("LOOK_OPUS_MODEL", "claude-opus-5")
OPUS_FRAMES = 6  # evenly spaced grabs when --at is not given
OPUS_MIMES = {"image/png", "image/jpeg", "image/webp"}  # sent whole; anything else gets frame-grabbed
OPUS_Q = ("These are frames sampled from a screen recording. For each frame, describe exactly "
          "what is on screen: the app/page, all visible text, UI state, dialogs, errors, and "
          "anything unusual. Note differences between frames.")

def die(msg):
    sys.exit("look.py: " + msg)

@functools.cache
def key():
    k = os.environ.get("GEMINI_API_KEY") or ""
    if not k:
        try:
            k = open(os.path.expanduser("~/.config/gemini/key")).read().strip()
        except OSError:
            die("no GEMINI_API_KEY set and no readable ~/.config/gemini/key")
    if not k:
        die("empty API key — set GEMINI_API_KEY or fill ~/.config/gemini/key")
    return k

def api(path, data, headers, timeout=600, soft400=False):
    req = urllib.request.Request(BASE + path, data=data,
                                 headers={"x-goog-api-key": key(), **headers})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.load(r)
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", "replace").strip().replace("\n", " ")[:2000]
        if soft400 and e.code == 400 and "Request contains an invalid argument" in body:
            return None  # flash-lite rejecting thinkingBudget=0 — caller retries without it
        print(f"ERROR {e.code}: {body or '(empty body)'}", file=sys.stderr)
        if e.code == 400 and HINT:
            print(HINT, file=sys.stderr)
        if e.code == 404 and "/" in MODEL:
            print(f"LOOK_MODEL={MODEL} has a provider prefix; use a bare id "
                  f"like gemini-3.5-flash", file=sys.stderr)
        sys.exit(1)
    except (socket.timeout, TimeoutError):
        die(f"timed out after {timeout}s on {path}")
    except urllib.error.URLError as e:
        die(f"network error on {path}: {e.reason}")

def mime_of(path):
    m = mimetypes.guess_type(path)[0] or subprocess.run(
        ["file", "-b", "--mime-type", path], capture_output=True, text=True).stdout.strip()
    if m not in MIMES:
        die(f"unsupported media type {m or '(unknown)'} for {path}")
    return m

def upload(path, mime):
    try:
        blob = open(path, "rb").read()
    except OSError as e:
        die(f"cannot read {path}: {e.strerror}")
    if len(blob) < INLINE_LIMIT:
        return {"inline_data": {"mime_type": mime, "data": base64.b64encode(blob).decode()}}
    up = api("/upload/v1beta/files", blob,
             {"X-Goog-Upload-Protocol": "raw", "Content-Type": mime})
    name, uri = up["file"]["name"], up["file"]["uri"]
    for _ in range(90):  # videos need server-side processing before they can be used
        state = api(f"/v1beta/{name}", None, {}, timeout=30)["state"]
        if state == "ACTIVE":
            print(f"uploaded {name} (expires ~48h) — pass this id instead of the file "
                  f"for follow-up questions", file=sys.stderr)
            return {"file_data": {"file_uri": uri, "mime_type": mime}}
        if state == "FAILED":
            die(f"Gemini failed to process {name}")
        time.sleep(2)
    die(f"still processing after 3min — it may finish anyway; re-run: look.py {name} <question>")

def media_part(inp):
    global HINT
    if os.path.exists(inp):  # a local file always wins over URL/id interpretation
        if os.path.isdir(inp):
            die(f"{inp} is a directory (a .cap project is a directory, not a video) — run: "
                f"cap export {inp} -o /tmp/out.mp4 --json, then pass /tmp/out.mp4")
        return upload(inp, mime_of(inp))
    if urllib.parse.urlparse(inp).scheme in ("http", "https"):
        HINT = (f"if Google cannot fetch that host, download it first: "
                f"curl -L -o /tmp/video.mp4 '{inp}' — then pass /tmp/video.mp4")
        return {"file_data": {"file_uri": inp}}
    if inp.startswith("files/"):  # reuse of an earlier upload
        return {"file_data": {"file_uri": f"{BASE}/v1beta/{inp}"}}
    die(f"no such file: {inp}")

@functools.cache
def opus_key():
    k = os.environ.get("ANTHROPIC_API_KEY") or ""
    if not k:
        try:
            k = open(os.path.expanduser("~/.config/anthropic/key")).read().strip()
        except OSError:
            die("no ANTHROPIC_API_KEY set and no readable ~/.config/anthropic/key")
    if not k:
        die("empty API key — set ANTHROPIC_API_KEY or fill ~/.config/anthropic/key")
    return k

def ff(cmd, soft=False):
    try:
        p = subprocess.run(cmd, capture_output=True, text=True)
    except FileNotFoundError:
        die(f"{cmd[0]} not found — --opus needs ffmpeg (brew install ffmpeg)")
    if p.returncode:
        if soft:
            return None
        die(f"{cmd[0]} failed: {' '.join((p.stderr or '').split())[-300:] or p.returncode}")
    return p.stdout

def grab(path, at):
    # video-stream duration, not container duration — audio can outrun the last video frame
    dur = ff(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries",
              "stream=duration", "-of", "csv=p=0", path]).strip()
    if not dur or dur == "N/A":  # some containers (webm) only carry it at format level
        dur = (ff(["ffprobe", "-v", "error", "-show_entries", "format=duration",
                   "-of", "csv=p=0", path]) or "").strip()
    try:
        dur = float(dur)
    except ValueError:
        die(f"ffprobe read no duration from {path} — is it a video?")
    if at and any(not math.isfinite(t) or t < 0 for t in at):
        die("--at wants finite, non-negative seconds")
    stamps = at or [dur * (i + 0.5) / OPUS_FRAMES for i in range(OPUS_FRAMES)]
    stamps = [min(t, max(dur - 0.1, 0.0)) for t in stamps]  # clamp past-the-end grabs
    frames = []
    with tempfile.TemporaryDirectory(prefix="look-opus-") as tmp:
        for i, t in enumerate(stamps):
            jpg = os.path.join(tmp, f"{i:02d}.jpg")
            out = ff(["ffmpeg", "-v", "error", "-nostdin", "-y", "-ss", f"{t:g}", "-i", path,
                      "-frames:v", "1", "-q:v", "2",  # 1568px long edge caps image tokens per frame
                      "-vf", "scale='min(1568,iw)':'min(1568,ih)':force_original_aspect_ratio=decrease",
                      jpg], soft=True)
            if out is None or not os.path.exists(jpg):
                print(f"look.py: no frame at {t:g}s (duration {dur:.1f}s) — skipping", file=sys.stderr)
                continue
            frames.append((t, open(jpg, "rb").read()))
    if not frames:
        die(f"ffmpeg produced no frames from {path}")
    return frames

def img(mime, blob):
    return {"type": "image", "source": {"type": "base64", "media_type": mime,
                                        "data": base64.b64encode(blob).decode()}}

def ask_opus(content):
    body = json.dumps({"model": OPUS_MODEL, "max_tokens": 16000, "fallbacks": "default",
                       "messages": [{"role": "user", "content": content}]}).encode()
    req = urllib.request.Request(ANTHROPIC, data=body, headers={
        "x-api-key": opus_key(), "anthropic-version": "2023-06-01",
        "content-type": "application/json",
        "anthropic-beta": "server-side-fallback-2026-07-01"})  # refusals retry on a fallback model
    try:
        with urllib.request.urlopen(req, timeout=600) as r:
            return json.load(r)
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", "replace").strip().replace("\n", " ")[:2000]
        print(f"ERROR {e.code}: {body or '(empty body)'}", file=sys.stderr)
        sys.exit(1)
    except (socket.timeout, TimeoutError):
        die("timed out after 600s on /v1/messages")
    except urllib.error.URLError as e:
        die(f"network error on /v1/messages: {e.reason}")

def opus(argv):
    at = None
    if argv and argv[0] in ("-h", "--help"):
        sys.exit(__doc__)
    if argv and argv[0] == "--at":
        if len(argv) < 2:
            die("--at wants seconds, e.g. --at 12,41.5,88")
        try:
            at = [float(s) for s in argv[1].split(",") if s.strip()]
        except ValueError:
            die(f"--at wants seconds as numbers, e.g. --at 12,41.5,88 (got {argv[1]})")
        if not at:
            die("--at wants seconds, e.g. --at 12,41.5,88")
        argv = argv[2:]
    if not argv:
        sys.exit(__doc__)
    inp, q = argv[0], " ".join(argv[1:]) or OPUS_Q
    for a in argv[1:]:
        if a in ("--at", "--opus"):
            die(f"{a} goes before the file: look.py --opus --at 12,41 video.mp4 [question]")
    opus_key()  # fail fast, before any ffmpeg work
    if not os.path.exists(inp):
        die(f"--opus needs a local file, not a URL or files/ id — fetch it first: "
            f"curl -fL -o /tmp/video.mp4 '{inp}' — then pass /tmp/video.mp4")
    if os.path.isdir(inp):
        die(f"{inp} is a directory (a .cap project is a directory, not a video) — run: "
            f"cap export {inp} -o /tmp/out.mp4 --json, then pass /tmp/out.mp4")
    mime = mime_of(inp)
    if mime in OPUS_MIMES:
        content = [img(mime, open(inp, "rb").read())]
    elif not mime.startswith("video/"):
        die(f"--opus wants a video or a png/jpeg/webp image, not {mime}")
    else:
        content = [part for t, blob in grab(inp, at)
                   for part in ({"type": "text", "text": f"Frame at {t:.1f}s:"},
                                img("image/jpeg", blob))]
    resp = ask_opus(content + [{"type": "text", "text": q}])
    if resp.get("stop_reason") == "refusal":
        det = resp.get("stop_details")
        print(f"look.py: {OPUS_MODEL} refused these frames"
              + (f": {json.dumps(det)}" if det else ""), file=sys.stderr)
        sys.exit(1)
    blocks = resp.get("content") or []
    text = "".join(b.get("text", "") for b in blocks if b.get("type") == "text")  # skip thinking
    if not text.strip():
        die("no text in response: " + json.dumps(resp)[:2000])
    print(text)

def main():
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    if sys.argv[1] == "--opus":
        return opus(sys.argv[2:])
    inp, q = sys.argv[1], " ".join(sys.argv[2:]) or DEFAULT_Q
    path, hdrs = f"/v1beta/models/{MODEL}:generateContent", {"Content-Type": "application/json"}
    body = {"contents": [{"parts": [{"text": q}, media_part(inp)]}],
            "generationConfig": {"thinkingConfig": {"thinkingBudget": THINK}}}
    resp = api(path, json.dumps(body).encode(), hdrs, soft400=(THINK == 0))
    if resp is None:  # gemini-3.5-flash-lite rejects thinkingBudget=0; retry with its default
        del body["generationConfig"]
        resp = api(path, json.dumps(body).encode(), hdrs)
    cand = (resp.get("candidates") or [{}])[0]
    if cand.get("finishReason", "STOP") != "STOP":
        print(f"WARNING: finishReason={cand['finishReason']}", file=sys.stderr)
    parts = cand.get("content", {}).get("parts") or []
    text = "".join(p["text"] for p in parts if "text" in p)  # 3.x replies are multi-part
    if not text.strip():
        die("no text in response: " + json.dumps(resp)[:2000])
    print(text)

if __name__ == "__main__":
    main()
