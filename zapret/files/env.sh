# shellcheck shell=ash
# SPDX-License-Identifier: MIT
#
# Общая библиотека OpenWrt-порта zapret. Подключается через `.` из
# /etc/init.d/zapret, hotplug-скрипта, job.sh и postinst.
#
# Источник правды для настроек - UCI (/etc/config/zapret). Родные скрипты
# zapret ждут shell-файл с переменными (config), поэтому он генерируется:
#   <upstream config.default> + переопределения из UCI + extra_config.

ZAPRET_BASE=/usr/share/zapret           # скрипты/данные из upstream (read-only)
ZAPRET_RW=/etc/zapret                   # списки, сгенерированный config, custom.d
ZAPRET_CONFIG="$ZAPRET_RW/config"       # сгенерирован из UCI, руками не править
ZAPRET_LIBEXEC=/usr/libexec/zapret
ZAPRET_ENV_FILE="$ZAPRET_LIBEXEC/env.sh"
ZAPRET_STATE=/var/run/zapret.started    # есть, пока сервис запущен
ZAPRET_CRON_TAG="# zapret-lists"
export ZAPRET_BASE ZAPRET_RW ZAPRET_CONFIG

# первичное создание каталогов и файлов (аналог default_files() из upstream)
zapret_init_dirs()
{
	mkdir -p "$ZAPRET_RW/ipset" "$ZAPRET_RW/init.d/openwrt/custom.d"
	[ -f "$ZAPRET_RW/ipset/zapret-hosts-user-exclude.txt" ] ||
		cp "$ZAPRET_BASE/ipset/zapret-hosts-user-exclude.txt.default" "$ZAPRET_RW/ipset/zapret-hosts-user-exclude.txt"
	[ -f "$ZAPRET_RW/ipset/zapret-hosts-user.txt" ] ||
		echo nonexistent.domain >>"$ZAPRET_RW/ipset/zapret-hosts-user.txt"
	[ -f "$ZAPRET_RW/ipset/zapret-hosts-user-ipban.txt" ] ||
		: >"$ZAPRET_RW/ipset/zapret-hosts-user-ipban.txt"
}

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

# Соответствие "опция UCI -> переменная config zapret"
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
tpport TPPORT
desync_mark DESYNC_MARK
desync_mark_postnat DESYNC_MARK_POSTNAT
tmpdir TMPDIR
nfqws_enable NFQWS_ENABLE
nfqws_ports_tcp NFQWS_PORTS_TCP
nfqws_ports_udp NFQWS_PORTS_UDP
nfqws_tcp_pkt_out NFQWS_TCP_PKT_OUT
nfqws_tcp_pkt_in NFQWS_TCP_PKT_IN
nfqws_udp_pkt_out NFQWS_UDP_PKT_OUT
nfqws_udp_pkt_in NFQWS_UDP_PKT_IN
nfqws_ports_tcp_keepalive NFQWS_PORTS_TCP_KEEPALIVE
nfqws_ports_udp_keepalive NFQWS_PORTS_UDP_KEEPALIVE
nfqws_opt NFQWS_OPT
tpws_enable TPWS_ENABLE
tpws_ports TPWS_PORTS
tpws_opt TPWS_OPT
tpws_socks_enable TPWS_SOCKS_ENABLE
tpport_socks TPPORT_SOCKS
tpws_socks_opt TPWS_SOCKS_OPT
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
list_update_hour ZAPRET_LIST_UPDATE_HOUR
EOF
}

# отпечаток входных данных генератора: изменился UCI / библиотека / upstream-дефолты
_zapret_stamp()
{
	cat /etc/config/zapret "$ZAPRET_ENV_FILE" "$ZAPRET_BASE/config.default" 2>/dev/null |
		md5sum | cut -d' ' -f1
}

# $1 - stamp
zapret_gen_config()
{
	local tmp="$ZAPRET_CONFIG.tmp.$$" opt var _v _x

	. /lib/functions.sh
	zapret_init_dirs
	config_load zapret

	{
		echo "# GENERATED from /etc/config/zapret ($ZAPRET_ENV_FILE). DO NOT EDIT -"
		echo "# changes will be overwritten. Use LuCI (Services -> Zapret) or edit /etc/config/zapret."
		echo "# stamp: $1"
		echo
		cat "$ZAPRET_BASE/config.default"
		echo
		echo "##### overrides from /etc/config/zapret"
		_zapret_emit HOSTLIST_BASE "$ZAPRET_RW/ipset"
		_zapret_map | while read -r opt var; do
			[ -n "$opt" ] && _zapret_opt "$opt" "$var"
		done

		# в config.default эти значения вычисляются из AUTOHOSTLIST_RETRANS_THRESHOLD
		# в момент присваивания, поэтому при смене порога пересчитываем их заново
		config_get _v main autohostlist_retrans_threshold
		if [ -n "$_v" ]; then
			config_get _x main nfqws_tcp_pkt_out
			[ -n "$_x" ] || echo 'NFQWS_TCP_PKT_OUT=$((6+$AUTOHOSTLIST_RETRANS_THRESHOLD))'
			config_get _x main nfqws_udp_pkt_out
			[ -n "$_x" ] || echo 'NFQWS_UDP_PKT_OUT=$((6+$AUTOHOSTLIST_RETRANS_THRESHOLD))'
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

# сгенерировать config, если UCI (или этот файл, или upstream-дефолты) изменились
zapret_prepare()
{
	local st
	st="$(_zapret_stamp)"
	grep -q "^# stamp: $st\$" "$ZAPRET_CONFIG" 2>/dev/null || zapret_gen_config "$st"
}

# --- автообновление списков через cron ---------------------------------------
# Нужно, чтобы config уже был загружен (GETLIST, ZAPRET_LIST_UPDATE_HOUR).
# $1 = sync (по config) | off (убрать запись)
zapret_cron_sync()
{
	local cron=/etc/crontabs/root line="" cur=""

	[ "$1" = off ] || {
		[ -n "$GETLIST" ] && [ -n "$ZAPRET_LIST_UPDATE_HOUR" ] &&
			case "$ZAPRET_LIST_UPDATE_HOUR" in
				[0-9]|[01][0-9]|2[0-3])
					line="0 $ZAPRET_LIST_UPDATE_HOUR * * * $ZAPRET_LIBEXEC/job.sh cron update-lists $ZAPRET_CRON_TAG"
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
	[ "$(uci -q get firewall.zapret)" = include ] && present=1

	if [ "$1" = add ]; then
		[ $present = 1 ] || {
			uci -q batch <<-EOF
				set firewall.zapret=include
				set firewall.zapret.type=script
				set firewall.zapret.path=$ZAPRET_LIBEXEC/firewall-include.sh
				set firewall.zapret.fw4_compatible=0
				set firewall.zapret.reload=1
				commit firewall
			EOF
		}
	else
		[ $present = 0 ] || {
			uci -q delete firewall.zapret
			uci -q commit firewall
		}
	fi
	/etc/init.d/firewall reload >/dev/null 2>&1
	return 0
}
