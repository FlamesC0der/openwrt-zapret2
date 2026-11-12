#!/bin/sh
# SPDX-License-Identifier: MIT
#
# Фоновые задачи zapret2 (запускаются из LuCI, cron или консоли).
#
# <job>: update-lists | update-presets | update-all | blockcheck | diagnose

. /usr/libexec/zapret2/env.sh

RUNDIR=/var/run/zapret2-jobs
LOGDIR=/var/log/zapret2

MAX_LIST_BYTES=8388608     # 8 MiB: список больше - скорее всего не список
MAX_PRESET_BYTES=1048576   # 1 MiB на комплект пресетов

usage()
{
	cat >&2 <<-EOF
		usage: job.sh start  <job> [KEY=VALUE...]   run in background, log: $LOGDIR/<job>.log
		       job.sh run    <job> [KEY=VALUE...]   run in the foreground
		       job.sh cron   update-all             for cron: output goes to syslog
		       job.sh cron-sync                     refresh the cron entry after list changes
		       job.sh stop   <job>                  stop the job (whole process group)
		       job.sh status <job>                  prints running | stopped
		jobs: update-lists, update-presets, update-all, blockcheck, diagnose
	EOF
	exit 2
}

valid_job()
{
	case "$1" in
		update-lists|update-presets|update-all|blockcheck|diagnose) return 0 ;;
	esac
	echo "unknown job: $1" >&2
	return 1
}

# печатает pid, если задача жива
job_pid()
{
	local pid
	pid="$(cat "$RUNDIR/$1.pid" 2>/dev/null)"
	[ -n "$pid" ] && kill -0 "$pid" 2>/dev/null && echo "$pid"
}

job_start()
{
	local job="$1"
	shift
	valid_job "$job" || return 2
	if [ -n "$(job_pid "$job")" ]; then
		echo "$job is already running" >&2
		return 1
	fi
	mkdir -p "$RUNDIR" "$LOGDIR"
	: >"$LOGDIR/$job.log"
	if command -v setsid >/dev/null 2>&1; then
		setsid "$0" run "$job" "$@" >>"$LOGDIR/$job.log" 2>&1 </dev/null &
	else
		"$0" run "$job" "$@" >>"$LOGDIR/$job.log" 2>&1 </dev/null &
	fi
	echo $! >"$RUNDIR/$job.pid"
	return 0
}

job_stop()
{
	local pid
	valid_job "$1" || return 2
	pid="$(job_pid "$1")"
	[ -n "$pid" ] || return 0
	# при запуске через setsid pid == pgid: завершаем всю группу (curl, nfqws2, ...)
	kill -TERM -- "-$pid" 2>/dev/null && return 0
	pkill -TERM -P "$pid" 2>/dev/null
	kill -TERM "$pid" 2>/dev/null
	return 0
}

job_status()
{
	if [ -n "$(job_pid "$1")" ]; then echo running; else echo stopped; fi
}

now() { date '+%F %T'; }

# --- загрузка текстового файла ----------------------------------------------------

# $1 - url, $2 - файл назначения, $3 - макс. размер (байт)
# Качает во временный файл, проверяет, что это текст, и только потом подменяет файл.
fetch_text()
{
	local url="$1" dest="$2" max="$3" tmp
	case "$url" in
		http://*|https://*) ;;
		*) echo "  unsupported URL (only http/https): $url" >&2; return 1 ;;
	esac
	tmp="$(mktemp /tmp/zapret2-dl.XXXXXX)" || return 1

	if ! curl -fsSL --connect-timeout 10 --max-time 120 --retry 2 --max-filesize "$max" -o "$tmp" "$url"; then
		echo "  download failed: $url" >&2
		rm -f "$tmp"
		return 1
	fi
	if [ ! -s "$tmp" ]; then
		echo "  empty response: $url" >&2
		rm -f "$tmp"
		return 1
	fi
	# текст без NUL-байтов и не HTML-страница (заглушка/ошибка сервера)
	if ! tr -d '\000' <"$tmp" | cmp -s - "$tmp"; then
		echo "  not a text file: $url" >&2
		rm -f "$tmp"
		return 1
	fi
	if head -c 1024 "$tmp" | grep -qi '<html\|<!doctype'; then
		echo "  got an HTML page instead of a list: $url" >&2
		rm -f "$tmp"
		return 1
	fi
	# nfqws2 перечитывает листы по SIGHUP уже под непривилегированным пользователем: нужен доступ на чтение
	tr -d '\r' <"$tmp" >"$dest.new" && chmod 0644 "$dest.new" && mv -f "$dest.new" "$dest"
	rm -f "$tmp" "$dest.new"
	return 0
}

# --- update-lists -----------------------------------------------------------------

# вызывается из config_foreach для каждой секции "userlist"
dl_userlist()
{
	local id="$1" url kind
	config_get url "$id" url
	[ -n "$url" ] || return 0
	if ! zapret_valid_id "$id"; then
		echo "* skipping list with invalid id: $id" >&2
		return 0
	fi
	echo "* list '$id': $url"
	if fetch_text "$url" "$ZAPRET_RW/lists/$id.txt" "$MAX_LIST_BYTES"; then
		config_get kind "$id" kind hosts
		zapret_list_guard "$ZAPRET_RW/lists/$id.txt" "$kind"
		echo "  ok: $(wc -l <"$ZAPRET_RW/lists/$id.txt" | tr -d ' ') lines"
		LISTS_UPDATED=1
	else
		LISTS_FAILED=1
	fi
}

job_update_lists()
{
	local script rc=0
	LISTS_UPDATED=0
	LISTS_FAILED=0

	zapret_prepare
	. "$ZAPRET_CONFIG"
	. /lib/functions.sh
	mkdir -p "$ZAPRET_RW/lists"

	echo "== $(now) update lists"

	# 1. списки upstream (скрипт из GETLIST; get_ipban.sh нужен только режиму ipset)
	script="$GETLIST"
	[ -n "$script" ] || { [ "$MODE_FILTER" = ipset ] && script=get_ipban.sh; }
	if [ -n "$script" ]; then
		case "$script" in
			*/*|.*)
				echo "invalid GETLIST value: $script" >&2
				return 1
				;;
		esac
		if [ -x "$ZAPRET_BASE/ipset/$script" ]; then
			echo "* $script"
			"$ZAPRET_BASE/ipset/$script" || { echo "  $script failed" >&2; rc=1; }
		else
			echo "list script not found: $ZAPRET_BASE/ipset/$script" >&2
			rc=1
		fi
	fi

	# 2. свои списки с URL
	config_load "$ZAPRET_UCI"
	config_foreach dl_userlist userlist
	[ "$LISTS_FAILED" = 1 ] && rc=1

	# nfqws2 перечитывает листы по SIGHUP
	[ "$LISTS_UPDATED" = 1 ] && { killall -HUP nfqws2 2>/dev/null; echo "* nfqws2 told to reload lists"; }

	echo "== $(now) finished, exit code $rc"
	return $rc
}

# --- update-presets ----------------------------------------------------------------

# $1 - url. Комплект: файлы пресетов подряд, каждый начинается со строки "#@id: <id>".
# Без таких строк весь файл считается одним пресетом, id берётся из имени файла в URL.
fetch_presets_from()
{
	local url="$1" src dir dst id f n=0 base

	src="$(mktemp /tmp/zapret2-presets.XXXXXX)" || return 1
	dir="$(mktemp -d /tmp/zapret2-presets.XXXXXX)" || { rm -f "$src"; return 1; }
	dst="$ZAPRET_RW/presets/downloaded"

	if ! fetch_text "$url" "$src" "$MAX_PRESET_BYTES"; then
		rm -f "$src"
		rm -r "$dir"
		return 1
	fi

	awk -v dir="$dir" -v url="$url" '
		/^#@id:/ {
			id = $0; sub(/^#@id:[ \t]*/, "", id); sub(/[ \t]+$/, "", id)
			if (id ~ /^[a-z0-9][a-z0-9_-]*$/ && length(id) <= 40 && n < 64) {
				n++; out = dir "/" id ".preset"; print "#@source: " url > out
			} else out = ""
			next
		}
		out != "" { print >> out }
	' "$src"

	if ! ls "$dir"/*.preset >/dev/null 2>&1; then
		# нет разделителей: один пресет, id из имени файла
		base="$(basename "${url%%\?*}")"
		id="$(printf '%s' "${base%.*}" | tr 'A-Z' 'a-z' | tr -c 'a-z0-9_-' '-' | cut -c1-40)"
		id="${id#-}"
		if zapret_valid_id "$id"; then
			{ echo "#@source: $url"; cat "$src"; } >"$dir/$id.preset"
		fi
	fi

	if ! ls "$dir"/*.preset >/dev/null 2>&1; then
		echo "  no presets found in: $url" >&2
		rm -f "$src"
		rm -r "$dir"
		return 1
	fi

	# убрать ранее скачанные из этого же источника, затем положить новые
	for f in "$dst"/*.preset; do
		[ -f "$f" ] || continue
		grep -qxF "#@source: $url" "$f" && rm -f "$f"
	done
	for f in "$dir"/*.preset; do
		id="$(basename "$f" .preset)"
		mv -f "$f" "$dst/$id.preset"
		echo "  preset: $id"
		n=$((n + 1))
	done
	rm -f "$src"
	rm -r "$dir"
	return 0
}

# хэш итогового config без служебной строки "# stamp:" (она меняется и без реальных изменений)
config_fingerprint()
{
	grep -v '^# stamp:' "$ZAPRET_CONFIG" | md5sum
}

job_update_presets()
{
	local url urls rc=0 count=0 before after

	zapret_prepare
	before="$(config_fingerprint)"
	. /lib/functions.sh
	config_load "$ZAPRET_UCI"
	config_get urls main preset_url
	mkdir -p "$ZAPRET_RW/presets/downloaded"

	echo "== $(now) update presets"
	if [ -z "$urls" ]; then
		echo "no preset_url is configured (Settings -> Presets)" >&2
		return 1
	fi
	for url in $urls; do
		echo "* $url"
		fetch_presets_from "$url" && count=$((count + 1)) || rc=1
	done
	# изменение пресетов меняет отпечаток: config пересобирается, и если из-за этого
	# изменился итоговый NFQWS2_OPT (например, обновился активный пресет) - применяем
	zapret_prepare
	after="$(config_fingerprint)"
	if [ "$after" != "$before" ] && [ -f "$ZAPRET_STATE" ]; then
		echo "* active configuration changed, restarting nfqws2"
		/etc/init.d/zapret2 restart_daemons >/dev/null 2>&1
	fi
	echo "== $(now) finished, sources ok: $count, exit code $rc"
	return $rc
}

job_update_all()
{
	local rc=0
	job_update_lists || rc=1
	zapret_prepare
	. "$ZAPRET_CONFIG"
	if [ "$ZAPRET2_PRESETS_AUTO_UPDATE" = 1 ]; then
		job_update_presets || rc=1
	fi
	if [ "$ZAPRET2_UPDATE_CHECK" = 1 ]; then
		echo "* checking for a new version"
		# the check itself lives in the rpcd plugin (it is also used by the web interface)
		ubus call luci.zapret2 check_update 2>/dev/null | sed -n 's/^[[:space:]]*"summary": *"\(.*\)",\{0,1\}$/  \1/p'
	fi
	return $rc
}

# --- blockcheck2 --------------------------------------------------------------------

BC_WAS_RUNNING=0
BC_RESTORED=0

blockcheck_restore()
{
	[ "$BC_RESTORED" = 1 ] && return 0
	BC_RESTORED=1
	if [ "$BC_WAS_RUNNING" = 1 ]; then
		echo "* starting zapret2 service again"
		/etc/init.d/zapret2 start
	fi
}

job_blockcheck()
{
	local kv

	# в окружение blockcheck2 попадают только известные переменные с безопасными значениями
	for kv in "$@"; do
		case "$kv" in
			*[!A-Za-z0-9._\ =,:-]*) continue ;;
		esac
		case "$kv" in
			DOMAINS=*|SCANLEVEL=*|IPVS=*|REPEATS=*|PARALLEL=*|CURL_MAX_TIME=*|\
			ENABLE_HTTP=*|ENABLE_HTTPS_TLS12=*|ENABLE_HTTPS_TLS13=*|ENABLE_HTTP3=*|\
			SKIP_DNSCHECK=*|SKIP_IPBLOCK=*|SECURE_DNS=*)
				export "$kv"
				;;
		esac
	done

	zapret_prepare
	[ -f "$ZAPRET_STATE" ] && BC_WAS_RUNNING=1
	if [ "$BC_WAS_RUNNING" = 1 ]; then
		echo "* stopping zapret2 for the duration of the test (it will be started again)"
		/etc/init.d/zapret2 stop
	fi

	BATCH=1 "$ZAPRET_BASE/blockcheck2.sh"
}

# --- diagnose: обрыв TCP-соединения на 16-20 КБ ------------------------------------
#
# Повторяет проверку проекта hyperion-cs/dpi-checkers (https://hyperion-cs.github.io/dpi-checkers/ru/tcp-16-20/):
# некоторые провайдеры обрывают TCP-соединение к зарубежным хостингам и CDN, когда клиент отправил 16-20 КБ.
# Для каждого хоста из списка проекта:
#   1. HEAD https://хост/ - жив ли он (таймаут = "нет", другая ошибка = "неизвестно");
#   2. POST 64 КиБ случайных данных; если соединение зависло - обрыв обнаружен;
#   3. иначе 10 запросов HEAD с URI по 7 КБ в одном соединении (те же 64 КиБ) - зависание = обрыв обнаружен;
#   4. найденный обрыв проверяется ещё раз: если повтор прошёл, результат понижается до "возможно".
# Результат пишется построчно (TSV) в $DIAG_DIR/on.tsv или off.tsv - по тому, работал ли nfqws2 во время проверки.

DIAG_DIR=/var/run/zapret2-diag
DIAG_SUITE_URL=https://hyperion-cs.github.io/dpi-checkers/ru/tcp-16-20/suite.v2.json
DIAG_MAX_HOSTS=60
DIAG_PARALLEL=8

# хост - только DNS-имя (не IP-адрес и не адрес с портом): список приходит из сети
diag_valid_host()
{
	case "$1" in
		''|*[!A-Za-z0-9.-]*|.*|*.|-*|*..*) return 1 ;;
	esac
	[ ${#1} -le 100 ] || return 1
	case "$1" in
		*.*) ;;
		*) return 1 ;;
	esac
	# хотя бы одна буква: чисто цифровое "имя" - это IPv4-адрес
	case "$1" in
		*[A-Za-z]*) return 0 ;;
	esac
	return 1
}

# текст из внешнего списка: без управляющих символов, табуляции и разделителя "|", не длиннее $2 символов
diag_clean()
{
	printf '%s' "$1" | tr -d '\000-\037|' | cut -c1-"$2"
}

# $1 - код curl, $2 - alive (yes|unknown) -> no | detected | probably | possible | unlikely
diag_verdict()
{
	case "$1" in
		0)  echo no ;;
		28) [ "$2" = yes ] && echo detected || echo probably ;;
		*)  [ "$2" = yes ] && echo possible || echo unlikely ;;
	esac
}

# провайдер клиента по данным RIPE Stat (необязательно: при любой ошибке строка просто не пишется)
diag_asn()
{
	local ip j asn holder country city
	ip="$(curl -s -m 8 https://stat.ripe.net/data/whats-my-ip/data.json 2>/dev/null | jsonfilter -e '@.data.ip' 2>/dev/null)"
	case "$ip" in ''|*[!0-9a-fA-F.:]*) return 0 ;; esac
	j="$(curl -s -m 8 "https://stat.ripe.net/data/prefix-overview/data.json?resource=$ip" 2>/dev/null)"
	asn="$(printf '%s' "$j" | jsonfilter -e '@.data.asns[0].asn' 2>/dev/null)"
	case "$asn" in ''|*[!0-9]*) return 0 ;; esac
	holder="$(diag_clean "$(printf '%s' "$j" | jsonfilter -e '@.data.asns[0].holder' 2>/dev/null)" 80)"
	j="$(curl -s -m 8 "https://stat.ripe.net/data/maxmind-geo-lite/data.json?resource=$ip" 2>/dev/null)"
	country="$(diag_clean "$(printf '%s' "$j" | jsonfilter -e '@.data.located_resources[0].locations[0].country' 2>/dev/null)" 8)"
	city="$(diag_clean "$(printf '%s' "$j" | jsonfilter -e '@.data.located_resources[0].locations[0].city' 2>/dev/null)" 60)"
	printf '#asn\t%s\t%s\t%s\t%s\n' "$asn" "$holder" "$country" "$city"
}

# список хостов -> $DIAG_DIR/suite.tsv (номер|id|провайдер|страна|хост); сначала с сайта проекта, иначе встроенный
diag_load_suite()
{
	local src="$DIAG_DIR/suite.json" n i id provider country host total=0

	if curl -fsSL --connect-timeout 8 -m 20 --max-filesize 65536 -o "$src" "$DIAG_SUITE_URL" 2>/dev/null &&
		[ -n "$(jsonfilter -i "$src" -e '@[0].host' 2>/dev/null)" ]; then
		echo "* host list: $DIAG_SUITE_URL"
	else
		echo "* the host list could not be downloaded, using the built-in one"
		cp "$ZAPRET_BASE/diag-suite.json" "$src" || return 1
	fi

	n="$(jsonfilter -i "$src" -e '@[*]' | wc -l | tr -d ' ')"
	[ "$n" -gt "$DIAG_MAX_HOSTS" ] && n=$DIAG_MAX_HOSTS
	: >"$DIAG_DIR/suite.tsv"
	i=0
	while [ "$i" -lt "$n" ]; do
		host="$(jsonfilter -i "$src" -e "@[$i].host")"
		if diag_valid_host "$host"; then
			total=$((total + 1))
			id="$(diag_clean "$(jsonfilter -i "$src" -e "@[$i].id")" 24)"
			provider="$(diag_clean "$(jsonfilter -i "$src" -e "@[$i].provider")" 40)"
			country="$(diag_clean "$(jsonfilter -i "$src" -e "@[$i].country")" 16)"
			printf '%s|%s|%s|%s|%s\n' "$total" "${id:-$host}" "${provider:-?}" "$country" "$host" >>"$DIAG_DIR/suite.tsv"
		else
			echo "* skipping an invalid host name in the list: $(diag_clean "$host" 40)"
		fi
		i=$((i + 1))
	done
	[ "$total" -gt 0 ]
}

# одна проверка хоста на обрыв: $1 хост, $2 жив ли он (yes|unknown), $3 метка запроса -> no | detected | probably | possible | unlikely
diag_dpi()
{
	local host="$1" alive="$2" tag="$3" t="$DIAG_TIMEOUT" dpi i urls

	curl -s -o /dev/null --http1.1 -m "$t" -X POST -H 'Content-Type: application/octet-stream' \
		--data-binary "@$DIAG_DIR/body.bin" "https://$host/?t=$tag-p"
	dpi="$(diag_verdict $? "$alive")"
	if [ "$dpi" != detected ]; then
		urls=""
		i=0
		while [ $i -lt 10 ]; do
			urls="$urls https://$host/?x=$DIAG_X&t=$tag-$i"
			i=$((i + 1))
		done
		# одно соединение, запросы подряд; первая же ошибка прекращает проверку
		curl -s -I --http1.1 -m "$t" --fail-early $urls >/dev/null 2>&1
		dpi="$(diag_verdict $? "$alive")"
	fi
	echo "$dpi"
}

# $1 номер, $2 id, $3 провайдер, $4 страна, $5 хост, $6 файл результата
diag_host()
{
	local n="$1" id="$2" provider="$3" country="$4" host="$5" out="$6"
	local alive dpi again

	curl -s -I -o /dev/null --http1.1 -m "$DIAG_TIMEOUT" "https://$host/?t=$n-$$"
	case $? in
		0)  alive=yes ;;
		28) alive=no ;;
		*)  alive=unknown ;;
	esac

	if [ "$alive" = no ]; then
		dpi=skip
	else
		dpi="$(diag_dpi "$host" "$alive" "$n-$$")"
		# Настоящий DPI режет соединение каждый раз, а случайный таймаут (перегруженный сервер, лимит запросов)
		# бывает разовым: найденный обрыв проверяем ещё раз, и если повтор прошёл - результат лишь "возможно".
		if [ "$dpi" = detected ]; then
			again="$(diag_dpi "$host" "$alive" "$n-$$-again")"
			[ "$again" = detected ] || dpi=possible
		fi
	fi

	printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$n" "$id" "$provider" "$country" "$host" "$alive" "$dpi" >>"$out"
}

# один проход по списку; состояние (on|off) определяется по тому, работает ли nfqws2
diag_pass()
{
	local state out n id provider country host running=0

	if [ -f "$ZAPRET_STATE" ] && pidof nfqws2 >/dev/null 2>&1; then state=on; else state=off; fi
	out="$DIAG_DIR/$state.tsv"
	echo "== $(now) check, zapret2 is $state"
	{
		printf '#run\t%s\t%s\t%s\n' "$(date +%s)" "$state" "$(uci -q get zapret2.main.preset)"
		diag_asn
		printf '#total\t%s\n' "$(wc -l <"$DIAG_DIR/suite.tsv" | tr -d ' ')"
	} >"$out"

	while IFS='|' read -r n id provider country host; do
		diag_host "$n" "$id" "$provider" "$country" "$host" "$out" &
		running=$((running + 1))
		if [ "$running" -ge "$DIAG_PARALLEL" ]; then
			wait
			running=0
		fi
	done <"$DIAG_DIR/suite.tsv"
	wait
	printf '#done\t%s\n' "$(date +%s)" >>"$out"
	echo "* finished: $(grep -c '^[0-9]' "$out") hosts, detected: $(awk -F'\t' '$7=="detected"' "$out" | wc -l | tr -d ' ')"
}

job_diagnose()
{
	local kv host="" compare=0

	DIAG_TIMEOUT=15
	for kv in "$@"; do
		case "$kv" in
			HOST=*)    host="${kv#HOST=}" ;;
			TIMEOUT=*) DIAG_TIMEOUT="${kv#TIMEOUT=}" ;;
			COMPARE=*) compare="${kv#COMPARE=}" ;;
		esac
	done
	case "$DIAG_TIMEOUT" in
		''|*[!0-9]*) echo "invalid TIMEOUT" >&2; return 2 ;;
	esac
	if [ "$DIAG_TIMEOUT" -lt 5 ] || [ "$DIAG_TIMEOUT" -gt 60 ]; then
		echo "TIMEOUT must be 5..60 seconds" >&2
		return 2
	fi
	if [ -n "$host" ] && ! diag_valid_host "$host"; then
		echo "invalid host name: $host" >&2
		return 2
	fi

	mkdir -p "$DIAG_DIR"
	# 64 КиБ случайных данных для POST и случайная строка для длинных URI (7168 символов)
	head -c 65536 /dev/urandom >"$DIAG_DIR/body.bin"
	DIAG_X="$(head -c 40000 /dev/urandom | tr -dc 'A-Za-z0-9' | head -c 7168)"

	if [ -n "$host" ]; then
		printf '1|CUSTOM-01|Custom||%s\n' "$host" >"$DIAG_DIR/suite.tsv"
	else
		diag_load_suite || { echo "no hosts to check" >&2; return 1; }
	fi

	diag_pass
	# для сравнения: то же самое при остановленном zapret2 (сервис запускается снова в job_cleanup)
	if [ "$compare" = 1 ] && [ -f "$ZAPRET_STATE" ]; then
		BC_WAS_RUNNING=1
		echo "* stopping zapret2 for the comparison run (it will be started again)"
		/etc/init.d/zapret2 stop
		sleep 2
		diag_pass
	fi
}

job_cleanup()
{
	case "$JOB" in
		blockcheck) blockcheck_restore ;;
		diagnose)
			blockcheck_restore
			rm -f "$DIAG_DIR/body.bin" "$DIAG_DIR/suite.json" "$DIAG_DIR/suite.tsv"
			;;
	esac
	rm -f "$RUNDIR/$JOB.pid"
}

# ---------------------------------------------------------------------------

[ $# -ge 1 ] || usage
CMD="$1"
shift
JOB="$1"
[ $# -ge 1 ] && shift

case "$CMD" in
	start)  job_start "$JOB" "$@" ;;
	stop)   job_stop "$JOB" ;;
	status) job_status "$JOB" ;;
	run)
		valid_job "$JOB" || exit 2
		mkdir -p "$RUNDIR"
		# pid-файл выставляет `start`; при ручном `run` ведём его сами
		[ -n "$(job_pid "$JOB")" ] || echo $$ >"$RUNDIR/$JOB.pid"
		trap 'exit 1' TERM INT HUP
		trap job_cleanup EXIT
		case "$JOB" in
			update-lists)   job_update_lists "$@" ;;
			update-presets) job_update_presets "$@" ;;
			update-all)     job_update_all "$@" ;;
			blockcheck)     job_blockcheck "$@" ;;
			diagnose)       job_diagnose "$@" ;;
		esac
		;;
	cron)
		[ "$JOB" = update-all ] || usage
		"$0" run update-all 2>&1 | logger -t zapret2-update
		;;
	cron-sync)
		# пересобрать запись cron после изменения списков (только пока сервис запущен)
		zapret_prepare
		. "$ZAPRET_CONFIG"
		[ -f "$ZAPRET_STATE" ] && zapret_cron_sync sync
		;;
	*) usage ;;
esac
