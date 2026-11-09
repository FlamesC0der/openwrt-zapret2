#!/bin/sh
# SPDX-License-Identifier: MIT
#
# Фоновые задачи zapret (запускаются из LuCI, cron или консоли).
#
# <job>: update-lists | blockcheck

. /usr/libexec/zapret/env.sh

RUNDIR=/var/run/zapret-jobs
LOGDIR=/var/log/zapret

usage()
{
	cat >&2 <<-EOF
		usage: job.sh start  <job> [KEY=VALUE...]   run in background, log: $LOGDIR/<job>.log
		       job.sh run    <job> [KEY=VALUE...]   run in the foreground
		       job.sh cron   update-lists           for cron: output goes to syslog
		       job.sh stop   <job>                  stop the job (whole process group)
		       job.sh status <job>                  prints running | stopped
		jobs: update-lists, blockcheck
	EOF
	exit 2
}

valid_job()
{
	case "$1" in
		update-lists|blockcheck) return 0 ;;
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
	# при запуске через setsid pid == pgid: завершаем всю группу (curl, nfqws, ...)
	kill -TERM -- "-$pid" 2>/dev/null && return 0
	pkill -TERM -P "$pid" 2>/dev/null
	kill -TERM "$pid" 2>/dev/null
	return 0
}

job_status()
{
	if [ -n "$(job_pid "$1")" ]; then echo running; else echo stopped; fi
}

# --- update-lists -----------------------------------------------------------

job_update_lists()
{
	local script rc

	zapret_prepare
	. "$ZAPRET_CONFIG"
	# как ipset/get_config.sh: скрипт из config, по умолчанию get_ipban.sh
	script="${GETLIST:-get_ipban.sh}"
	case "$script" in
		*/*|.*)
			echo "invalid GETLIST value: $script" >&2
			return 1
			;;
	esac
	if [ ! -x "$ZAPRET_BASE/ipset/$script" ]; then
		echo "list script not found: $ZAPRET_BASE/ipset/$script" >&2
		return 1
	fi

	echo "== $(date '+%F %T') $script"
	"$ZAPRET_BASE/ipset/$script"
	rc=$?
	echo "== $(date '+%F %T') finished, exit code $rc"
	return $rc
}

# --- blockcheck -------------------------------------------------------------

BC_WAS_RUNNING=0
BC_RESTORED=0

blockcheck_restore()
{
	[ "$BC_RESTORED" = 1 ] && return 0
	BC_RESTORED=1
	if [ "$BC_WAS_RUNNING" = 1 ]; then
		echo "* starting zapret service again"
		/etc/init.d/zapret start
	fi
}

job_blockcheck()
{
	local kv

	# в окружение blockcheck попадают только известные переменные с безопасными значениями
	for kv in "$@"; do
		case "$kv" in
			*[!A-Za-z0-9._\ =,:-]*) continue ;;
		esac
		case "$kv" in
			DOMAINS=*|SCANLEVEL=*|IPVS=*|REPEATS=*|PARALLEL=*|CURL_MAX_TIME=*|\
			ENABLE_HTTP=*|ENABLE_HTTPS_TLS12=*|ENABLE_HTTPS_TLS13=*|ENABLE_HTTP3=*|\
			SKIP_DNSCHECK=*|SKIP_IPBLOCK=*|SKIP_TPWS=*|SKIP_PKTWS=*|SECURE_DNS=*)
				export "$kv"
				;;
		esac
	done

	zapret_prepare
	[ -f "$ZAPRET_STATE" ] && BC_WAS_RUNNING=1
	if [ "$BC_WAS_RUNNING" = 1 ]; then
		echo "* stopping zapret for the duration of the test (it will be started again)"
		/etc/init.d/zapret stop
	fi

	BATCH=1 "$ZAPRET_BASE/blockcheck.sh"
}

job_cleanup()
{
	[ "$JOB" = blockcheck ] && blockcheck_restore
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
			update-lists) job_update_lists "$@" ;;
			blockcheck)   job_blockcheck "$@" ;;
		esac
		;;
	cron)
		[ "$JOB" = update-lists ] || usage
		"$0" run update-lists 2>&1 | logger -t zapret-lists
		;;
	*) usage ;;
esac
