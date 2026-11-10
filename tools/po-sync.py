#!/usr/bin/env python3
# SPDX-License-Identifier: MIT
#
# Перевод интерфейса: сверка строк _('...') в JS-страницах и заголовков меню с русским .po.
#
#   tools/po-sync.py            только проверка: показывает непереведённые и устаревшие строки
#   tools/po-sync.py --write    пересобрать po/templates/zapret2.pot и po/ru/zapret2.po
#                               (готовые переводы сохраняются, для новых строк msgstr остаётся пустым)
#
# Исходные тексты интерфейса - английские, русский идёт через перевод. При сборке luci.mk сам
# превращает .po в .lmo; этот скрипт нужен только разработчику.

import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
APP = ROOT / "luci-app-zapret2"
PO_RU = APP / "po" / "ru" / "zapret2.po"
POT = APP / "po" / "templates" / "zapret2.pot"
MENU = APP / "root" / "usr" / "share" / "luci" / "menu.d" / "luci-app-zapret2.json"
SOURCES = sorted((APP / "htdocs" / "luci-static" / "resources" / "view" / "zapret2").glob("*.js")) + \
    sorted((APP / "htdocs" / "luci-static" / "resources" / "zapret2").glob("*.js"))

ESC = {"n": "\n", "t": "\t", "\\": "\\", "'": "'", '"': '"', "r": "\r"}


def read_literal(src, i):
    """Строка JS, начинающаяся с кавычки в позиции i: (значение, позиция после неё) или None."""
    q = src[i]
    if q not in "'\"":
        return None
    out = []
    i += 1
    while i < len(src):
        c = src[i]
        if c == "\\":
            n = src[i + 1]
            if n == "u":
                out.append(chr(int(src[i + 2:i + 6], 16)))
                i += 6
                continue
            out.append(ESC.get(n, n))
            i += 2
            continue
        if c == q:
            return "".join(out), i + 1
        if c == "\n":
            return None
        out.append(c)
        i += 1
    return None


def extract(src):
    """Все строки внутри _( ... ): первая литерал-строка и склеенные через + продолжения."""
    found = []
    for m in re.finditer(r"(?<![A-Za-z0-9_$.])_\(\s*", src):
        i = m.end()
        lit = read_literal(src, i) if i < len(src) else None
        if not lit:
            continue
        text, j = lit
        while True:
            k = re.compile(r"\s*\+\s*").match(src, j)
            if not k:
                break
            nxt = read_literal(src, k.end())
            if not nxt:
                break
            text += nxt[0]
            j = nxt[1]
        found.append(text)
    return found


def quote(s):
    return '"' + s.replace("\\", "\\\\").replace('"', '\\"').replace("\n", "\\n").replace("\t", "\\t") + '"'


def unquote(s):
    return json.loads(s) if s.startswith('"') else s


def read_po(path):
    """msgid -> msgstr"""
    entries, cur, key = [], None, 0
    for line in path.read_text(encoding="utf-8").splitlines():
        if line.startswith("msgid "):
            cur, key = [unquote(line[6:]), ""], 0
            entries.append(cur)
        elif line.startswith("msgstr "):
            cur[1], key = unquote(line[7:]), 1
        elif line.startswith('"') and cur is not None:
            cur[key] += unquote(line)
    return {k: v for k, v in entries}


HEADER = ('msgid ""\nmsgstr ""\n"Project-Id-Version: luci-app-zapret2\\n"\n"MIME-Version: 1.0\\n"\n'
          '"Content-Type: text/plain; charset=UTF-8\\n"\n"Content-Transfer-Encoding: 8bit\\n"\n')
RU_HEADER = ('"Language: ru\\n"\n"Plural-Forms: nplurals=3; plural=(n%10==1 && n%100!=11 ? 0 : '
             'n%10>=2 && n%10<=4 && (n%100<10 || n%100>=20) ? 1 : 2);\\n"\n\n')


def main():
    write = "--write" in sys.argv[1:]

    ids = []
    for f in SOURCES:
        for t in extract(f.read_text(encoding="utf-8")):
            if t not in ids:
                ids.append(t)
    for entry in json.loads(MENU.read_text(encoding="utf-8")).values():
        t = entry.get("title")
        if t and t not in ids:
            ids.append(t)

    old = read_po(PO_RU) if PO_RU.exists() else {}
    old.pop("", None)
    missing = [t for t in ids if not old.get(t)]
    obsolete = [t for t in old if t not in ids]

    # одинаковые подстановки %s/%d в оригинале и переводе
    fmt = lambda s: sorted(re.findall(r"%(?:\d+\$)?[sdif]", s))
    broken = [t for t in ids if old.get(t) and fmt(t) != fmt(old[t])]

    print(f"строк в интерфейсе: {len(ids)}, переведено: {len(ids) - len(missing)}")
    for t in missing:
        print("  НЕ ПЕРЕВЕДЕНО:", t[:110])
    for t in obsolete:
        print("  устарело:      ", t[:110])
    for t in broken:
        print("  ПОДСТАНОВКИ НЕ СОВПАДАЮТ:", t[:110])

    if write:
        POT.write_text(HEADER + '"Language: \\n"\n\n' + "".join(f"msgid {quote(t)}\nmsgstr \"\"\n\n" for t in ids),
                       encoding="utf-8")
        PO_RU.write_text(HEADER + RU_HEADER + "".join(f"msgid {quote(t)}\nmsgstr {quote(old.get(t, ''))}\n\n" for t in ids),
                         encoding="utf-8")
        print("записаны po/templates/zapret2.pot и po/ru/zapret2.po")

    return 1 if (missing or broken) else 0


if __name__ == "__main__":
    sys.exit(main())
