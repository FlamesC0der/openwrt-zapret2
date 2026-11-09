#!/bin/sh
# SPDX-License-Identifier: MIT
#
# Firewall include for OpenWrt with fw3 + iptables only (registered/removed by
# the init script, see zapret_fw3_sync). Same as init.d/openwrt/firewall.zapret
# from bol-van/zapret: applies zapret rules every time fw3 (re)loads rules.
# With fw4 (nftables) the init script manages the firewall by itself.

[ -f /var/run/zapret.started ] || exit 0

. /usr/libexec/zapret/env.sh
zapret_prepare
. "$ZAPRET_BASE/init.d/openwrt/functions"

zapret_apply_firewall
