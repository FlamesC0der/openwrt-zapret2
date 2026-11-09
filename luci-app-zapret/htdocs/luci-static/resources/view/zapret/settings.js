'use strict';
'require view';
'require form';
'require tools.widgets as widgets';

/*
 * Starting points taken from the strategies zapret itself uses (config.default and
 * blockcheck.sh). What really works depends on the ISP: run the "Strategy test".
 * <HOSTLIST> / <HOSTLIST_NOAUTO> are replaced by zapret with the hostlist options
 * of the selected filter mode.
 */
var NFQWS_PRESETS = [
	{
		id: 'default',
		title: _('zapret default (fake + multisplit / multidisorder)'),
		text:
			'--filter-tcp=80 --dpi-desync=fake,multisplit --dpi-desync-split-pos=method+2 --dpi-desync-fooling=md5sig <HOSTLIST> --new\n' +
			'--filter-tcp=443 --dpi-desync=fake,multidisorder --dpi-desync-split-pos=1,midsld --dpi-desync-fooling=badseq,md5sig <HOSTLIST> --new\n' +
			'--filter-udp=443 --dpi-desync=fake --dpi-desync-repeats=6 <HOSTLIST_NOAUTO>'
	},
	{
		id: 'seqovl',
		title: _('TLS: multisplit with sequence overlap (no fooling)'),
		text:
			'--filter-tcp=80 --dpi-desync=multisplit --dpi-desync-split-pos=method+2 <HOSTLIST> --new\n' +
			'--filter-tcp=443 --dpi-desync=multisplit --dpi-desync-split-pos=2 --dpi-desync-split-seqovl=336 --dpi-desync-split-seqovl-pattern=/usr/share/zapret/files/fake/tls_clienthello_iana_org.bin <HOSTLIST> --new\n' +
			'--filter-udp=443 --dpi-desync=fake --dpi-desync-repeats=6 <HOSTLIST_NOAUTO>'
	},
	{
		id: 'disorder',
		title: _('TLS: multidisorder (no fake packets)'),
		text:
			'--filter-tcp=80 --dpi-desync=multisplit --dpi-desync-split-pos=method+2 <HOSTLIST> --new\n' +
			'--filter-tcp=443 --dpi-desync=multidisorder --dpi-desync-split-pos=1,midsld <HOSTLIST> --new\n' +
			'--filter-udp=443 --dpi-desync=fake --dpi-desync-repeats=6 <HOSTLIST_NOAUTO>'
	}
];

function validatePorts(section_id, value) {
	if (value == null || value === '')
		return true;
	if (/^[0-9]+(-[0-9]+)?(,[0-9]+(-[0-9]+)?)*$/.test(value))
		return true;
	return _('Expected a comma separated list of ports or ranges, e.g. 80,443,2053 or 443-65535');
}

function validateMark(section_id, value) {
	if (value == null || value === '')
		return true;
	return /^0x[0-9a-fA-F]+$/.test(value) || _('Expected a hexadecimal mask like 0x40000000');
}

/* a non-persistent dropdown which fills the textarea with a preset */
function addPresetPicker(s, tab, optname, targetOption, presets) {
	var o = s.taboption(tab, form.ListValue, optname, _('Load preset'),
		_('Replaces the text below with a starting point. It is not applied until you press Save & Apply.'));

	o.value('', _('-- choose --'));
	presets.forEach(function(p) { o.value(p.id, p.title); });
	o.cfgvalue = function() { return ''; };
	o.write = function() {};
	o.remove = function() {};
	o.onchange = function(ev, section_id, value) {
		if (!value)
			return;

		var preset = presets.filter(function(p) { return p.id == value; })[0];
		var target = this.map.lookupOption(targetOption, section_id);
		var widget = target && target[0].getUIElement(section_id);

		if (preset && widget)
			widget.setValue(preset.text);
	};

	return o;
}

return view.extend({
	render: function() {
		var m, s, o;

		m = new form.Map('zapret', _('Zapret'),
			_('Settings are stored in /etc/config/zapret. On "Save & Apply" the zapret configuration is regenerated and the service is restarted if it is enabled.'));

		s = m.section(form.NamedSection, 'main', 'zapret');
		s.addremove = false;
		s.anonymous = true;

		s.tab('general', _('General'));
		s.tab('nfqws', _('NFQWS'));
		s.tab('tpws', _('TPWS'));
		s.tab('lists', _('Lists'));
		s.tab('advanced', _('Advanced'));

		/* ---- General ---------------------------------------------------- */

		o = s.taboption('general', form.Flag, 'enabled', _('Enable zapret'),
			_('Start the service at boot and apply changes on Save & Apply. The Start/Stop buttons on the Status page work independently of this switch.'));
		o.rmempty = false;

		o = s.taboption('general', form.ListValue, 'mode_filter', _('Filter mode'),
			_('Which connections are processed. With "none" every connection to the selected ports is handled.'));
		o.value('none', _('none - all traffic'));
		o.value('hostlist', _('hostlist - only domains from the lists'));
		o.value('autohostlist', _('autohostlist - lists + automatic detection of blocked domains'));
		o.value('ipset', _('ipset - only IP addresses from the lists'));
		o.default = 'none';

		o = s.taboption('general', widgets.NetworkSelect, 'lan', _('LAN networks'),
			_('Networks whose clients are processed (traffic from these networks going to the Internet).'));
		o.multiple = true;
		o.nocreate = true;
		o.novirtual = true;
		o.default = 'lan';
		o.rmempty = false;

		o = s.taboption('general', form.ListValue, 'flowoffload', _('Flow offloading'),
			_('Flow offloading (fast path) bypasses the packet filter. "donttouch": leave the system setting as it is. Other values let zapret exclude the processed connections from offloading.'));
		o.value('donttouch', _('donttouch'));
		o.value('none', _('none'));
		o.value('software', _('software'));
		o.value('hardware', _('hardware'));
		o.default = 'donttouch';

		o = s.taboption('general', form.Flag, 'disable_ipv6', _('Disable IPv6'),
			_('Do not process IPv6 traffic. Enable only if your ISP gives you a working IPv6 connection and you need it processed too.'));
		o.default = '1';
		o.rmempty = false;

		o = s.taboption('general', form.Flag, 'disable_ipv4', _('Disable IPv4'));
		o.default = '0';
		o.rmempty = false;

		/* ---- NFQWS ------------------------------------------------------ */

		o = s.taboption('nfqws', form.Flag, 'nfqws_enable', _('Enable nfqws'),
			_('Packet modifier on top of NFQUEUE: sends fake/split packets to confuse DPI. Works for TCP and UDP (QUIC).'));
		o.rmempty = false;

		addPresetPicker(s, 'nfqws', '_nfqws_preset', 'nfqws_opt', NFQWS_PRESETS);

		o = s.taboption('nfqws', form.TextValue, 'nfqws_opt', _('nfqws options'),
			_('One profile per line, separated by --new. The &lt;HOSTLIST&gt; and &lt;HOSTLIST_NOAUTO&gt; markers are replaced according to the filter mode. See the nfqws documentation on GitHub for all options.'));
		o.rows = 8;
		o.monospace = true;
		o.wrap = 'off';
		o.optional = true;

		o = s.taboption('nfqws', form.Value, 'nfqws_ports_tcp', _('TCP ports'),
			_('Outgoing TCP ports redirected to nfqws.'));
		o.default = '80,443';
		o.placeholder = '80,443';
		o.validate = validatePorts;

		o = s.taboption('nfqws', form.Value, 'nfqws_ports_udp', _('UDP ports'),
			_('Outgoing UDP ports redirected to nfqws (443 = QUIC). Leave empty to disable UDP.'));
		o.default = '443';
		o.placeholder = '443';
		o.optional = true;
		o.validate = validatePorts;

		o = s.taboption('nfqws', form.Value, 'nfqws_tcp_pkt_out', _('TCP: packets to the server'),
			_('Only this many first outgoing packets of a connection are passed to nfqws (kernel-side limit that saves CPU). Empty: zapret default.'));
		o.datatype = 'uinteger';
		o.optional = true;

		o = s.taboption('nfqws', form.Value, 'nfqws_tcp_pkt_in', _('TCP: packets from the server'));
		o.datatype = 'uinteger';
		o.optional = true;

		o = s.taboption('nfqws', form.Value, 'nfqws_udp_pkt_out', _('UDP: packets to the server'));
		o.datatype = 'uinteger';
		o.optional = true;

		o = s.taboption('nfqws', form.Value, 'nfqws_udp_pkt_in', _('UDP: packets from the server'));
		o.datatype = 'uinteger';
		o.optional = true;

		o = s.taboption('nfqws', form.Value, 'nfqws_ports_tcp_keepalive', _('TCP ports without packet limit'),
			_('Needed only for stateless DPI that inspects every packet (typically plain HTTP). CPU hungry: enable with care.'));
		o.optional = true;
		o.validate = validatePorts;

		o = s.taboption('nfqws', form.Value, 'nfqws_ports_udp_keepalive', _('UDP ports without packet limit'));
		o.optional = true;
		o.validate = validatePorts;

		/* ---- TPWS ------------------------------------------------------- */

		o = s.taboption('tpws', form.Flag, 'tpws_enable', _('Enable tpws'),
			_('Transparent TCP proxy: redirects connections to a local proxy that splits the stream. Does not need NFQUEUE; works only for TCP.'));
		o.rmempty = false;

		o = s.taboption('tpws', form.TextValue, 'tpws_opt', _('tpws options'),
			_('One profile per line, separated by --new. Empty: zapret default.'));
		o.rows = 6;
		o.monospace = true;
		o.wrap = 'off';
		o.optional = true;

		o = s.taboption('tpws', form.Value, 'tpws_ports', _('TCP ports'),
			_('Outgoing TCP ports redirected to tpws.'));
		o.default = '80,443';
		o.placeholder = '80,443';
		o.validate = validatePorts;

		o = s.taboption('tpws', form.Flag, 'tpws_socks_enable', _('Enable SOCKS proxy'),
			_('Run tpws as a SOCKS5 proxy on localhost and LAN interfaces. Point applications or other devices at it manually.'));
		o.rmempty = false;

		o = s.taboption('tpws', form.Value, 'tpport_socks', _('SOCKS port'));
		o.datatype = 'port';
		o.default = '987';
		o.placeholder = '987';

		o = s.taboption('tpws', form.TextValue, 'tpws_socks_opt', _('SOCKS tpws options'));
		o.rows = 4;
		o.monospace = true;
		o.wrap = 'off';
		o.optional = true;

		/* ---- Lists ------------------------------------------------------ */

		o = s.taboption('lists', form.ListValue, 'getlist', _('Download lists'),
			_('Script that downloads/refreshes lists for the "hostlist" and "ipset" modes. Domain lists suit the hostlist modes, IP lists suit ipset mode.'));
		o.value('', _('-- none --'));
		o.value('get_refilter_domains.sh', _('Re-filter: domains'));
		o.value('get_antizapret_domains.sh', _('antizapret: domains'));
		o.value('get_reestr_resolvable_domains.sh', _('registry: domains that resolve'));
		o.value('get_reestr_preresolved_smart.sh', _('registry: pre-resolved IPs (smart)'));
		o.value('get_reestr_preresolved.sh', _('registry: pre-resolved IPs'));
		o.value('get_refilter_ipsum.sh', _('Re-filter: IP list (ipsum)'));
		o.value('get_antifilter_ip.sh', _('antifilter: ip'));
		o.value('get_antifilter_ipsmart.sh', _('antifilter: ipsmart'));
		o.value('get_antifilter_ipsum.sh', _('antifilter: ipsum'));
		o.value('get_antifilter_ipresolve.sh', _('antifilter: ipresolve'));
		o.value('get_antifilter_allyouneed.sh', _('antifilter: allyouneed'));
		o.value('get_user.sh', _('only my own list (resolve domains to IPs)'));
		o.value('get_ipban.sh', _('only the IP ban list'));

		o = s.taboption('lists', form.Value, 'list_update_hour', _('Daily update hour'),
			_('Hour of the day (0-23) when the lists are downloaded automatically. Empty: no automatic update.'));
		o.datatype = 'range(0,23)';
		o.optional = true;
		o.placeholder = '6';

		o = s.taboption('lists', form.Flag, 'gzip_lists', _('Compress lists'),
			_('Store downloaded lists gzip-compressed (saves flash/RAM, slightly slower).'));
		o.default = '1';
		o.rmempty = false;

		o = s.taboption('lists', form.Value, 'autohostlist_fail_threshold', _('autohostlist: failure threshold'),
			_('Number of failed connections within the time window after which a domain is added to the auto list.'));
		o.datatype = 'uinteger';
		o.placeholder = '3';
		o.optional = true;
		o.depends('mode_filter', 'autohostlist');

		o = s.taboption('lists', form.Value, 'autohostlist_fail_time', _('autohostlist: time window, s'));
		o.datatype = 'uinteger';
		o.placeholder = '60';
		o.optional = true;
		o.depends('mode_filter', 'autohostlist');

		o = s.taboption('lists', form.Value, 'autohostlist_retrans_threshold', _('autohostlist: retransmission threshold'));
		o.datatype = 'uinteger';
		o.placeholder = '3';
		o.optional = true;
		o.depends('mode_filter', 'autohostlist');

		o = s.taboption('lists', form.Flag, 'autohostlist_debuglog', _('autohostlist: debug log'),
			_('Log automatically detected domains to zapret-hosts-auto-debug.log in the lists directory.'));
		o.rmempty = false;
		o.depends('mode_filter', 'autohostlist');

		o = s.taboption('lists', form.Value, 'mdig_threads', _('Resolver threads'),
			_('Parallel threads used to resolve domain lists to IP addresses.'));
		o.datatype = 'range(1,200)';
		o.placeholder = '30';
		o.optional = true;

		/* ---- Advanced --------------------------------------------------- */

		o = s.taboption('advanced', form.ListValue, 'fwtype', _('Firewall type'),
			_('Normally autodetected. nftables (fw4) is the primary supported mode; iptables is for old fw3 systems.'));
		o.value('', _('autodetect'));
		o.value('nftables', 'nftables');
		o.value('iptables', 'iptables');

		o = s.taboption('advanced', form.Flag, 'postnat', _('Post-NAT mode (nftables)'),
			_('Process packets after NAT (default). Pre-NAT mode lets debug logs show client addresses but disables some bypass techniques for forwarded traffic.'));
		o.default = '1';
		o.rmempty = false;

		o = s.taboption('advanced', form.Flag, 'init_apply_fw', _('Manage firewall rules'),
			_('Let the service add/remove its firewall rules on start/stop.'));
		o.default = '1';
		o.rmempty = false;

		o = s.taboption('advanced', form.Flag, 'filter_ttl_expired_icmp', _('Drop ICMP time-exceeded'),
			_('Drop ICMP "time exceeded" for connections modified by nfqws. Disable if traceroute/mtr is affected.'));
		o.default = '1';
		o.rmempty = false;

		o = s.taboption('advanced', widgets.NetworkSelect, 'wan4', _('WAN networks (IPv4)'),
			_('By default these are the interfaces with an IPv4 default route.'));
		o.multiple = true;
		o.nocreate = true;
		o.novirtual = true;
		o.optional = true;

		o = s.taboption('advanced', widgets.NetworkSelect, 'wan6', _('WAN networks (IPv6)'),
			_('By default these are the interfaces with an IPv6 default route.'));
		o.multiple = true;
		o.nocreate = true;
		o.novirtual = true;
		o.optional = true;

		o = s.taboption('advanced', form.Value, 'ws_user', _('Daemon user'),
			_('Unprivileged user the nfqws/tpws processes switch to.'));
		o.placeholder = 'daemon';
		o.optional = true;

		o = s.taboption('advanced', form.Value, 'qnum', _('NFQUEUE number'));
		o.datatype = 'range(0,65535)';
		o.placeholder = '200';
		o.optional = true;

		o = s.taboption('advanced', form.Value, 'tpport', _('tpws transparent port'));
		o.datatype = 'port';
		o.placeholder = '988';
		o.optional = true;

		o = s.taboption('advanced', form.Value, 'desync_mark', _('Desync mark'),
			_('Packet mark used by nfqws to avoid loops.'));
		o.placeholder = '0x40000000';
		o.optional = true;
		o.validate = validateMark;

		o = s.taboption('advanced', form.Value, 'desync_mark_postnat', _('Desync mark (post-NAT)'));
		o.placeholder = '0x20000000';
		o.optional = true;
		o.validate = validateMark;

		o = s.taboption('advanced', form.Value, 'filter_mark', _('Filter mark'),
			_('If set, only packets carrying this mark are redirected to nfqws/tpws. Lets you restrict zapret with your own firewall rules.'));
		o.placeholder = '0x10000000';
		o.optional = true;
		o.validate = validateMark;

		o = s.taboption('advanced', form.Value, 'tmpdir', _('Temporary directory'),
			_('Used while downloading lists. Set it if /tmp is too small.'));
		o.placeholder = '/tmp';
		o.optional = true;

		o = s.taboption('advanced', form.TextValue, 'extra_config', _('Extra configuration'),
			_('Raw lines appended to the generated zapret config (shell syntax, VAR="value"). Use it for variables that have no field here, e.g. IPSET_OPT or IP2NET_OPT4. Careful: wrong syntax prevents the service from starting.'));
		o.rows = 6;
		o.monospace = true;
		o.wrap = 'off';
		o.optional = true;

		return m.render();
	}
});
