# SPDX-License-Identifier: MIT
#
# OpenWrt-пакет для zapret2 (https://github.com/bol-van/zapret2).
#
# Исходники оригинального проекта скачиваются с GitHub во время сборки
# (стандартный механизм OpenWrt: PKG_SOURCE_URL + PKG_HASH), в репозитории
# с этим портом их нет. Из них собираются nfqws2, mdig и ip2net под целевую
# архитектуру, а скрипты, Lua-стратегии, списки и fake-пакеты ставятся как есть.
#
# Версия zapret2 меняется двумя переменными ниже (PKG_VERSION и PKG_HASH);
# build.sh умеет делать это сам: ./build.sh --zapret-version 1.0.7

include $(TOPDIR)/rules.mk

PKG_NAME:=zapret2
PKG_VERSION:=1.0.7
PKG_RELEASE:=1

PKG_SOURCE:=$(PKG_NAME)-$(PKG_VERSION).tar.gz
PKG_SOURCE_URL:=https://codeload.github.com/bol-van/zapret2/tar.gz/v$(PKG_VERSION)?
PKG_HASH:=7ecae682965701aad2e5adead3bcbb62c7846425f3666eb2fd6ec3df29b1d632

PKG_MAINTAINER:=openwrt-zapret contributors
PKG_LICENSE:=MIT
PKG_LICENSE_FILES:=docs/LICENSE.txt

PKG_BUILD_DIR:=$(BUILD_DIR)/$(PKG_NAME)-$(PKG_VERSION)
PKG_BUILD_PARALLEL:=1
# nfq2/sec.h includes <sys/capability.h>: only the header is needed (capget/capset
# come from libc), so libcap is a build-time dependency, not a runtime one.
PKG_BUILD_DEPENDS:=libcap

include $(INCLUDE_DIR)/package.mk

define Package/zapret2
  SECTION:=net
  CATEGORY:=Network
  SUBMENU:=Firewall
  TITLE:=zapret2 - DPI bypass (nfqws2 + Lua strategies)
  URL:=https://github.com/bol-van/zapret2
  DEPENDS:=+libnetfilter-queue +libnfnetlink +libmnl +zlib +luajit \
	+curl +ca-bundle +jsonfilter \
	+kmod-nft-queue +kmod-nft-nat +kmod-nft-offload
endef

define Package/zapret2/description
  Port of zapret2 by bol-van to OpenWrt: nfqws2 (NFQUEUE packet processor
  whose DPI-bypass strategies are written in Lua), mdig, ip2net, upstream
  firewall/ipset scripts and Lua libraries, ready-made switchable presets and
  a procd init script configured via UCI (/etc/config/zapret2).
  Use luci-app-zapret2 for a web interface.
endef

define Package/zapret2/conffiles
/etc/config/zapret2
endef

# Upstream Makefiles do `CFLAGS += ...`. A command-line CFLAGS/LDFLAGS overrides
# the whole variable, so everything needed is passed explicitly here (and LTO
# from upstream is intentionally not used: it is fragile in cross toolchains).
ZAPRET2_CFLAGS=$(TARGET_CFLAGS) $(TARGET_CPPFLAGS) -std=gnu99 -ffunction-sections -fdata-sections
ZAPRET2_LDFLAGS=$(TARGET_LDFLAGS) -Wl,--gc-sections
# nfqws2 embeds LuaJIT (dynamic link against the luajit package)
ZAPRET2_LUA_CFLAGS=-I$(STAGING_DIR)/usr/include/luajit-2.1
ZAPRET2_LUA_LIB=-L$(STAGING_DIR)/usr/lib -lluajit-5.1

define Build/Configure
endef

define Build/Compile
	$(MAKE) -C $(PKG_BUILD_DIR)/nfq2 CC="$(TARGET_CC)" CFLAGS="$(ZAPRET2_CFLAGS)" LDFLAGS="$(ZAPRET2_LDFLAGS)" \
		LUA_CFLAGS="$(ZAPRET2_LUA_CFLAGS)" LUA_LIB="$(ZAPRET2_LUA_LIB)"
	$(MAKE) -C $(PKG_BUILD_DIR)/mdig CC="$(TARGET_CC)" CFLAGS="$(ZAPRET2_CFLAGS)" LDFLAGS="$(ZAPRET2_LDFLAGS)"
	$(MAKE) -C $(PKG_BUILD_DIR)/ip2net CC="$(TARGET_CC)" CFLAGS="$(ZAPRET2_CFLAGS)" LDFLAGS="$(ZAPRET2_LDFLAGS)"
endef

define Package/zapret2/install
	$(INSTALL_DIR) $(1)/usr/bin
	$(INSTALL_BIN) $(PKG_BUILD_DIR)/nfq2/nfqws2 $(1)/usr/bin/nfqws2
	# mdig/ip2net are helpers of the list scripts only; they are kept out of /usr/bin so that
	# they do not collide with the files of the first-generation `zapret` package
	$(INSTALL_DIR) $(1)/usr/libexec/zapret2
	$(INSTALL_BIN) $(PKG_BUILD_DIR)/mdig/mdig $(1)/usr/libexec/zapret2/mdig
	$(INSTALL_BIN) $(PKG_BUILD_DIR)/ip2net/ip2net $(1)/usr/libexec/zapret2/ip2net

	# --- upstream scripts/data (read-only part, ZAPRET_BASE) ---
	$(INSTALL_DIR) $(1)/usr/share/zapret2
	$(CP) $(PKG_BUILD_DIR)/common $(1)/usr/share/zapret2/
	$(CP) $(PKG_BUILD_DIR)/ipset $(1)/usr/share/zapret2/
	$(CP) $(PKG_BUILD_DIR)/lua $(1)/usr/share/zapret2/
	$(CP) $(PKG_BUILD_DIR)/blockcheck2.d $(1)/usr/share/zapret2/
	$(INSTALL_DIR) $(1)/usr/share/zapret2/files
	$(CP) $(PKG_BUILD_DIR)/files/fake $(1)/usr/share/zapret2/files/
	$(INSTALL_DATA) $(PKG_BUILD_DIR)/config.default $(1)/usr/share/zapret2/config.default
	$(INSTALL_BIN) $(PKG_BUILD_DIR)/blockcheck2.sh $(1)/usr/share/zapret2/blockcheck2.sh
	$(INSTALL_DIR) $(1)/usr/share/zapret2/init.d/openwrt
	$(INSTALL_DATA) $(PKG_BUILD_DIR)/init.d/openwrt/functions $(1)/usr/share/zapret2/init.d/openwrt/functions
	$(INSTALL_DIR) $(1)/usr/share/zapret2/docs
	$(INSTALL_DATA) $(PKG_BUILD_DIR)/docs/LICENSE.txt $(1)/usr/share/zapret2/docs/LICENSE.txt
	echo "$(PKG_VERSION)" > $(1)/usr/share/zapret2/version
	chmod 0755 $(1)/usr/share/zapret2/ipset/*.sh
	find $(1)/usr/share/zapret2/common $(1)/usr/share/zapret2/lua -type f -exec chmod 0644 {} +
	$(INSTALL_DIR) $(1)/usr/share/zapret2/nfq2 $(1)/usr/share/zapret2/mdig $(1)/usr/share/zapret2/ip2net
	$(LN) /usr/bin/nfqws2 $(1)/usr/share/zapret2/nfq2/nfqws2
	$(LN) /usr/libexec/zapret2/mdig $(1)/usr/share/zapret2/mdig/mdig
	$(LN) /usr/libexec/zapret2/ip2net $(1)/usr/share/zapret2/ip2net/ip2net

	# --- ready-made presets (this repository) ---
	$(INSTALL_DIR) $(1)/usr/share/zapret2/presets
	$(INSTALL_DATA) ./presets/*.preset $(1)/usr/share/zapret2/presets/

	# --- OpenWrt glue (this repository) ---
	$(INSTALL_DIR) $(1)/etc/config
	$(INSTALL_CONF) ./files/zapret2.config $(1)/etc/config/zapret2
	$(INSTALL_DIR) $(1)/etc/init.d
	$(INSTALL_BIN) ./files/zapret2.init $(1)/etc/init.d/zapret2
	$(INSTALL_DIR) $(1)/etc/hotplug.d/iface
	$(INSTALL_BIN) ./files/zapret2.hotplug $(1)/etc/hotplug.d/iface/90-zapret2
	$(INSTALL_DIR) $(1)/usr/libexec/zapret2
	$(INSTALL_DATA) ./files/env.sh $(1)/usr/libexec/zapret2/env.sh
	$(INSTALL_BIN) ./files/job.sh $(1)/usr/libexec/zapret2/job.sh
	$(INSTALL_BIN) ./files/listview.sh $(1)/usr/libexec/zapret2/listview.sh
	$(INSTALL_BIN) ./files/firewall-include.sh $(1)/usr/libexec/zapret2/firewall-include.sh
	$(INSTALL_DIR) $(1)/lib/upgrade/keep.d
	$(INSTALL_DATA) ./files/zapret2.keep $(1)/lib/upgrade/keep.d/zapret2
	# list of hosts for the diagnostics (a snapshot of hyperion-cs/dpi-checkers, Apache-2.0); a fresh one is downloaded on each run
	$(INSTALL_DATA) ./files/diag-suite.json $(1)/usr/share/zapret2/diag-suite.json
endef

# OpenWrt wraps these scripts with default_postinst / default_prerm, which already
# `enable` the init script (and `start` it on a fresh install - a no-op until nfqws2
# is switched on) and `stop` + `disable` it on removal. What is added here:
# the runtime directories and a restart of a running service after an upgrade.
define Package/zapret2/postinst
#!/bin/sh
[ -n "$${IPKG_INSTROOT}" ] && exit 0
. /usr/libexec/zapret2/env.sh
zapret_init_dirs
# the choice of the repository and the GitHub token are gone: do not leave the old values (a secret) on the router
for o in github_token github_repo github_api; do uci -q delete zapret2.main.$$o; done
uci -q commit zapret2
/etc/init.d/zapret2 enable
if [ "$$(uci -q get zapret2.main.enabled)" = 1 ]; then
	/etc/init.d/zapret2 restart >/dev/null 2>&1
fi
exit 0
endef

define Package/zapret2/prerm
#!/bin/sh
[ -n "$${IPKG_INSTROOT}" ] && exit 0
/etc/init.d/zapret2 stop >/dev/null 2>&1
exit 0
endef

$(eval $(call BuildPackage,zapret2))
