#!/bin/sh
# SPDX-License-Identifier: MIT
#
# Постраничный просмотр больших списков для LuCI (в том числе сжатых gzip).
#
# usage: listview.sh <файл> <смещение> <лимит> <файл-вывода> <файл-мета> [фильтр]
#
#   <файл-вывода>  строки, подходящие под фильтр (подстрока без учёта регистра),
#                  начиная с <смещение>-й, не более <лимит> штук
#   <файл-мета>    "всего_строк подходящих_строк"
#
# Фильтр передаётся через окружение awk, а не через командную строку/shell, поэтому
# любые символы в нём безопасны.

f="$1"
off="${2:-0}"
lim="${3:-200}"
out="$4"
meta="$5"
flt="$6"

case "$off$lim" in
	''|*[!0-9]*) echo "bad offset/limit" >&2; exit 2 ;;
esac
[ -n "$out" ] && [ -n "$meta" ] || { echo "usage: listview.sh file offset limit out meta [filter]" >&2; exit 2; }
[ -f "$f" ] || { echo "no such file" >&2; exit 1; }

if [ "${f%.gz}" != "$f" ] || gzip -t "$f" 2>/dev/null; then
	reader="gunzip -c"
else
	reader="cat"
fi

: >"$out"
$reader "$f" 2>/dev/null | ZF="$flt" ZOFF="$off" ZLIM="$lim" ZOUT="$out" ZMETA="$meta" awk '
	BEGIN {
		f = tolower(ENVIRON["ZF"]); off = ENVIRON["ZOFF"] + 0; lim = ENVIRON["ZLIM"] + 0
		out = ENVIRON["ZOUT"]; meta = ENVIRON["ZMETA"]
	}
	{
		sub(/\r$/, "")
		total++
		if (f == "" || index(tolower($0), f) > 0) {
			m++
			if (m > off && m <= off + lim) print $0 >> out
		}
	}
	END { print total + 0, m + 0 > meta }
'
