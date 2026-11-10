#!/bin/sh
# SPDX-License-Identifier: MIT
#
# Firewall include for OpenWrt with fw3 + iptables only (registered/removed by
# the init script, see zapret_fw3_sync). Same as init.d/openwrt/firewall.zapret2
# from bol-van/zapret2: applies zapret2 rules every time fw3 (re)loads rules.
# With fw4 (nftables) the init script manages the firewall by itself.

[ -f /var/run/zapret2.started ] || exit 0

. /usr/libexec/zapret2/env.sh
zapret_prepare
. "$ZAPRET_BASE/init.d/openwrt/functions"

zapret_apply_firewall
