#!/usr/bin/env python3
"""Prepare the single MVP video asset for the web demo and Android APK."""
from __future__ import annotations
import hashlib, json, shutil
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SOURCE = Path('/Users/hanzhen/Documents/兼容测试/artifacts/input/video/input.mp4')
WEB_TARGET = ROOT / 'web/public/input.mp4'
ANDROID_TARGET = ROOT / 'android/app/src/main/assets/input.mp4'
META_TARGET = ROOT / 'web/public/input.mp4.json'

def main() -> None:
    if not SOURCE.is_file():
        raise SystemExit(f'Missing source video: {SOURCE}')
    digest = hashlib.sha256(SOURCE.read_bytes()).hexdigest()
    for target in (WEB_TARGET, ANDROID_TARGET):
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(SOURCE, target)
    META_TARGET.write_text(json.dumps({'name': SOURCE.name, 'sizeBytes': SOURCE.stat().st_size, 'sha256': digest, 'format': 'video/mp4'}, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print(json.dumps({'source': str(SOURCE), 'sha256': digest, 'sizeBytes': SOURCE.stat().st_size}, ensure_ascii=False))

if __name__ == '__main__': main()
