# SPDX-License-Identifier: MIT
#
# LuCI web interface for the zapret2 package (see ../zapret2).
# JavaScript views + rpcd (ucode) backend; no Lua, no extra services.
# Translations: po/<lang>/zapret2.po -> luci-i18n-zapret2-<lang> (built by luci.mk).

include $(TOPDIR)/rules.mk

LUCI_TITLE:=LuCI support for zapret2 (DPI bypass)
LUCI_DEPENDS:=+luci-base +zapret2 +rpcd +rpcd-mod-ucode
LUCI_PKGARCH:=all

PKG_VERSION:=2.0.0
PKG_RELEASE:=1
PKG_LICENSE:=MIT
PKG_MAINTAINER:=openwrt-zapret contributors

# luci.mk compiles po/ and installs htdocs/ and root/
include $(TOPDIR)/feeds/luci/luci.mk

# call BuildPackage - OpenWrt buildroot signature
