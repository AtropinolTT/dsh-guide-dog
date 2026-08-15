#!/usr/bin/env python3
"""Publish Guide Dog deployment artifacts from the repo to the trusted home
directory consumed by the dsh-guide-dog-autoload host plugin.

Why a separate deployment dir (2026-08-15 security review, HIGH finding):
the repo lives inside a session workspace (workspace-write), so the autoloader
must never read plugin sources from there — anything with workspace write
access could plant code that later runs with host privileges. This script
copies the sources plus an autoload copy into ~/.dsh (outside workspaces),
writes a SHA-256 manifest, and the autoloader refuses to deploy on any
mismatch.

Run after changing plugin-host.js / plugin-client.js / scripts/whisper_transcribe.py
or autoload/lib/index.js:

    python3 deploy/publish.py

Requires write access to ~/.dsh (elevation on systems with a file sandbox).
"""
import hashlib
import json
import os
import re
import shutil
import sys

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
HOME_DEPLOY = os.path.expanduser('~/.dsh/guide-dog-deploy')
HOME_AUTOLOAD = os.path.expanduser('~/.dsh/guide-dog-autoload')
# `dsh web` is an alias for `--profile web` (see DSH README); the GUI runs the
# web profile, so the autoload bundle must be registered there. Registering it
# only in another profile (e.g. cc-tui) silently does nothing for the GUI.
PROFILE_DIR = os.path.expanduser('~/.dsh/profiles/web')
BUNDLE_NAME = 'dsh-guide-dog-autoload'

SOURCES = ['plugin-host.js', 'plugin-client.js']


def fail(msg):
    print('ERROR: ' + msg, file=sys.stderr)
    sys.exit(1)


def verify_sources():
    host = open(os.path.join(REPO, 'plugin-host.js'), encoding='utf-8').read()
    client = open(os.path.join(REPO, 'plugin-client.js'), encoding='utf-8').read()
    # 1) Host template must match the standalone whisper script verbatim.
    m = re.search(r'const WHISPER_SCRIPT = `(.*?)`\n', host, re.S)
    if not m:
        fail('WHISPER_SCRIPT template not found in plugin-host.js')
    tpl = m.group(1)
    script = open(os.path.join(REPO, 'scripts', 'whisper_transcribe.py'), encoding='utf-8').read()
    if tpl != script:
        fail('plugin-host.js WHISPER_SCRIPT template != scripts/whisper_transcribe.py — re-sync first')
    # 2) Deploy bundle must match the two sources exactly.
    bundle = open(os.path.join(REPO, 'plugin-source.js'), encoding='utf-8').read()
    nl = bundle.find('\n')
    sep = bundle.find('\n// ==== CLIENT HALF ====\n')
    if nl < 0 or sep <= nl:
        fail('plugin-source.js separator not found — regenerate the bundle')
    if bundle[nl + 1:sep] != host.rstrip('\n'):
        fail('plugin-source.js host part != plugin-host.js — regenerate the bundle')
    if bundle[sep + len('\n// ==== CLIENT HALF ====\n'):] != client:
        fail('plugin-source.js client part != plugin-client.js — regenerate the bundle')
    print('sources verified: template + bundle parts all consistent')


def sha256(path):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for chunk in iter(lambda: f.read(1 << 20), b''):
            h.update(chunk)
    return h.hexdigest()


def register_profile():
    """Idempotently register the autoload bundle in the active web profile.

    DSH reads `dsh.profile.bundles` from <profile>/package.json at startup and
    resolves each bundle name from the profile's own node_modules. Without this
    registration the autoloader never loads and the dynamic plugin is not
    restored after a restart (observed 2026-08-15: registered in cc-tui only,
    while `dsh web` runs the web profile).

    Returns a list of human-readable actions taken (empty when already in
    place, so re-runs are no-ops).
    """
    actions = []
    pkg_path = os.path.join(PROFILE_DIR, 'package.json')
    if not os.path.isfile(pkg_path):
        fail('profile package.json not found: ' + pkg_path)
    pkg = json.load(open(pkg_path, encoding='utf-8'))
    dep_key = 'link:' + HOME_AUTOLOAD
    deps = pkg.setdefault('dependencies', {})
    if deps.get(BUNDLE_NAME) != dep_key:
        deps[BUNDLE_NAME] = dep_key
        actions.append('added dependency %s -> %s' % (BUNDLE_NAME, dep_key))
    bundles = pkg.setdefault('dsh', {}).setdefault('profile', {}).setdefault('bundles', [])
    if BUNDLE_NAME not in bundles:
        bundles.append(BUNDLE_NAME)
        actions.append('added %s to dsh.profile.bundles' % BUNDLE_NAME)
    if actions:
        tmp = pkg_path + '.tmp'
        with open(tmp, 'w', encoding='utf-8') as f:
            json.dump(pkg, f, indent=2, ensure_ascii=False)
            f.write('\n')
        os.replace(tmp, pkg_path)
    # node_modules symlink (pnpm link: layout; matches the dsh-auto-review
    # precedent of a manual symlink without running pnpm install).
    nm = os.path.join(PROFILE_DIR, 'node_modules')
    os.makedirs(nm, exist_ok=True)
    link = os.path.join(nm, BUNDLE_NAME)
    target = os.path.relpath(HOME_AUTOLOAD, os.path.dirname(link))
    if not os.path.islink(link) or os.readlink(link) != target:
        if os.path.lexists(link):
            os.unlink(link)
        os.symlink(target, link)
        actions.append('symlinked node_modules/%s -> %s' % (BUNDLE_NAME, target))
    for a in actions:
        print('profile: ' + a)
    if not actions:
        print('profile: ' + BUNDLE_NAME + ' already registered in ' + PROFILE_DIR)
    return actions


def main():
    verify_sources()

    for d in (HOME_DEPLOY, HOME_AUTOLOAD):
        os.makedirs(d, exist_ok=True)

    manifest = {}
    for name in SOURCES:
        src = os.path.join(REPO, name)
        dst = os.path.join(HOME_DEPLOY, name)
        shutil.copyfile(src, dst)
        os.chmod(dst, 0o600)
        manifest[name] = sha256(dst)
        print('copied ' + name + '  sha256=' + manifest[name][:16] + '…')

    mpath = os.path.join(HOME_DEPLOY, MANIFEST := 'manifest.json')
    with open(mpath, 'w', encoding='utf-8') as f:
        json.dump(manifest, f, indent=2, sort_keys=True)
    os.chmod(mpath, 0o600)

    # Autoload runtime copy (package.json / cordis.patch.yml / lib/index.js).
    for rel in ('package.json', 'cordis.patch.yml', 'lib/index.js'):
        src = os.path.join(REPO, 'autoload', rel)
        dst = os.path.join(HOME_AUTOLOAD, rel)
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        shutil.copyfile(src, dst)
        os.chmod(dst, 0o600)
        print('copied autoload/' + rel)

    print('published to ' + HOME_DEPLOY + ' and ' + HOME_AUTOLOAD)
    register_profile()
    print('publish complete — restart DSH (`dsh web`) for the bundle change to load')


if __name__ == '__main__':
    main()
