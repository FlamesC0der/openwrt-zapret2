'use strict';
'require view';
'require form';
'require rpc';
'require tools.widgets as widgets';

var callPresets = rpc.declare({
	object: 'luci.zapret2',
	method: 'presets'
});

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

/*
 * Note for the JS minifier that luci.mk runs at build time (JSMin): a regular expression with
 * quote characters inside makes it misread the following string as a comment, so the quote and
 * backtick are written as \u escapes here and there is no "//" inside a string next to a regex.
 */
function validateUrl(section_id, value) {
	if (value == null || value === '')
		return true;
	if (/^https?:\/\/\S+$/.test(value) && !/[\u0022\u0027\u0060$\\]/.test(value))
		return true;
	return _('Expected an http or https URL without spaces or quotes');
}

return view.extend({
	load: function() {
		return callPresets().catch(function() { return { presets: [] }; });
	},

	render: function(data) {
		var m, s, o;
		var presets = (data && data.presets) || [];

		m = new form.Map('zapret2', _('Zapret2'),
			_('Settings are stored in /etc/config/zapret2. On "Save & Apply" the zapret2 configuration is regenerated and the service is restarted if it is enabled.'));

		s = m.section(form.NamedSection, 'main', 'zapret2');
		s.addremove = false;
		s.anonymous = true;

		s.tab('general', _('General'));
		s.tab('nfqws', _('nfqws2'));
		s.tab('presets', _('Presets'));
		s.tab('lists', _('Lists'));
		s.tab('updates', _('Updates'));
		s.tab('advanced', _('Advanced'));

		/* ---- General ---------------------------------------------------- */

		o = s.taboption('general', form.Flag, 'enabled', _('Enable zapret2'),
			_('Start the service at boot and apply changes on Save & Apply. The Start/Stop buttons on the Status page work independently of this switch.'));
		o.rmempty = false;

		o = s.taboption('general', form.ListValue, 'preset', _('Active preset'),
			_('The strategy that nfqws2 uses. You can also switch it, view and edit presets on the Presets page.'));
		/* preset names come from files (possibly downloaded): keep markup characters out of the label */
		presets.forEach(function(p) { o.value(p.id, '%s (%s)'.format(String(p.name).replace(/[<>&"'`]/g, ''), p.id)); });
		o.default = 'default';
		o.rmempty = false;

		o = s.taboption('general', form.ListValue, 'mode_filter', _('Filter mode'),
			_('Which connections are processed by the &lt;HOSTLIST&gt; parts of a preset. With "none" every connection to the selected ports is handled.'));
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
			_('Flow offloading (fast path) bypasses the packet filter. "donttouch": leave the system setting as it is. Other values let zapret2 exclude the processed connections from offloading.'));
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

		/* ---- nfqws2 ----------------------------------------------------- */

		o = s.taboption('nfqws', form.Flag, 'nfqws2_enable', _('Enable nfqws2'),
			_('Packet processor on top of NFQUEUE whose strategies are Lua programs. Works for TCP and UDP (QUIC).'));
		o.rmempty = false;

		o = s.taboption('nfqws', form.Value, 'nfqws2_ports_tcp', _('TCP ports (override)'),
			_('Outgoing TCP ports redirected to nfqws2. Empty: the ports from the preset header (usually 80,443).'));
		o.placeholder = '80,443';
		o.optional = true;
		o.validate = validatePorts;

		o = s.taboption('nfqws', form.Value, 'nfqws2_ports_udp', _('UDP ports (override)'),
			_('Outgoing UDP ports redirected to nfqws2 (443 = QUIC). Empty: the ports from the preset header.'));
		o.placeholder = '443';
		o.optional = true;
		o.validate = validatePorts;

		o = s.taboption('nfqws', form.Value, 'nfqws2_tcp_pkt_out', _('TCP: packets to the server'),
			_('Only this many first outgoing packets of a connection are passed to nfqws2 (kernel-side limit that saves CPU). Empty: zapret2 default.'));
		o.datatype = 'uinteger';
		o.optional = true;

		o = s.taboption('nfqws', form.Value, 'nfqws2_tcp_pkt_in', _('TCP: packets from the server'));
		o.datatype = 'uinteger';
		o.optional = true;

		o = s.taboption('nfqws', form.Value, 'nfqws2_udp_pkt_out', _('UDP: packets to the server'));
		o.datatype = 'uinteger';
		o.optional = true;

		o = s.taboption('nfqws', form.Value, 'nfqws2_udp_pkt_in', _('UDP: packets from the server'));
		o.datatype = 'uinteger';
		o.optional = true;

		o = s.taboption('nfqws', form.Value, 'nfqws2_ports_tcp_keepalive', _('TCP ports without packet limit'),
			_('Needed only for stateless DPI that inspects every packet (typically plain HTTP). CPU hungry: enable with care.'));
		o.optional = true;
		o.validate = validatePorts;

		o = s.taboption('nfqws', form.Value, 'nfqws2_ports_udp_keepalive', _('UDP ports without packet limit'));
		o.optional = true;
		o.validate = validatePorts;

		/* ---- Presets ---------------------------------------------------- */

		o = s.taboption('presets', form.DynamicList, 'preset_url', _('Preset sources'),
			_('URLs of text files with presets. They are downloaded by the "Download presets" button and, if enabled below, by the daily update. Downloaded presets are stored in /etc/zapret2/presets/downloaded; your own presets are never overwritten. A preset can contain Lua code that runs inside nfqws2: use only sources you trust, preferably over https.'));
		o.placeholder = 'https://example.com/zapret2-presets.txt';
		o.optional = true;
		o.validate = validateUrl;

		o = s.taboption('presets', form.Flag, 'presets_auto_update', _('Update presets daily'),
			_('Download the preset sources together with the lists at the hour set on the Lists tab. If the active preset changed, nfqws2 is restarted.'));
		o.rmempty = false;

		/* ---- Lists ------------------------------------------------------ */

		o = s.taboption('lists', form.ListValue, 'getlist', _('Download lists'),
			_('Script that downloads/refreshes the ready-made upstream lists for the "hostlist" and "ipset" modes. Domain lists suit the hostlist modes, IP lists suit ipset mode. Your own lists with URLs are managed on the Lists page.'));
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
			_('Hour of the day (0-23) when the lists (and presets, if enabled) are downloaded automatically. Empty: no automatic update.'));
		o.datatype = 'range(0,23)';
		o.optional = true;
		o.placeholder = '6';

		o = s.taboption('lists', form.Flag, 'gzip_lists', _('Compress lists'),
			_('Store lists downloaded by the upstream scripts gzip-compressed (saves flash/RAM, slightly slower).'));
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

		/* ---- Updates ---------------------------------------------------- */

		o = s.taboption('updates', form.Flag, 'update_check_daily', _('Check for updates daily'),
			_('Look for a new version once a day (at the hour set on the Lists tab) and write the result to the system log. Nothing is installed automatically.'));
		o.rmempty = false;

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
			_('Drop ICMP "time exceeded" for connections modified by nfqws2. Disable if traceroute/mtr is affected.'));
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
			_('Unprivileged user the nfqws2 process switches to.'));
		o.placeholder = 'daemon';
		o.optional = true;

		o = s.taboption('advanced', form.Value, 'qnum', _('NFQUEUE number'));
		o.datatype = 'range(0,65535)';
		o.placeholder = '300';
		o.optional = true;

		o = s.taboption('advanced', form.Value, 'desync_mark', _('Desync mark'),
			_('Packet mark used by nfqws2 to avoid loops.'));
		o.placeholder = '0x40000000';
		o.optional = true;
		o.validate = validateMark;

		o = s.taboption('advanced', form.Value, 'desync_mark_postnat', _('Desync mark (post-NAT)'));
		o.placeholder = '0x20000000';
		o.optional = true;
		o.validate = validateMark;

		o = s.taboption('advanced', form.Value, 'filter_mark', _('Filter mark'),
			_('If set, only packets carrying this mark are redirected to nfqws2. Lets you restrict zapret2 with your own firewall rules.'));
		o.placeholder = '0x10000000';
		o.optional = true;
		o.validate = validateMark;

		o = s.taboption('advanced', form.Value, 'tmpdir', _('Temporary directory'),
			_('Used while downloading lists. Set it if /tmp is too small.'));
		o.placeholder = '/tmp';
		o.optional = true;

		o = s.taboption('advanced', form.TextValue, 'extra_config', _('Extra configuration'),
			_('Raw lines appended to the generated zapret2 config (shell syntax, VAR="value"). Use it for variables that have no field here, e.g. IPSET_OPT or IP2NET_OPT4. Careful: wrong syntax prevents the service from starting.'));
		o.rows = 6;
		o.monospace = true;
		o.wrap = 'off';
		o.optional = true;

		return m.render();
	}
});
