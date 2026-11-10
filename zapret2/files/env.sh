# shellcheck shell=ash
# SPDX-License-Identifier: MIT
#
# Общая библиотека OpenWrt-порта zapret2. Подключается через `.` из
# /etc/init.d/zapret2, hotplug-скрипта, job.sh и postinst.
#
# Источник правды для настроек - UCI (/etc/config/zapret2) и файлы пресетов.
# Родные скрипты zapret2 ждут shell-файл с переменными (config), поэтому он
# генерируется:  <upstream config.default> + переопределения из UCI +
# NFQWS2_OPT из выбранного пресета + extra_config.

ZAPRET_BASE=/usr/share/zapret2          # скрипты/данные upstream и готовые пресеты (read-only)
ZAPRET_RW=/etc/zapret2                  # списки, пользовательские пресеты, сгенерированный config
ZAPRET_CONFIG="$ZAPRET_RW/config"       # сгенерирован, руками не править
ZAPRET_LIBEXEC=/usr/libexec/zapret2
ZAPRET_ENV_FILE="$ZAPRET_LIBEXEC/env.sh"
ZAPRET_UCI=zapret2
ZAPRET_STATE=/var/run/zapret2.started   # есть, пока сервис запущен
ZAPRET_CRON_TAG="# zapret2-update"
export ZAPRET_BASE ZAPRET_RW ZAPRET_CONFIG

# первичное создание каталогов и файлов (аналог default_files() из upstream)
zapret_init_dirs()
{
	mkdir -p "$ZAPRET_RW/ipset" "$ZAPRET_RW/lists" "$ZAPRET_RW/presets/user" \
		"$ZAPRET_RW/presets/downloaded" "$ZAPRET_RW/init.d/openwrt/custom.d"
	[ -f "$ZAPRET_RW/ipset/zapret-hosts-user-exclude.txt" ] ||
		cp "$ZAPRET_BASE/ipset/zapret-hosts-user-exclude.txt.default" "$ZAPRET_RW/ipset/zapret-hosts-user-exclude.txt"
	[ -f "$ZAPRET_RW/ipset/zapret-hosts-user.txt" ] ||
		echo nonexistent.domain >>"$ZAPRET_RW/ipset/zapret-hosts-user.txt"
	[ -f "$ZAPRET_RW/ipset/zapret-hosts-user-ipban.txt" ] ||
		: >"$ZAPRET_RW/ipset/zapret-hosts-user-ipban.txt"
}

# --- пресеты -------------------------------------------------------------------
#
# Файл пресета: заголовок из строк "#@ключ: значение", затем тело - параметры
# nfqws2 (можно в несколько строк, строки на "#" - комментарии). В теле работают
# подстановки <BASE> (каталог скриптов), <RW> (каталог данных) и <LIST:имя>
# (путь к списку /etc/zapret2/lists/имя.txt), а также штатные <HOSTLIST> и
# <HOSTLIST_NOAUTO> upstream.
# Приоритет при совпадении id: user > downloaded > встроенный.

zapret_valid_id()
{
	case "$1" in
		''|*[!a-z0-9_-]*) return 1 ;;
	esac
	[ ${#1} -le 40 ]
}

# $1 - id; печатает путь к файлу пресета
zapret_preset_path()
{
	local d
	zapret_valid_id "$1" || return 1
	for d in "$ZAPRET_RW/presets/user" "$ZAPRET_RW/presets/downloaded" "$ZAPRET_BASE/presets"; do
		[ -f "$d/$1.preset" ] && {
			echo "$d/$1.preset"
			return 0
		}
	done
	return 1
}

# $1 - файл, $2 - ключ заголовка
zapret_preset_header()
{
	sed -n "s/^#@$2:[[:space:]]*//p" "$1" | head -n1 | tr -d '\r'
}

# тело пресета с выполненными подстановками
zapret_preset_body()
{
	sed -e 's/\r$//' -e '/^[[:space:]]*#/d' -e '/^[[:space:]]*$/d' "$1" |
		sed -e "s#<BASE>#$ZAPRET_BASE#g" -e "s#<RW>#$ZAPRET_RW#g" \
			-e "s#<LIST:\([a-z0-9_-]*\)>#$ZAPRET_RW/lists/\1.txt#g"
}

# Пустой include-список (--hostlist/--ipset) nfqws2 считает "подходит всё" (hostlist.c, ipset.c: "all include
# lists are empty means check passes"). Поэтому пустой или ещё не скачанный список не должен оставаться пустым:
# добавляем запись, которая ничему не соответствует (как upstream делает с zapret-hosts-user.txt).
# $1 - файл, $2 - hosts|ips
zapret_list_guard()
{
	local ph=nonexistent.domain
	[ "$2" = ips ] && ph=203.0.113.113/32
	[ -f "$1" ] && grep -q '^[[:space:]]*[^[:space:]#]' "$1" 2>/dev/null && return 0
	printf '%s\n' "$ph" >>"$1" && chmod 0644 "$1"
}

# nfqws2 не стартует, если файл листа из --hostlist/--ipset отсутствует; include-списки заодно не оставляем пустыми.
# Строки-комментарии пресета (#...) не учитываются: в них бывают примеры с <LIST:...>.
zapret_preset_lists_ensure()
{
	local id body
	mkdir -p "$ZAPRET_RW/lists"
	body="$(sed -e '/^[[:space:]]*#/d' "$1" 2>/dev/null)"
	printf '%s\n' "$body" | grep -o '<LIST:[a-z0-9_-]*>' | sed 's/<LIST:\(.*\)>/\1/' | sort -u |
		while read -r id; do
			[ -f "$ZAPRET_RW/lists/$id.txt" ] || : >"$ZAPRET_RW/lists/$id.txt"
		done
	printf '%s\n' "$body" | grep -o -e '--hostlist=<LIST:[a-z0-9_-]*>' | sed 's/.*<LIST:\(.*\)>/\1/' | sort -u |
		while read -r id; do
			zapret_list_guard "$ZAPRET_RW/lists/$id.txt" hosts
		done
	printf '%s\n' "$body" | grep -o -e '--ipset=<LIST:[a-z0-9_-]*>' | sed 's/.*<LIST:\(.*\)>/\1/' | sort -u |
		while read -r id; do
			zapret_list_guard "$ZAPRET_RW/lists/$id.txt" ips
		done
}

# --- генерация config -----------------------------------------------------------

# VAR='значение' с безопасным экранированием одинарных кавычек
_zapret_emit()
{
	# $1 - имя переменной, $2 - значение
	printf "%s='%s'\n" "$1" "$(printf '%s' "$2" | tr -d '\r' | sed "s/'/'\\\\''/g")"
}

# если опция задана и не пуста - выдать переменную
_zapret_opt()
{
	# $1 - опция UCI, $2 - имя переменной в config
	local _v
	config_get _v main "$1"
	[ -n "$_v" ] && _zapret_emit "$2" "$_v"
	return 0
}

# Соответствие "опция UCI -> переменная config zapret2"
_zapret_map()
{
	cat <<'EOF'
fwtype FWTYPE
postnat POSTNAT
flowoffload FLOWOFFLOAD
mode_filter MODE_FILTER
lan OPENWRT_LAN
wan4 OPENWRT_WAN4
wan6 OPENWRT_WAN6
disable_ipv4 DISABLE_IPV4
disable_ipv6 DISABLE_IPV6
init_apply_fw INIT_APPLY_FW
filter_ttl_expired_icmp FILTER_TTL_EXPIRED_ICMP
filter_mark FILTER_MARK
ws_user WS_USER
qnum QNUM
desync_mark DESYNC_MARK
desync_mark_postnat DESYNC_MARK_POSTNAT
tmpdir TMPDIR
nfqws2_enable NFQWS2_ENABLE
nfqws2_ports_tcp NFQWS2_PORTS_TCP
nfqws2_ports_udp NFQWS2_PORTS_UDP
nfqws2_tcp_pkt_out NFQWS2_TCP_PKT_OUT
nfqws2_tcp_pkt_in NFQWS2_TCP_PKT_IN
nfqws2_udp_pkt_out NFQWS2_UDP_PKT_OUT
nfqws2_udp_pkt_in NFQWS2_UDP_PKT_IN
nfqws2_ports_tcp_keepalive NFQWS2_PORTS_TCP_KEEPALIVE
nfqws2_ports_udp_keepalive NFQWS2_PORTS_UDP_KEEPALIVE
getlist GETLIST
gzip_lists GZIP_LISTS
mdig_threads MDIG_THREADS
set_maxelem SET_MAXELEM
ip2net_opt4 IP2NET_OPT4
ip2net_opt6 IP2NET_OPT6
autohostlist_retrans_threshold AUTOHOSTLIST_RETRANS_THRESHOLD
autohostlist_fail_threshold AUTOHOSTLIST_FAIL_THRESHOLD
autohostlist_fail_time AUTOHOSTLIST_FAIL_TIME
autohostlist_debuglog AUTOHOSTLIST_DEBUGLOG
list_update_hour ZAPRET2_LIST_UPDATE_HOUR
presets_auto_update ZAPRET2_PRESETS_AUTO_UPDATE
update_check_daily ZAPRET2_UPDATE_CHECK
EOF
}

# пресет по умолчанию, пока пользователь не выбрал другой или выбранный пропал
ZAPRET_DEFAULT_PRESET=default

# отпечаток входных данных генератора: UCI / эта библиотека / upstream-дефолты / файлы пресетов
_zapret_stamp()
{
	{
		cat /etc/config/zapret2 "$ZAPRET_ENV_FILE" "$ZAPRET_BASE/config.default" 2>/dev/null
		cat "$ZAPRET_BASE"/presets/*.preset "$ZAPRET_RW"/presets/downloaded/*.preset \
			"$ZAPRET_RW"/presets/user/*.preset 2>/dev/null
		# existence of the bypass list matters in "none" mode (see zapret_gen_config)
		[ -f "$ZAPRET_RW/ipset/zapret-hosts-user-exclude.txt" ] && echo bypass-list-present
	} | md5sum | cut -d' ' -f1
}

# $1 - stamp
zapret_gen_config()
{
	local tmp="$ZAPRET_CONFIG.tmp.$$" opt var _v _x pid pfile body

	. /lib/functions.sh
	zapret_init_dirs
	config_load "$ZAPRET_UCI"

	config_get pid main preset "$ZAPRET_DEFAULT_PRESET"
	pfile="$(zapret_preset_path "$pid")" || {
		pid="$ZAPRET_DEFAULT_PRESET"
		pfile="$(zapret_preset_path "$pid")"
	}
	[ -n "$pfile" ] && zapret_preset_lists_ensure "$pfile"

	{
		echo "# GENERATED from /etc/config/zapret2 and the selected preset ($ZAPRET_ENV_FILE). DO NOT EDIT -"
		echo "# changes will be overwritten. Use LuCI (Services -> Zapret2) or edit /etc/config/zapret2."
		echo "# stamp: $1"
		echo
		cat "$ZAPRET_BASE/config.default"
		echo
		echo "##### overrides from /etc/config/zapret2"
		_zapret_emit HOSTLIST_BASE "$ZAPRET_RW/ipset"
		_zapret_map | while read -r opt var; do
			[ -n "$opt" ] && _zapret_opt "$opt" "$var"
		done

		if [ -n "$pfile" ]; then
			echo
			echo "##### preset: $pid ($pfile)"
			_zapret_emit ZAPRET2_PRESET "$pid"
			body="$(zapret_preset_body "$pfile")"
			# upstream adds --hostlist-exclude only in the hostlist modes, so in "all traffic" mode the
			# bypass list would be ignored. Substitute the markers here so that it works in every mode.
			config_get _v main mode_filter none
			if [ "$_v" = none ] && [ -f "$ZAPRET_RW/ipset/zapret-hosts-user-exclude.txt" ]; then
				body="$(printf '%s\n' "$body" | sed \
					-e "s#<HOSTLIST_NOAUTO>#--hostlist-exclude=$ZAPRET_RW/ipset/zapret-hosts-user-exclude.txt#g" \
					-e "s#<HOSTLIST>#--hostlist-exclude=$ZAPRET_RW/ipset/zapret-hosts-user-exclude.txt#g")"
			fi
			[ -n "$body" ] && _zapret_emit NFQWS2_OPT "$body"
			# порты и счётчики пакетов из заголовка пресета, если пользователь не задал свои
			for _x in "tcp_ports:nfqws2_ports_tcp:NFQWS2_PORTS_TCP" "udp_ports:nfqws2_ports_udp:NFQWS2_PORTS_UDP" \
				"tcp_pkt_out:nfqws2_tcp_pkt_out:NFQWS2_TCP_PKT_OUT" "tcp_pkt_in:nfqws2_tcp_pkt_in:NFQWS2_TCP_PKT_IN" \
				"udp_pkt_out:nfqws2_udp_pkt_out:NFQWS2_UDP_PKT_OUT" "udp_pkt_in:nfqws2_udp_pkt_in:NFQWS2_UDP_PKT_IN"; do
				config_get _v main "$(echo "$_x" | cut -d: -f2)"
				[ -n "$_v" ] && continue
				_v="$(zapret_preset_header "$pfile" "$(echo "$_x" | cut -d: -f1)")"
				[ -n "$_v" ] && _zapret_emit "$(echo "$_x" | cut -d: -f3)" "$_v"
			done
		fi

		config_get _v main extra_config
		if [ -n "$_v" ]; then
			echo
			echo "##### extra_config"
			printf '%s\n' "$_v" | tr -d '\r'
		fi
	} >"$tmp" && mv -f "$tmp" "$ZAPRET_CONFIG"
	rm -f "$tmp"
}

# сгенерировать config, если что-то из входных данных изменилось
zapret_prepare()
{
	local st pid pfile
	st="$(_zapret_stamp)"
	grep -q "^# stamp: $st\$" "$ZAPRET_CONFIG" 2>/dev/null || zapret_gen_config "$st"

	# файлы списков включённого пресета должны быть на месте и не пусты при каждом запуске,
	# а не только при пересоздании config (список могли удалить или очистить)
	pid="$(uci -q get "$ZAPRET_UCI.main.preset")"
	pfile="$(zapret_preset_path "${pid:-$ZAPRET_DEFAULT_PRESET}")" || pfile="$(zapret_preset_path "$ZAPRET_DEFAULT_PRESET")"
	[ -n "$pfile" ] && zapret_preset_lists_ensure "$pfile"
	return 0
}

# --- автообновление списков/пресетов через cron --------------------------------
# Нужно, чтобы config уже был загружен (GETLIST, ZAPRET2_LIST_UPDATE_HOUR, ...).
# $1 = sync (по config) | off (убрать запись)
zapret_cron_sync()
{
	local cron=/etc/crontabs/root line="" cur="" need=0

	[ "$1" = off ] || {
		[ -n "$GETLIST" ] && need=1
		[ "$ZAPRET2_PRESETS_AUTO_UPDATE" = 1 ] && need=1
		[ "$ZAPRET2_UPDATE_CHECK" = 1 ] && need=1
		uci -q show "$ZAPRET_UCI" | grep -qE "^$ZAPRET_UCI\.[^.=]+\.url=" && need=1
		[ $need = 1 ] &&
			case "$ZAPRET2_LIST_UPDATE_HOUR" in
				[0-9]|[01][0-9]|2[0-3])
					line="0 $ZAPRET2_LIST_UPDATE_HOUR * * * $ZAPRET_LIBEXEC/job.sh cron update-all $ZAPRET_CRON_TAG"
					;;
			esac
	}

	[ -f "$cron" ] && cur="$(grep -F "$ZAPRET_CRON_TAG" "$cron")"
	[ "$cur" = "$line" ] && return 0

	mkdir -p /etc/crontabs
	[ -f "$cron" ] && sed -i "\\|$ZAPRET_CRON_TAG|d" "$cron"
	[ -n "$line" ] && echo "$line" >>"$cron"
	if [ -n "$line" ]; then
		pidof crond >/dev/null 2>&1 || {
			/etc/init.d/cron enable
			/etc/init.d/cron start
		}
	fi
	return 0
}

# --- OpenWrt с fw3 + iptables: правила применяются из firewall include --------
# $1 = add | del
zapret_fw3_sync()
{
	local present=0
	[ "$(uci -q get firewall.zapret2)" = include ] && present=1

	if [ "$1" = add ]; then
		[ $present = 1 ] || {
			uci -q batch <<-EOF
				set firewall.zapret2=include
				set firewall.zapret2.type=script
				set firewall.zapret2.path=$ZAPRET_LIBEXEC/firewall-include.sh
				set firewall.zapret2.fw4_compatible=0
				set firewall.zapret2.reload=1
				commit firewall
			EOF
		}
	else
		[ $present = 0 ] || {
			uci -q delete firewall.zapret2
			uci -q commit firewall
		}
	fi
	/etc/init.d/firewall reload >/dev/null 2>&1
	return 0
}
