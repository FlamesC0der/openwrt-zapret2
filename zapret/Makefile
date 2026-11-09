# SPDX-License-Identifier: MIT
#
# OpenWrt-пакет для zapret (https://github.com/bol-van/zapret).
#
# Исходники оригинального проекта скачиваются с GitHub во время сборки
# (стандартный механизм OpenWrt: PKG_SOURCE_URL + PKG_HASH), в репозитории
# с этим портом их нет. Из них собираются nfqws, tpws, mdig и ip2net
# под целевую архитектуру, а скрипты/списки/fake-пакеты ставятся как есть.
#
# Версия zapret меняется двумя переменными ниже (PKG_VERSION и PKG_HASH);
# build.sh умеет делать это сам: ./build.sh --zapret-version 72.13

include $(TOPDIR)/rules.mk

PKG_NAME:=zapret
PKG_VERSION:=72.13
PKG_RELEASE:=1

PKG_SOURCE:=$(PKG_NAME)-$(PKG_VERSION).tar.gz
PKG_SOURCE_URL:=https://codeload.github.com/bol-van/zapret/tar.gz/v$(PKG_VERSION)?
PKG_HASH:=04696a1b6fe766e35cd6426555520c79d5052a759cdf4d7724a1f46eba4670f6

PKG_MAINTAINER:=openwrt-zapret contributors
PKG_LICENSE:=MIT
PKG_LICENSE_FILES:=docs/LICENSE.txt

PKG_BUILD_DIR:=$(BUILD_DIR)/$(PKG_NAME)-$(PKG_VERSION)
PKG_BUILD_PARALLEL:=1
# nfq/sec.h includes <sys/capability.h>: only the header is needed (capget/capset
# come from libc), so libcap is a build-time dependency, not a runtime one.
PKG_BUILD_DEPENDS:=libcap

include $(INCLUDE_DIR)/package.mk

define Package/zapret
  SECTION:=net
  CATEGORY:=Network
  SUBMENU:=Firewall
  TITLE:=zapret - DPI bypass (nfqws, tpws)
  URL:=https://github.com/bol-van/zapret
  DEPENDS:=+libnetfilter-queue +libnfnetlink +libmnl +zlib \
	+curl +ca-bundle \
	+kmod-nft-queue +kmod-nft-nat +kmod-nft-offload
endef

define Package/zapret/description
  Port of zapret by bol-van to OpenWrt: nfqws (NFQUEUE packet modifier),
  tpws (transparent proxy), mdig, ip2net, upstream firewall/ipset scripts
  and a procd init script configured via UCI (/etc/config/zapret).
  Use luci-app-zapret for a web interface.
endef

define Package/zapret/conffiles
/etc/config/zapret
endef

# Upstream Makefiles do `CFLAGS += ...`. A command-line CFLAGS/LDFLAGS overrides
# the whole variable, so everything needed is passed explicitly here (and LTO
# from upstream is intentionally not used: it is fragile in cross toolchains).
ZAPRET_CFLAGS=$(TARGET_CFLAGS) $(TARGET_CPPFLAGS) -std=gnu99 -ffunction-sections -fdata-sections
ZAPRET_LDFLAGS=$(TARGET_LDFLAGS) -Wl,--gc-sections

define Build/Configure
endef

define Build/Compile
	$(MAKE) -C $(PKG_BUILD_DIR)/nfq CC="$(TARGET_CC)" CFLAGS="$(ZAPRET_CFLAGS)" LDFLAGS="$(ZAPRET_LDFLAGS)"
	$(MAKE) -C $(PKG_BUILD_DIR)/tpws CC="$(TARGET_CC)" CFLAGS="$(ZAPRET_CFLAGS)" LDFLAGS="$(ZAPRET_LDFLAGS)"
	$(MAKE) -C $(PKG_BUILD_DIR)/mdig CC="$(TARGET_CC)" CFLAGS="$(ZAPRET_CFLAGS)" LDFLAGS="$(ZAPRET_LDFLAGS)"
	$(MAKE) -C $(PKG_BUILD_DIR)/ip2net CC="$(TARGET_CC)" CFLAGS="$(ZAPRET_CFLAGS)" LDFLAGS="$(ZAPRET_LDFLAGS)"
endef

define Package/zapret/install
	$(INSTALL_DIR) $(1)/usr/bin
	$(INSTALL_BIN) $(PKG_BUILD_DIR)/nfq/nfqws $(1)/usr/bin/nfqws
	$(INSTALL_BIN) $(PKG_BUILD_DIR)/tpws/tpws $(1)/usr/bin/tpws
	$(INSTALL_BIN) $(PKG_BUILD_DIR)/mdig/mdig $(1)/usr/bin/mdig
	$(INSTALL_BIN) $(PKG_BUILD_DIR)/ip2net/ip2net $(1)/usr/bin/ip2net

	# --- upstream scripts/data (read-only part, ZAPRET_BASE) ---
	$(INSTALL_DIR) $(1)/usr/share/zapret
	$(CP) $(PKG_BUILD_DIR)/common $(1)/usr/share/zapret/
	$(CP) $(PKG_BUILD_DIR)/ipset $(1)/usr/share/zapret/
	$(INSTALL_DIR) $(1)/usr/share/zapret/files
	$(CP) $(PKG_BUILD_DIR)/files/fake $(1)/usr/share/zapret/files/
	$(INSTALL_DATA) $(PKG_BUILD_DIR)/config.default $(1)/usr/share/zapret/config.default
	$(INSTALL_BIN) $(PKG_BUILD_DIR)/blockcheck.sh $(1)/usr/share/zapret/blockcheck.sh
	$(INSTALL_DIR) $(1)/usr/share/zapret/init.d/openwrt
	$(INSTALL_DATA) $(PKG_BUILD_DIR)/init.d/openwrt/functions $(1)/usr/share/zapret/init.d/openwrt/functions
	$(INSTALL_DIR) $(1)/usr/share/zapret/docs
	$(INSTALL_DATA) $(PKG_BUILD_DIR)/docs/LICENSE.txt $(1)/usr/share/zapret/docs/LICENSE.txt
	echo "$(PKG_VERSION)" > $(1)/usr/share/zapret/version
	chmod 0755 $(1)/usr/share/zapret/ipset/*.sh
	find $(1)/usr/share/zapret/common -type f -exec chmod 0644 {} +
	$(INSTALL_DIR) $(1)/usr/share/zapret/nfq $(1)/usr/share/zapret/tpws \
		$(1)/usr/share/zapret/mdig $(1)/usr/share/zapret/ip2net
	$(LN) /usr/bin/nfqws $(1)/usr/share/zapret/nfq/nfqws
	$(LN) /usr/bin/tpws $(1)/usr/share/zapret/tpws/tpws
	$(LN) /usr/bin/mdig $(1)/usr/share/zapret/mdig/mdig
	$(LN) /usr/bin/ip2net $(1)/usr/share/zapret/ip2net/ip2net

	# --- OpenWrt glue (this repository) ---
	$(INSTALL_DIR) $(1)/etc/config
	$(INSTALL_CONF) ./files/zapret.config $(1)/etc/config/zapret
	$(INSTALL_DIR) $(1)/etc/init.d
	$(INSTALL_BIN) ./files/zapret.init $(1)/etc/init.d/zapret
	$(INSTALL_DIR) $(1)/etc/hotplug.d/iface
	$(INSTALL_BIN) ./files/zapret.hotplug $(1)/etc/hotplug.d/iface/90-zapret
	$(INSTALL_DIR) $(1)/usr/libexec/zapret
	$(INSTALL_DATA) ./files/env.sh $(1)/usr/libexec/zapret/env.sh
	$(INSTALL_BIN) ./files/job.sh $(1)/usr/libexec/zapret/job.sh
	$(INSTALL_BIN) ./files/firewall-include.sh $(1)/usr/libexec/zapret/firewall-include.sh
	$(INSTALL_DIR) $(1)/lib/upgrade/keep.d
	$(INSTALL_DATA) ./files/zapret.keep $(1)/lib/upgrade/keep.d/zapret
endef

# OpenWrt wraps these scripts with default_postinst / default_prerm, which already
# `enable` the init script (and `start` it on a fresh install - a no-op until nfqws
# or tpws is switched on) and `stop` + `disable` it on removal. What is added here:
# the runtime directories and a restart of a running service after an upgrade.
define Package/zapret/postinst
#!/bin/sh
[ -n "$${IPKG_INSTROOT}" ] && exit 0
. /usr/libexec/zapret/env.sh
zapret_init_dirs
/etc/init.d/zapret enable
if [ "$$(uci -q get zapret.main.enabled)" = 1 ]; then
	/etc/init.d/zapret restart >/dev/null 2>&1
fi
exit 0
endef

define Package/zapret/prerm
#!/bin/sh
[ -n "$${IPKG_INSTROOT}" ] && exit 0
/etc/init.d/zapret stop >/dev/null 2>&1
exit 0
endef

$(eval $(call BuildPackage,zapret))
