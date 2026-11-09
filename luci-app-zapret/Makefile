# SPDX-License-Identifier: MIT
#
# LuCI web interface for the zapret package (see ../zapret).
# JavaScript views + rpcd (ucode) backend; no Lua, no extra services.
# Translations: po/<lang>/zapret.po -> luci-i18n-zapret-<lang> (built by luci.mk).

include $(TOPDIR)/rules.mk

LUCI_TITLE:=LuCI support for zapret (DPI bypass)
LUCI_DEPENDS:=+luci-base +zapret +rpcd +rpcd-mod-ucode
LUCI_PKGARCH:=all

PKG_VERSION:=1.0.0
PKG_RELEASE:=1
PKG_LICENSE:=MIT
PKG_MAINTAINER:=openwrt-zapret contributors

# luci.mk compiles po/ and installs htdocs/ and root/
include $(TOPDIR)/feeds/luci/luci.mk

# call BuildPackage - OpenWrt buildroot signature
