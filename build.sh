#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
#
# Сборка пакетов zapret и luci-app-zapret для OpenWrt на официальном SDK.
#
# Что делает скрипт:
#   1. определяет версию OpenWrt и скачивает для неё SDK (с проверкой sha256);
#   2. кладёт в SDK пакеты из этого репозитория (zapret, luci-app-zapret);
#   3. при сборке сам OpenWrt скачивает исходники zapret с
#      https://github.com/bol-van/zapret (PKG_SOURCE_URL + проверка PKG_HASH);
#   4. собирает nfqws/tpws/mdig/ip2net под архитектуру роутера и пакеты
#      .ipk (OpenWrt <= 24.10) или .apk (OpenWrt >= 25.12) в каталог out/.
#
# Linux собирает напрямую; на macOS (и вообще где угодно) используйте --docker.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

OPENWRT_VERSION="stable"          # stable | oldstable | 25.12.6 | 24.10.8 | ...
TARGET="x86/64"                   # target/subtarget роутера, см. https://downloads.openwrt.org
ZAPRET_VERSION=""                 # пусто = версия, закреплённая в zapret/Makefile; latest | 72.13 | ...
OUT_DIR="$ROOT/out"
WORK_DIR="${WORK_DIR:-$ROOT/.build}"
JOBS=""
USE_DOCKER=0
VERBOSE=0
CLEAN=0

usage() {
	cat <<EOF
Использование: $0 [опции]

  -t, --target <target/subtarget>  платформа роутера (по умолчанию: $TARGET)
                                   примеры: x86/64, mediatek/filogic, ath79/generic,
                                   ramips/mt7621, rockchip/armv8, bcm27xx/bcm2711
  -v, --openwrt <версия>           stable (по умолчанию), oldstable или конкретная: 25.12.6, 24.10.8
  -z, --zapret-version <версия>    версия zapret: latest или номер (72.13).
                                   По умолчанию - закреплённая в zapret/Makefile (проверенная).
  -o, --out <каталог>              куда положить готовые пакеты (по умолчанию: out/)
  -j, --jobs <N>                   число параллельных задач make (по умолчанию: число ядер)
      --docker                     собрать внутри Docker-контейнера (нужно на macOS)
      --clean                      удалить распакованный SDK перед сборкой (кэш скачанного остаётся)
      --verbose                    подробный вывод make (V=s)
  -h, --help                       эта справка

Примеры:
  $0 --target mediatek/filogic
  $0 --docker --target ramips/mt7621 --openwrt 24.10.8
EOF
}

log() { printf '\033[1;32m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m!!>\033[0m %s\n' "$*" >&2; }
die() { printf '\033[1;31mxx>\033[0m %s\n' "$*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || die "не найдена команда '$1'"; }

while [ $# -gt 0 ]; do
	case "$1" in
		-t|--target) TARGET="${2:?}"; shift 2 ;;
		-v|--openwrt) OPENWRT_VERSION="${2:?}"; shift 2 ;;
		-z|--zapret-version) ZAPRET_VERSION="${2:?}"; shift 2 ;;
		-o|--out) OUT_DIR="${2:?}"; shift 2 ;;
		-j|--jobs) JOBS="${2:?}"; shift 2 ;;
		--docker) USE_DOCKER=1; shift ;;
		--no-docker) USE_DOCKER=0; shift ;;
		--clean) CLEAN=1; shift ;;
		--verbose) VERBOSE=1; shift ;;
		-h|--help) usage; exit 0 ;;
		*) usage >&2; die "неизвестный параметр: $1" ;;
	esac
done

case "$TARGET" in
	*/*) ;;
	*) die "target должен быть вида target/subtarget, например x86/64" ;;
esac

sha256_of() {
	if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1
	else shasum -a 256 "$1" | cut -d' ' -f1; fi
}

# --- версия OpenWrt и SDK (используется и на хосте при --docker) -------------------

curl_opts() {
	# индикатор прогресса только в терминале, в логах - тихо
	if [ -t 2 ]; then printf '%s\n' --progress-bar; else printf '%s\n' -sS; fi
}

resolve_openwrt_version() {
	case "$OPENWRT_VERSION" in
		stable|oldstable)
			local key="${OPENWRT_VERSION}_version" v
			v="$(curl -fsSL https://downloads.openwrt.org/.versions.json |
				sed -n "s/.*\"$key\": *\"\([^\"]*\)\".*/\1/p")"
			[ -n "$v" ] || die "не удалось узнать версию '$OPENWRT_VERSION' из .versions.json"
			OPENWRT_VERSION="$v"
			;;
	esac
}

# скачивает SDK в $WORK_DIR/dl (если ещё нет) и проверяет sha256; выставляет SDK_FILE
fetch_sdk() {
	local base sums line sha
	base="https://downloads.openwrt.org/releases/$OPENWRT_VERSION/targets/$TARGET"
	mkdir -p "$WORK_DIR/dl"

	log "Ищу SDK на downloads.openwrt.org"
	sums="$(curl -fsSL "$base/sha256sums")" || die "нет такой платформы/версии: $base"
	line="$(printf '%s\n' "$sums" | grep -E ' \*?openwrt-sdk-.*\.tar\.(zst|xz)$' | head -n1 || true)"
	[ -n "$line" ] || die "SDK для $TARGET в $OPENWRT_VERSION не найден"
	sha="${line%% *}"
	SDK_FILE="${line##* }"; SDK_FILE="${SDK_FILE#\*}"

	if [ ! -f "$WORK_DIR/dl/$SDK_FILE" ] || [ "$(sha256_of "$WORK_DIR/dl/$SDK_FILE")" != "$sha" ]; then
		log "Скачиваю $SDK_FILE"
		# shellcheck disable=SC2046
		curl -fL --retry 3 -C - $(curl_opts) -o "$WORK_DIR/dl/$SDK_FILE" "$base/$SDK_FILE"
		[ "$(sha256_of "$WORK_DIR/dl/$SDK_FILE")" = "$sha" ] || die "контрольная сумма SDK не совпала"
	fi
}

# --- Docker --------------------------------------------------------------------

run_in_docker() {
	need docker
	need curl
	docker info >/dev/null 2>&1 || die "демон Docker не запущен"

	local uid image
	local -a args=()
	uid="$(id -u)"
	image="openwrt-zapret-builder:$uid"

	# SDK качаем на хосте: сеть внутри виртуальной машины Docker часто в разы медленнее
	resolve_openwrt_version
	log "OpenWrt $OPENWRT_VERSION, платформа $TARGET"
	fetch_sdk

	if docker image inspect "$image" >/dev/null 2>&1; then
		log "Образ сборки $image уже готов"
	else
		log "Собираю образ сборки $image (один раз: 5-15 минут, под эмуляцией x86 - дольше;"
		log "предупреждение 'legacy builder is deprecated' безобидно, вывод docker ниже - это нормально)"
		docker build --platform linux/amd64 --build-arg "UID=$uid" -t "$image" - <<'EOF'
FROM ubuntu:24.04
ARG UID=1000
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
        build-essential clang flex bison g++ gawk gettext git libncurses-dev libssl-dev \
        python3 python3-setuptools rsync swig unzip zlib1g-dev file wget curl ca-certificates \
        zstd xz-utils xsltproc libelf-dev \
    && rm -rf /var/lib/apt/lists/*
RUN (userdel -r ubuntu 2>/dev/null || true) && useradd -m -u "${UID}" builder \
    && mkdir -p /work /out && chown "${UID}" /work /out
USER builder
WORKDIR /src
EOF
	fi

	args+=(--target "$TARGET" --openwrt "$OPENWRT_VERSION" --out /out --no-docker)
	[ -n "$ZAPRET_VERSION" ] && args+=(--zapret-version "$ZAPRET_VERSION")
	[ -n "$JOBS" ] && args+=(--jobs "$JOBS")
	[ "$CLEAN" = 1 ] && args+=(--clean)
	[ "$VERBOSE" = 1 ] && args+=(--verbose)

	mkdir -p "$OUT_DIR"
	# Распакованный SDK лежит в docker-томе, а не в bind-mount: на macOS файловая
	# система регистронезависима, а сборка OpenWrt требует регистрозависимой.
	# Скачанные архивы (кэш на хосте) монтируются как есть.
	log "Запускаю сборку в контейнере (SDK кэшируется в томе openwrt-zapret-work)"
	docker run --rm --platform linux/amd64 \
		-v "$ROOT":/src:ro \
		-v openwrt-zapret-work:/work \
		-v "$WORK_DIR/dl":/work/dl \
		-v "$OUT_DIR":/out \
		-e WORK_DIR=/work \
		"$image" /src/build.sh "${args[@]}"
}

if [ "$USE_DOCKER" = 1 ]; then
	run_in_docker
	exit 0
fi

# --- нативная сборка (Linux) -----------------------------------------------------

[ "$(uname -s)" = Linux ] || die "SDK OpenWrt работает только в Linux. Запустите с --docker."
[ "$(id -u)" != 0 ] || die "не запускайте сборку от root (OpenWrt это не любит); используйте обычного пользователя"
for c in curl tar make gcc git python3 awk; do need "$c"; done
[ -n "$JOBS" ] || JOBS="$(nproc 2>/dev/null || echo 2)"

# 1-2. версия OpenWrt и SDK
resolve_openwrt_version
log "OpenWrt $OPENWRT_VERSION, платформа $TARGET"
fetch_sdk

SDK_DIR="$WORK_DIR/sdk-$OPENWRT_VERSION-$(printf '%s' "$TARGET" | tr / -)"
[ "$CLEAN" = 1 ] && rm -rf "$SDK_DIR"
if [ ! -d "$SDK_DIR" ]; then
	log "Распаковываю SDK"
	mkdir -p "$SDK_DIR.tmp"
	case "$SDK_FILE" in
		*.zst) need zstd; tar -I zstd -xf "$WORK_DIR/dl/$SDK_FILE" -C "$SDK_DIR.tmp" --strip-components=1 ;;
		*.xz)  tar -xJf "$WORK_DIR/dl/$SDK_FILE" -C "$SDK_DIR.tmp" --strip-components=1 ;;
	esac
	mv "$SDK_DIR.tmp" "$SDK_DIR"
fi

cd "$SDK_DIR"

# 3. наши пакеты кладём в SDK (исходников zapret здесь нет - их скачает сборка)
log "Копирую пакеты из репозитория в SDK"
for p in zapret luci-app-zapret; do
	rm -rf "package/$p"
	mkdir -p "package/$p"
	tar -C "$ROOT/$p" --exclude='.DS_Store' -cf - . | tar -C "package/$p" -xf -
done

# 4. версия zapret
resolve_zapret_version() {
	[ -n "$ZAPRET_VERSION" ] || return 0

	if [ "$ZAPRET_VERSION" = latest ]; then
		local tag
		tag="$(curl -fsSL https://api.github.com/repos/bol-van/zapret/releases/latest |
			sed -n 's/.*"tag_name": *"\([^"]*\)".*/\1/p')"
		[ -n "$tag" ] || die "не удалось узнать последнюю версию zapret на GitHub"
		ZAPRET_VERSION="${tag#v}"
	else
		ZAPRET_VERSION="${ZAPRET_VERSION#v}"
	fi

	local pinned
	pinned="$(sed -n 's/^PKG_VERSION:=//p' package/zapret/Makefile)"
	if [ "$ZAPRET_VERSION" = "$pinned" ]; then
		log "zapret $ZAPRET_VERSION - версия, закреплённая в Makefile"
		return 0
	fi

	warn "zapret $ZAPRET_VERSION отличается от проверенной ($pinned): скрипты upstream могли измениться"
	log "Скачиваю zapret v$ZAPRET_VERSION с GitHub для расчёта хэша"
	mkdir -p dl
	curl -fL --retry 3 -o "dl/zapret-$ZAPRET_VERSION.tar.gz" \
		"https://codeload.github.com/bol-van/zapret/tar.gz/v$ZAPRET_VERSION" ||
		die "нет релиза v$ZAPRET_VERSION в bol-van/zapret"
	local hash
	hash="$(sha256_of "dl/zapret-$ZAPRET_VERSION.tar.gz")"
	sed -i "s/^PKG_VERSION:=.*/PKG_VERSION:=$ZAPRET_VERSION/; s/^PKG_HASH:=.*/PKG_HASH:=$hash/" package/zapret/Makefile
}
resolve_zapret_version

# 5. feeds: base (libmnl, libnfnetlink, zlib, libcap, ca-bundle), packages (libnetfilter-queue,
#    curl) и luci (luci.mk, luci-base). Ставим только нужные пакеты - зависимости подтянутся сами.
log "Обновляю feeds (base, packages, luci)"
./scripts/feeds update base packages luci
#    lua и csstidy - host-инструменты, которые требует luci.mk при сборке luci-приложений.
./scripts/feeds install libnetfilter-queue libnfnetlink libmnl zlib libcap curl ca-bundle \
	luci-base lua csstidy

# 6. конфигурация и сборка
cat >> .config <<'EOF'
CONFIG_PACKAGE_zapret=m
CONFIG_PACKAGE_luci-app-zapret=m
CONFIG_PACKAGE_luci-i18n-zapret-ru=m
EOF
make defconfig >/dev/null

MAKE_V=""
[ "$VERBOSE" = 1 ] && MAKE_V="V=s"

log "Собираю (исходники zapret скачиваются автоматически)"
if ! make package/zapret/compile package/luci-app-zapret/compile -j"$JOBS" $MAKE_V; then
	warn "сборка не удалась; повторяю в один поток с подробным выводом, чтобы показать ошибку"
	make package/zapret/compile package/luci-app-zapret/compile -j1 V=s
fi

# 7. результат
mkdir -p "$OUT_DIR"
found=0
while IFS= read -r f; do
	cp -f "$f" "$OUT_DIR/"
	log "  $(basename "$f")"
	found=1
done < <(find bin/packages bin/targets -type f \
	\( -name 'zapret*.ipk' -o -name 'zapret*.apk' \
	-o -name 'luci-app-zapret*.ipk' -o -name 'luci-app-zapret*.apk' \
	-o -name 'luci-i18n-zapret*.ipk' -o -name 'luci-i18n-zapret*.apk' \) 2>/dev/null | sort)

[ "$found" = 1 ] || die "готовых пакетов не найдено в bin/ - см. вывод сборки выше"

log "Готово. Пакеты в $OUT_DIR"
case "$(ls "$OUT_DIR" | head -n1)" in
	*.apk) echo "  Установка на роутере:  apk add --allow-untrusted /tmp/zapret-*.apk /tmp/luci-app-zapret-*.apk /tmp/luci-i18n-zapret-ru-*.apk" ;;
	*)     echo "  Установка на роутере:  opkg install /tmp/zapret_*.ipk /tmp/luci-app-zapret_*.ipk /tmp/luci-i18n-zapret-ru_*.ipk" ;;
esac
