#!/bin/sh
# SPDX-License-Identifier: MIT
#
# Установка и обновление openwrt-zapret из ПОСЛЕДНЕГО релиза GitHub. Запускается на роутере:
#
#   wget -O - https://github.com/FlamesC0der/openwrt-zapret/releases/latest/download/install.sh | sh
#
# Что делает:
#   1. определяет архитектуру роутера и менеджер пакетов (opkg или apk);
#   2. скачивает из последнего релиза нужные пакеты (zapret2, luci-app-zapret2, русский перевод);
#   3. проверяет их контрольные суммы (файл SHA256SUMS из того же релиза);
#   4. устанавливает пакеты; настройки и списки сохраняются.
#
# Переменные окружения (все необязательные):
#   ZAPRET_REPO=владелец/имя   другой репозиторий (по умолчанию FlamesC0der/openwrt-zapret)
#   ZAPRET_FORCE=1             не проверять версию OpenWrt (пакеты собраны для 24.10 и 25.12)
#   ZAPRET_NO_RU=1             не ставить русский перевод
#   ZAPRET_NO_INSTALL=1        только скачать и проверить, ничего не устанавливать
#   ZAPRET_BASE_URL=адрес      откуда качать файлы вместо страницы последнего релиза (для проверок)

set -eu

REPO="${ZAPRET_REPO:-FlamesC0der/openwrt-zapret}"
BASE="${ZAPRET_BASE_URL:-https://github.com/$REPO/releases/latest/download}"
TMP=/tmp/zapret2-install

say() { printf '%s\n' "$*"; }
die() { printf 'Ошибка: %s\n' "$*" >&2; exit 1; }

# скачать файл: $1 - адрес, $2 - куда сохранить
fetch() {
	if command -v uclient-fetch >/dev/null 2>&1; then
		uclient-fetch -q -O "$2" "$1"
	elif command -v wget >/dev/null 2>&1; then
		wget -q -O "$2" "$1"
	elif command -v curl >/dev/null 2>&1; then
		curl -fsSL -o "$2" "$1"
	else
		return 127
	fi
}

# Весь скрипт обёрнут в функцию: при запуске через "wget -O - ... | sh" shell читает скрипт из stdin,
# и команда, которая тоже читает stdin, «съела» бы остаток. Функция разбирается целиком до запуска.
main() {
	[ "$(id -u)" = 0 ] || die "запустите скрипт от root"
	[ -f /etc/openwrt_release ] || die "это не OpenWrt (нет /etc/openwrt_release)"
	# DISTRIB_RELEASE (например 24.10.8) и DISTRIB_ARCH (например aarch64_cortex-a53)
	. /etc/openwrt_release
	[ -n "${DISTRIB_ARCH:-}" ] || die "не удалось определить архитектуру роутера"

	if command -v apk >/dev/null 2>&1; then
		PM=apk
		EXT=apk
	elif command -v opkg >/dev/null 2>&1; then
		PM=opkg
		EXT=ipk
	else
		die "не найден менеджер пакетов (ни apk, ни opkg)"
	fi

	# готовые пакеты: .ipk собраны для OpenWrt 24.10, .apk - для 25.12
	case "$PM:${DISTRIB_RELEASE:-}" in
		opkg:24.10*|apk:25.*) ;;
		*)
			[ "${ZAPRET_FORCE:-0}" = 1 ] ||
				die "готовые пакеты собраны для OpenWrt 24.10 (opkg) и 25.12 (apk), а у вас ${DISTRIB_RELEASE:-?} ($PM).
Чтобы всё равно попробовать, запустите с ZAPRET_FORCE=1; либо соберите пакеты сами: ./build.sh (см. README)."
			;;
	esac

	say "OpenWrt ${DISTRIB_RELEASE:-?}, архитектура $DISTRIB_ARCH, менеджер пакетов $PM"

	rm -rf "$TMP"
	mkdir -p "$TMP"
	trap 'rm -rf "$TMP"' EXIT

	say "Ищу последний релиз..."
	fetch "$BASE/SHA256SUMS" "$TMP/SHA256SUMS" ||
		die "не удалось скачать список файлов релиза ($BASE/SHA256SUMS).
Проверьте интернет на роутере и что у проекта есть опубликованный релиз.
Для https нужны пакеты ca-bundle и libustream-mbedtls (в обычных сборках OpenWrt они есть)."

	# имя файла пакета из SHA256SUMS: $1 - имя пакета; подходит файл для вашей архитектуры или "all"
	pick() {
		awk -v pat="$1" -v ext="$EXT" -v arch="$DISTRIB_ARCH" '
			{ f = $2; sub(/^\*/, "", f) }
			f ~ ("^" pat "[_-][0-9]") && (f ~ ("_" arch "\\." ext "$") || f ~ ("_all\\." ext "$")) { print f; exit }
		' "$TMP/SHA256SUMS"
	}

	FILES=""
	for name in zapret2 luci-app-zapret2 luci-i18n-zapret2-ru; do
		[ "$name" = luci-i18n-zapret2-ru ] && [ "${ZAPRET_NO_RU:-0}" = 1 ] && continue
		f="$(pick "$name")"
		if [ -z "$f" ]; then
			[ "$name" = zapret2 ] &&
				die "в релизе нет пакета для вашей архитектуры ($DISTRIB_ARCH, .$EXT).
Соберите его сами: ./build.sh (см. README) или напишите в Issues проекта."
			die "в релизе нет файла $name для $DISTRIB_ARCH"
		fi
		FILES="$FILES $f"
	done

	# скачиваем и проверяем контрольные суммы
	INSTALL=""
	for f in $FILES; do
		say "Скачиваю $f"
		fetch "$BASE/$f" "$TMP/$f" || die "не удалось скачать $f"
		want="$(awk -v f="$f" '{ n = $2; sub(/^\*/, "", n) } n == f { print $1; exit }' "$TMP/SHA256SUMS")"
		got="$(sha256sum "$TMP/$f" | cut -d' ' -f1)"
		[ -n "$want" ] && [ "$want" = "$got" ] || die "контрольная сумма $f не совпала: файл повреждён или подменён"
		# apk-файлы в релизе названы с архитектурой (zapret2-1.0.7-r1_arch.apk): возвращаем обычное имя
		local_name="$f"
		if [ "$EXT" = apk ]; then
			local_name="$(printf '%s' "$f" | sed -e "s/_${DISTRIB_ARCH}\\.apk\$/.apk/" -e 's/_all\.apk$/.apk/')"
			[ "$local_name" = "$f" ] || mv "$TMP/$f" "$TMP/$local_name"
		fi
		INSTALL="$INSTALL $TMP/$local_name"
	done

	if [ "${ZAPRET_NO_INSTALL:-0}" = 1 ]; then
		say "Файлы скачены и проверены (устанавливать не просили):"
		for f in $INSTALL; do say "  $f"; done
		trap - EXIT
		exit 0
	fi

	say "Устанавливаю..."
	if [ "$PM" = opkg ]; then
		opkg update >/dev/null 2>&1 || say "Предупреждение: 'opkg update' не удался, зависимости могут не найтись."
		# shellcheck disable=SC2086
		opkg install $INSTALL </dev/null
	else
		apk update >/dev/null 2>&1 || say "Предупреждение: 'apk update' не удался, зависимости могут не найтись."
		# shellcheck disable=SC2086
		apk add --allow-untrusted $INSTALL </dev/null
	fi

	# интерфейс и плагин подхватят новые файлы
	rm -rf /tmp/luci-indexcache* /tmp/luci-modulecache 2>/dev/null || true
	/etc/init.d/rpcd restart >/dev/null 2>&1 || true

	say ""
	say "Готово. Откройте LuCI: Службы -> Zapret2 и нажмите «Включить»."
	say "Если страницы не видно, обновите её с очисткой кэша (Ctrl+Shift+R)."
}

main "$@"
