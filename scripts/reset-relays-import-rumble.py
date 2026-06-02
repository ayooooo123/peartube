#!/usr/bin/env python3
import json, os, re, subprocess, sys, time
from pathlib import Path

ROOT = Path('/home/user/peartube-work')
CFG_PATHS = [
    Path('/home/user/.config/peartube-relay/config.json'),
    Path('/home/user/.config/peartube-relay-2/config.json'),
    Path('/home/user/.config/peartube-relay-3/config.json'),
    Path('/home/user/.config/peartube-relay-4/config.json'),
]
SERVICES = ['peartube-relay-local', 'peartube-relay-2', 'peartube-relay-3', 'peartube-relay-4']
RUMBLE_CHANNEL = 'https://rumble.com/c/nickjfuentes'
MAX_ITEMS = int(os.environ.get('PEARTUBE_RUMBLE_MAX_ITEMS', '60'))
# Low-ish but not tiny: long full episodes still stress range/long playback without exploding disk immediately.
FORMAT = os.environ.get('PEARTUBE_RUMBLE_FORMAT', 'b[height<=480][ext=mp4]/b[height<=480]/b[ext=mp4]/b')
YTDLP = '/home/user/.local/bin/yt-dlp'
NODE = '/home/user/.local/bin/node'


def run(cmd, **kwargs):
    print('+', ' '.join(map(str, cmd)), flush=True)
    return subprocess.run(cmd, check=True, text=True, **kwargs)


def service_cmd(action):
    run(['systemctl', '--user', action, *SERVICES])


def list_episode_urls(limit):
    cmd = [YTDLP, '--flat-playlist', '--dump-json', '--playlist-end', str(limit), RUMBLE_CHANNEL]
    p = subprocess.run(cmd, text=True, capture_output=True, check=True)
    urls = []
    seen = set()
    for line in p.stdout.splitlines():
        try:
            row = json.loads(line)
        except Exception:
            continue
        url = (row.get('webpage_url') or row.get('url') or '').split('?', 1)[0]
        if not url or url in seen:
            continue
        slug = url.rsplit('/', 1)[-1].lower()
        if 'america-first-ep' not in slug:
            continue
        seen.add(url)
        title = row.get('title') or slug.replace('.html', '').replace('-', ' ').title()
        urls.append({'url': url, 'title': title})
    return urls


def load_cfg(path):
    with path.open() as f:
        return json.load(f)


def save_cfg(path, cfg):
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + '.tmp')
    with tmp.open('w') as f:
        json.dump(cfg, f, indent=2)
        f.write('\n')
    tmp.replace(path)


def update_config(path, urls_for_this_relay):
    cfg = load_cfg(path)
    archive = cfg.setdefault('archive', {})
    archive['enabled'] = True
    archive['poll'] = 86400
    archive['format'] = FORMAT
    archive['ytDlpPath'] = YTDLP
    archive['ffmpegPath'] = '/usr/bin/ffmpeg'
    archive['jsRuntime'] = ''
    archive['ytDlpExtraArgs'] = []
    archive['ytDlpRetryExtraArgs'] = []
    archive['maxRetries'] = 0
    archive['maxItems'] = 1
    archive['sources'] = [
        {
            'url': item['url'],
            'label': 'America First Full Episodes',
            'format': FORMAT,
            'maxItems': 1,
        }
        for item in urls_for_this_relay
    ]
    local = archive.setdefault('localMirror', {})
    local['enabled'] = False
    save_cfg(path, cfg)
    return cfg


def archive_existing(paths):
    stamp = time.strftime('%Y%m%d-%H%M%S')
    base = Path(f'/home/user/.local/share/peartube-relay-reset-{stamp}')
    base.mkdir(parents=True, exist_ok=True)
    manifest = []
    for cfg_path in paths:
        cfg = load_cfg(cfg_path)
        storage = Path(cfg['storage']['path'])
        tmp = Path(cfg.get('archive', {}).get('tmpPath') or (str(storage) + '/archive-tmp'))
        for p in [storage.parent, tmp]:
            # storage parent is /.../peartube-relay[-N]; moving it clears storage + tmp + root keys.
            if p.exists():
                dest = base / p.name
                n = 1
                while dest.exists():
                    n += 1
                    dest = base / f'{p.name}-{n}'
                p.rename(dest)
                manifest.append({'moved': str(p), 'to': str(dest)})
        storage.mkdir(parents=True, exist_ok=True)
        tmp.mkdir(parents=True, exist_ok=True)
    (base / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
    return base


def validate(paths):
    for p in paths:
        run([NODE, 'packages/cli/bin.js', 'validate', '--config', str(p)], cwd=ROOT, stdout=subprocess.DEVNULL)


def compact_status():
    out = []
    for p in CFG_PATHS:
        if not p.exists():
            continue
        name = p.parent.name
        proc = subprocess.run([NODE, 'packages/cli/bin.js', 'status', '--config', str(p), '--json'], cwd=ROOT, text=True, capture_output=True)
        if proc.returncode != 0:
            out.append({'name': name, 'error': proc.stderr.strip()[:500]})
            continue
        try:
            s = json.loads(proc.stdout)
        except Exception as e:
            out.append({'name': name, 'error': f'bad status json {e}'})
            continue
        rt = s.get('runtime') or {}; sm = s.get('summary') or {}
        out.append({
            'name': name,
            'summary': sm,
            'runtime': {k: rt.get(k) for k in ['peers','connections','feedPeers','feedConnections','feedEntries']},
        })
    return out


def main():
    urls = list_episode_urls(MAX_ITEMS)
    if not urls:
        raise SystemExit('No America First episode URLs found from Rumble channel')
    print(json.dumps({'foundEpisodes': len(urls), 'first': urls[:5], 'last': urls[-3:]}, indent=2), flush=True)
    paths = [p for p in CFG_PATHS if p.exists()]
    if not paths:
        raise SystemExit('No relay configs found')
    per = [[] for _ in paths]
    for i, item in enumerate(urls):
        per[i % len(paths)].append(item)
    for path, batch in zip(paths, per):
        cfg = update_config(path, batch)
        print(json.dumps({'config': str(path), 'sources': len(batch), 'storage': cfg['storage']['path']}, indent=2), flush=True)
    validate(paths)
    service_cmd('stop')
    reset_dir = archive_existing(paths)
    print(json.dumps({'archivedOldRelayData': str(reset_dir)}, indent=2), flush=True)
    service_cmd('start')
    time.sleep(20)
    for svc in SERVICES:
        subprocess.run(['systemctl', '--user', 'is-active', svc], text=True, check=False)
    print(json.dumps({'statusAfterStart': compact_status()}, indent=2), flush=True)
    print('journal_hint: journalctl --user -u peartube-relay-local -u peartube-relay-2 -u peartube-relay-3 -u peartube-relay-4 --since "10 minutes ago" --no-pager | grep -E "Archive starting|Video archived|Source poll complete|Video archive failed"', flush=True)

if __name__ == '__main__':
    main()
