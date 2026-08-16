#!/usr/bin/env python3
"""Publish Guide Dog artifacts from the repo to the trusted home directory.

The active delivery is the STATIC web-profile bundle (`bundle/`): one global
host half + client half, mounted like the published dsh-better-sidebar — no
dynamic plugin, no approvals, no per-session gdog-* instances. This script
copies the bundle into ~/.dsh/dsh-guide-dog (outside workspaces, so a
compromised workspace cannot plant code that later runs with host
privileges), registers it in the web profile, and removes the superseded
per-session auto-deployer bundle (dsh-guide-dog-autoload) so it stops
deploying dynamic instances alongside the static one.

The legacy dynamic deploy dir (~/.dsh/guide-dog-deploy) and autoload copy
are still refreshed for rollback/offline use, but nothing consumes them once
the autoload bundle is gone from the profile.

Run after changing plugin-host.js / plugin-client.js / scripts/whisper_transcribe.py
or autoload/lib/index.js:

    python3 deploy/convert_bundle.py   # regenerate bundle/lib from the plugin halves
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
HOME_BUNDLE = os.path.expanduser('~/.dsh/dsh-guide-dog')
# `dsh web` is an alias for `--profile web` (see DSH README); the GUI runs the
# web profile, so the bundle must be registered there. Registering it only in
# another profile (e.g. cc-tui) silently does nothing for the GUI.
PROFILE_DIR = os.path.expanduser('~/.dsh/profiles/web')
BUNDLE_NAME = 'dsh-guide-dog'
# Superseded per-session dynamic auto-deployer (root causes #1-#3, 2026-08-15/16).
OLD_BUNDLE = 'dsh-guide-dog-autoload'

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
    # 2) The static bundle (the active delivery) must be regenerated from the
    #    current sources. convert_bundle.py transforms the halves (compat layer,
    #    GLOBAL_ROOT, ModuleLoader wrapper), so exact-match is impossible here;
    #    instead require bundle/lib to be newer than both sources. The legacy
    #    plugin-source.js concatenation is NOT the deploy artifact anymore and
    #    is deliberately not compared (2026-08-16 static-bundle migration).
    src_mtime = max(os.path.getmtime(os.path.join(REPO, s)) for s in SOURCES)
    for rel in ('lib/index.js', 'lib/client.js'):
        p = os.path.join(REPO, 'bundle', rel)
        if not os.path.isfile(p):
            fail('bundle/' + rel + ' missing — run python3 deploy/convert_bundle.py first')
        if os.path.getmtime(p) < src_mtime:
            fail('bundle/' + rel + ' older than sources — run python3 deploy/convert_bundle.py first')
    print('sources verified: whisper template consistent; bundle/lib newer than sources')


def sha256(path):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for chunk in iter(lambda: f.read(1 << 20), b''):
            h.update(chunk)
    return h.hexdigest()


def register_profile():
    """Idempotently register the static bundle in the active web profile and
    remove the superseded autoload bundle.

    DSH reads `dsh.profile.bundles` from <profile>/package.json at startup and
    resolves each bundle name from the profile's own node_modules. Without this
    registration the bundle never loads (observed 2026-08-15 with cc-tui vs
    web profile). Removing OLD_BUNDLE is required: if the autoloader stayed
    mounted it would keep deploying per-session dynamic gdog-* instances next
    to the static bundle.

    Returns a list of human-readable actions taken (empty when already in
    place, so re-runs are no-ops).
    """
    actions = []
    pkg_path = os.path.join(PROFILE_DIR, 'package.json')
    if not os.path.isfile(pkg_path):
        fail('profile package.json not found: ' + pkg_path)
    pkg = json.load(open(pkg_path, encoding='utf-8'))
    deps = pkg.setdefault('dependencies', {})
    bundles = pkg.setdefault('dsh', {}).setdefault('profile', {}).setdefault('bundles', [])
    # 1) add the static bundle
    dep_key = 'link:' + HOME_BUNDLE
    if deps.get(BUNDLE_NAME) != dep_key:
        deps[BUNDLE_NAME] = dep_key
        actions.append('added dependency %s -> %s' % (BUNDLE_NAME, dep_key))
    if BUNDLE_NAME not in bundles:
        bundles.append(BUNDLE_NAME)
        actions.append('added %s to dsh.profile.bundles' % BUNDLE_NAME)
    # 2) remove the superseded autoload bundle
    if OLD_BUNDLE in deps:
        del deps[OLD_BUNDLE]
        actions.append('removed dependency %s' % OLD_BUNDLE)
    if OLD_BUNDLE in bundles:
        bundles.remove(OLD_BUNDLE)
        actions.append('removed %s from dsh.profile.bundles' % OLD_BUNDLE)
    if actions:
        tmp = pkg_path + '.tmp'
        with open(tmp, 'w', encoding='utf-8') as f:
            json.dump(pkg, f, indent=2, ensure_ascii=False)
            f.write('\n')
        os.replace(tmp, pkg_path)
    # node_modules symlinks (pnpm link: layout; matches the dsh-better-sidebar
    # precedent of manual symlinks without running pnpm install).
    nm = os.path.join(PROFILE_DIR, 'node_modules')
    os.makedirs(nm, exist_ok=True)
    link = os.path.join(nm, BUNDLE_NAME)
    target = os.path.relpath(HOME_BUNDLE, os.path.dirname(link))
    if not os.path.islink(link) or os.readlink(link) != target:
        if os.path.lexists(link):
            os.unlink(link)
        os.symlink(target, link)
        actions.append('symlinked node_modules/%s -> %s' % (BUNDLE_NAME, target))
    oldlink = os.path.join(nm, OLD_BUNDLE)
    if os.path.islink(oldlink) or os.path.lexists(oldlink):
        os.unlink(oldlink)
        actions.append('removed symlink node_modules/%s' % OLD_BUNDLE)
    for a in actions:
        print('profile: ' + a)
    if not actions:
        print('profile: ' + BUNDLE_NAME + ' registered, ' + OLD_BUNDLE + ' absent — already in place in ' + PROFILE_DIR)
    return actions


def main():
    verify_sources()

    # Static bundle (the active delivery).
    for d in (HOME_BUNDLE,):
        os.makedirs(d, exist_ok=True)
    for rel in ('package.json', 'cordis.patch.yml', 'lib/index.js', 'lib/client.js'):
        src = os.path.join(REPO, 'bundle', rel)
        dst = os.path.join(HOME_BUNDLE, rel)
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        shutil.copyfile(src, dst)
        os.chmod(dst, 0o600)
        print('copied bundle/' + rel)

    # Legacy dynamic deploy dir + autoload copy: kept fresh for rollback.
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

    print('published static bundle to ' + HOME_BUNDLE + ' (legacy deploy/autoload kept fresh)')
    register_profile()
    print('publish complete — restart DSH (`dsh web`) for the bundle change to load')


if __name__ == '__main__':
    main()
