#!/bin/sh
# SPDX-License-Identifier: MIT
#
# Проверка JS-страниц LuCI до сборки пакета.
#
# При сборке luci.mk (если включено LUCI_JSMIN - по умолчанию да) пропускает каждый .js через
# JSMin. Он ломает некоторые конструкции (например, регулярное выражение с кавычками внутри
# приводит к тому, что следующая строка с "//" принимается за комментарий), и страница на
# роутере падает с "SyntaxError". Эта проверка собирает тот же jsmin из репозитория LuCI,
# минифицирует каждый файл и проверяет синтаксис результата.
#
# Нужны: node, cc, curl (jsmin.c скачивается один раз в каталог кэша).
#   tools/check-js.sh

set -eu

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RES="$ROOT/luci-app-zapret2/htdocs/luci-static/resources"
CACHE="${XDG_CACHE_HOME:-$HOME/.cache}/openwrt-zapret"
JSMIN_URL="https://raw.githubusercontent.com/openwrt/luci/openwrt-24.10/modules/luci-base/src/jsmin.c"

for c in node cc curl; do
	command -v "$c" >/dev/null 2>&1 || { echo "нужна команда '$c'" >&2; exit 2; }
done

mkdir -p "$CACHE"
[ -f "$CACHE/jsmin.c" ] || curl -fsSL -o "$CACHE/jsmin.c" "$JSMIN_URL"
[ -x "$CACHE/jsmin" ] || cc -o "$CACHE/jsmin" "$CACHE/jsmin.c"

TMP="$(mktemp -d)"
trap 'rm -r "$TMP"' EXIT

fail=0
for f in "$RES"/view/zapret2/*.js "$RES"/zapret2/*.js; do
	b="$(basename "$f")"
	if ! node --check "$f" >/dev/null 2>"$TMP/err"; then
		echo "FAIL (source)    $b"; sed -n 1,4p "$TMP/err"; fail=1; continue
	fi
	"$CACHE/jsmin" <"$f" >"$TMP/$b"
	if node --check "$TMP/$b" >/dev/null 2>"$TMP/err"; then
		echo "ok               $b"
	else
		echo "FAIL (minified)  $b"; sed -n 1,4p "$TMP/err" | cut -c1-200; fail=1
	fi
done
exit $fail
