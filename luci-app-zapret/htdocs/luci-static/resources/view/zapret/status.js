'use strict';
'require view';
'require rpc';
'require ui';
'require poll';
'require dom';

var callStatus = rpc.declare({
	object: 'luci.zapret',
	method: 'status'
});

var callService = rpc.declare({
	object: 'luci.zapret',
	method: 'service',
	params: [ 'action' ]
});

var callJobStart = rpc.declare({
	object: 'luci.zapret',
	method: 'job_start',
	params: [ 'job' ]
});

var callGetLog = rpc.declare({
	object: 'luci.zapret',
	method: 'get_log'
});

var COLOR_OK = '#2e7d32', COLOR_OFF = '#757575', COLOR_WARN = '#ef6c00';

function badge(text, color) {
	return E('span', {
		'style': 'display:inline-block;padding:1px 10px;border-radius:10px;color:#fff;background:' + color
	}, text);
}

function fmtSize(n) {
	if (n < 1024)
		return n + ' B';
	if (n < 1024 * 1024)
		return (n / 1024).toFixed(1) + ' KiB';
	return (n / 1024 / 1024).toFixed(1) + ' MiB';
}

function fmtTime(ts) {
	return ts ? new Date(ts * 1000).toLocaleString() : '-';
}

function row(label, value) {
	return E('div', { 'class': 'tr' }, [
		E('div', { 'class': 'td left', 'style': 'width:33%' }, E('strong', {}, label)),
		E('div', { 'class': 'td left' }, value)
	]);
}

function listTitle(id) {
	switch (id) {
	case 'hosts-user':         return _('My hostlist');
	case 'hosts-user-exclude': return _('Exclusions');
	case 'hosts-user-ipban':   return _('IP ban list');
	case 'hosts-auto':         return _('Auto hostlist');
	}
	return id;
}

return view.extend({
	load: function() {
		return Promise.all([ callStatus(), callGetLog() ]);
	},

	runAction: function(action, label) {
		return callService(action).then(L.bind(function(res) {
			if (!res || !res.ok)
				ui.addNotification(null, E('div', [
					E('p', _('Command failed: %s').format(label)),
					E('pre', {}, (res && (res.output || res.error)) || '')
				]), 'danger');
			return this.refresh();
		}, this)).catch(function(err) {
			ui.addNotification(null, E('p', err.message), 'danger');
		});
	},

	runUpdateLists: function() {
		return callJobStart('update-lists').then(function(res) {
			if (!res || !res.ok)
				ui.addNotification(null, E('p', _('Cannot start the list update (already running?)')), 'warning');
			else
				ui.addNotification(null, E('p', _('List update started in the background. See the Lists page for progress.')), 'info');
		});
	},

	refresh: function() {
		return this.load().then(L.bind(function(data) {
			this.update(data[0], data[1]);
		}, this));
	},

	update: function(st, log) {
		var self = this;
		var running = st.running;
		var mode = st.mode_filter;
		var anyDaemon = st.nfqws_enable || st.tpws_enable || st.tpws_socks_enable;
		var daemonNames = [];

		if (st.nfqws_enable) daemonNames.push('nfqws');
		if (st.tpws_enable) daemonNames.push('tpws');
		if (st.tpws_socks_enable) daemonNames.push('tpws (SOCKS)');

		var summary = E('div', { 'class': 'table' }, [
			row(_('Service'), [
				running ? badge(_('Running'), COLOR_OK) : badge(_('Stopped'), COLOR_OFF),
				' ',
				st.enabled ? _('(enabled in settings)') : _('(disabled in settings: will not start at boot)')
			]),
			row(_('zapret version'), st.version || '-'),
			row(_('Filter mode'), mode),
			row(_('Enabled components'), daemonNames.length ? daemonNames.join(', ') : badge(_('none'), COLOR_WARN)),
			row(_('Firewall'), [
				st.firewall.backend, ': ',
				st.firewall.active ? badge(_('rules active'), COLOR_OK) : badge(_('no rules'), COLOR_OFF)
			])
		]);

		var warn = null;
		if (!anyDaemon)
			warn = E('div', { 'class': 'alert-message warning' },
				_('Neither nfqws nor tpws is turned on, so there is nothing to start. Enable one of them in Settings.'));

		var buttons = E('div', { 'style': 'margin:1em 0' }, [
			E('button', {
				'class': 'cbi-button cbi-button-positive',
				'click': ui.createHandlerFn(this, 'runAction', 'start', _('Start'))
			}, _('Start')),
			' ',
			E('button', {
				'class': 'cbi-button cbi-button-negative',
				'click': ui.createHandlerFn(this, 'runAction', 'stop', _('Stop'))
			}, _('Stop')),
			' ',
			E('button', {
				'class': 'cbi-button cbi-button-action',
				'click': ui.createHandlerFn(this, 'runAction', 'restart', _('Restart'))
			}, _('Restart')),
			' ',
			E('button', {
				'class': 'cbi-button',
				'click': ui.createHandlerFn(this, 'runUpdateLists')
			}, _('Update lists now'))
		]);

		var daemons = E('div', { 'class': 'table' }, [
			E('div', { 'class': 'tr table-titles' }, [
				E('div', { 'class': 'th' }, _('Process')),
				E('div', { 'class': 'th' }, _('PID')),
				E('div', { 'class': 'th' }, _('Command line'))
			])
		]);
		st.daemons.forEach(function(d) {
			daemons.appendChild(E('div', { 'class': 'tr' }, [
				E('div', { 'class': 'td' }, [ d.name, ' ', d.running ? badge(_('running'), COLOR_OK) : badge(_('stopped'), COLOR_OFF) ]),
				E('div', { 'class': 'td' }, d.pid ? String(d.pid) : '-'),
				E('div', { 'class': 'td', 'style': 'word-break:break-all;font-family:monospace;font-size:90%' }, d.command)
			]));
		});
		if (!st.daemons.length)
			daemons.appendChild(E('div', { 'class': 'tr placeholder' },
				E('div', { 'class': 'td' }, E('em', _('No zapret processes are running')))));

		var lists = E('div', { 'class': 'table' }, [
			E('div', { 'class': 'tr table-titles' }, [
				E('div', { 'class': 'th' }, _('List')),
				E('div', { 'class': 'th' }, _('Entries')),
				E('div', { 'class': 'th' }, _('Size')),
				E('div', { 'class': 'th' }, _('Modified'))
			])
		]);
		st.lists.forEach(function(l) {
			lists.appendChild(E('div', { 'class': 'tr' }, [
				E('div', { 'class': 'td' }, listTitle(l.id)),
				E('div', { 'class': 'td' }, l.lines == null ? '-' : String(l.lines)),
				E('div', { 'class': 'td' }, l.exists ? fmtSize(l.size) : '-'),
				E('div', { 'class': 'td' }, l.exists ? fmtTime(l.mtime) : '-')
			]));
		});
		lists.appendChild(E('div', { 'class': 'tr' }, [
			E('div', { 'class': 'td' }, _('Downloaded list (%s)').format(st.getlist || _('not configured'))),
			E('div', { 'class': 'td' }, '-'),
			E('div', { 'class': 'td' }, st.downloaded.exists ? fmtSize(st.downloaded.size) : '-'),
			E('div', { 'class': 'td' }, st.downloaded.exists ? fmtTime(st.downloaded.mtime) : '-')
		]));

		var logbox = E('pre', {
			'style': 'max-height:22em;overflow:auto;font-size:85%;white-space:pre-wrap'
		}, (log && log.log) || _('(empty)'));

		var parts = [];
		if (warn)
			parts.push(warn);
		parts.push(
			E('h3', _('Overview')), summary, buttons,
			E('h3', _('Processes')), daemons,
			E('h3', _('Lists')), lists,
			E('h3', _('System log (zapret)')), logbox
		);

		dom.content(this.container, parts);

		logbox.scrollTop = logbox.scrollHeight;
	},

	render: function(data) {
		this.container = E('div');
		this.update(data[0], data[1]);

		poll.add(L.bind(this.refresh, this), 5);

		return E('div', {}, [
			E('h2', _('Zapret')),
			E('div', { 'class': 'cbi-map-descr' },
				_('Bypass of DPI-based blocking with nfqws and tpws. Configure it on the Settings page.')),
			this.container
		]);
	},

	handleSaveApply: null,
	handleSave: null,
	handleReset: null
});
