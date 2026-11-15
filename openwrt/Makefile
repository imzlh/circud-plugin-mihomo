include $(TOPDIR)/rules.mk

PKG_NAME:=cno-mihomo-companion
PKG_VERSION:=0.1.0
PKG_RELEASE:=1
PKG_LICENSE:=MIT
PKG_MAINTAINER:=cno-mihomo maintainers

include $(INCLUDE_DIR)/package.mk

define Package/cno-mihomo-companion
  SECTION:=net
  CATEGORY:=Network
  SUBMENU:=Web Servers/Proxies
  TITLE:=Transactional OpenWrt companion for CNO Mihomo Manager
  DEPENDS:=+cno +mihomo +firewall4 +ip-full +kmod-nft-tproxy +kmod-tun
endef

define Package/cno-mihomo-companion/description
 A fixed JSON control helper, generation manager, procd integration and
 fail-open fw4/nftables policy for io.cno.mihomo.
endef

define Build/Compile
endef

define Build/Configure
endef

define Package/cno-mihomo-companion/conffiles
/etc/config/io.cno.mihomo
/etc/io.cno.mihomo/daemon.json
/etc/io.cno.mihomo/controller.secret
endef

define Package/cno-mihomo-companion/install
	$(INSTALL_DIR) $(1)/usr/lib/io.cno.mihomo $(1)/usr/sbin
	$(CP) ./files/usr/lib/io.cno.mihomo/*.ts $(1)/usr/lib/io.cno.mihomo/
	$(INSTALL_BIN) ./files/usr/sbin/cno-mihomod $(1)/usr/sbin/cno-mihomod
	$(INSTALL_BIN) ./files/usr/sbin/cno-mihomoctl $(1)/usr/sbin/cno-mihomoctl

	$(INSTALL_DIR) $(1)/etc/init.d $(1)/etc/config $(1)/etc/io.cno.mihomo
	$(INSTALL_BIN) ./files/etc/init.d/cno-mihomod $(1)/etc/init.d/cno-mihomod
	$(INSTALL_BIN) ./files/etc/init.d/cno-mihomo-core $(1)/etc/init.d/cno-mihomo-core
	$(INSTALL_CONF) ./files/etc/config/io.cno.mihomo $(1)/etc/config/io.cno.mihomo
	$(INSTALL_CONF) ./files/etc/io.cno.mihomo/daemon.json $(1)/etc/io.cno.mihomo/daemon.json
	$(INSTALL_CONF) ./files/etc/io.cno.mihomo/controller.secret $(1)/etc/io.cno.mihomo/controller.secret
	$(INSTALL_CONF) ./files/etc/io.cno.mihomo/firewall.nft $(1)/etc/io.cno.mihomo/firewall.nft

	$(INSTALL_DIR) $(1)/usr/share/nftables.d/ruleset-post
	$(INSTALL_DATA) ./files/usr/share/nftables.d/ruleset-post/90-io-cno-mihomo.nft $(1)/usr/share/nftables.d/ruleset-post/90-io-cno-mihomo.nft
	$(INSTALL_DIR) $(1)/etc/hotplug.d/iface $(1)/etc/hotplug.d/firewall $(1)/etc/uci-defaults
	$(INSTALL_BIN) ./files/etc/hotplug.d/iface/95-io-cno-mihomo $(1)/etc/hotplug.d/iface/95-io-cno-mihomo
	$(INSTALL_BIN) ./files/etc/hotplug.d/firewall/95-io-cno-mihomo $(1)/etc/hotplug.d/firewall/95-io-cno-mihomo
	$(INSTALL_BIN) ./files/etc/uci-defaults/90-io-cno-mihomo $(1)/etc/uci-defaults/90-io-cno-mihomo
endef

$(eval $(call BuildPackage,cno-mihomo-companion))
