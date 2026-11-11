#!/usr/bin/env bash
# Packs this package, installs the tarball into an empty project and imports it, so a build or packaging
# fault shows up here and not in a consumer's install.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

TARBALL="$(cd "$ROOT" && npm pack --silent --pack-destination "$WORK" | tail -1)"
cd "$WORK"
npm init -y >/dev/null
npm install --silent "$WORK/$TARBALL"
node --input-type=module -e "
import { createCrawler } from '@oliver/crawl-core';
const crawler = createCrawler({ userAgent: 'InstallCheck/1.0 (+https://example.com/bot)' });
if (typeof crawler.crawl !== 'function') throw new Error('crawl is missing');
console.log('install check passed');
"
