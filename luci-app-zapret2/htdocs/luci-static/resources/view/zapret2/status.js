'use strict';
'require view';
'require rpc';
'require ui';
'require poll';
'require dom';
'require zapret2.icons as icons';

var callStatus = rpc.declare({
	object: 'luci.zapret2',
	method: 'status'
});

var callService = rpc.declare({
	object: 'luci.zapret2',
	method: 'service',
	params: [ 'action' ]
});

var callSetEnabled = rpc.declare({
	object: 'luci.zapret2',
	method: 'set_enabled',
	params: [ 'on' ]
});

var callJobStart = rpc.declare({
	object: 'luci.zapret2',
	method: 'job_start',
	params: [ 'job' ]
});

var callCheckUpdate = rpc.declare({
	object: 'luci.zapret2',
	method: 'check_update'
});

var callGetLog = rpc.declare({
	object: 'luci.zapret2',
	method: 'get_log'
});

/*
 * E() inserts a lone string child with innerHTML. Names, descriptions, URLs and log lines
 * here can come from the network, so everything goes through h(), which always creates
 * text nodes (a string is never parsed as HTML).
 */
function h(tag, attrs, children) {
	if (attrs == null || typeof attrs === 'string' || Array.isArray(attrs) || attrs instanceof Node) {
		if (attrs != null)
			children = attrs;
		attrs = null;
	}
	if (children != null && !Array.isArray(children))
		children = [ children ];
	if (attrs)
		return children ? E(tag, attrs, children) : E(tag, attrs);
	return children ? E(tag, children) : E(tag);
}

/* E() sets any non-null attribute (even "false"), so a boolean attribute must be null when off */
function flag(v) {
	return v ? '' : null;
}

var COLOR_OK = icons.colors.ok, COLOR_OFF = icons.colors.off, COLOR_WARN = icons.colors.warn, COLOR_BAD = icons.colors.bad;

/* a small state tag: [icon, text, color] */
function badge(text, color, icon) {
	return icons.chip(icon || 'check', text, color, 14);
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

function listTitle(l) {
	switch (l.id) {
	case 'user':       return _('My hostlist');
	case 'exclude':    return _('Exclusions');
	case 'ipban':      return _('IP ban list');
	case 'auto':       return _('Auto hostlist');
	case 'downloaded': return _('Downloaded list');
	}
	return l.title || l.id;
}

function modeTitle(mode) {
	switch (mode) {
	case 'none':         return _('Everything');
	case 'hostlist':     return _('Only my list');
	case 'autohostlist': return _('My list + auto-detect');
	case 'ipset':        return _('By IP address');
	}
	return mode;
}

function modeIcon(mode) {
	switch (mode) {
	case 'hostlist':     return 'list';
	case 'autohostlist': return 'zap';
	case 'ipset':        return 'network';
	}
	return 'globe';
}

function modeText(mode) {
	switch (mode) {
	case 'none':         return _('All traffic goes through zapret, except the sites in the bypass list.');
	case 'hostlist':     return _('Only the sites from the "Through zapret" list (and downloaded lists) go through zapret.');
	case 'autohostlist': return _('Your list plus sites where blocking was detected automatically.');
	case 'ipset':        return _('Matched by the IP addresses of the lists.');
	}
	return '';
}

/* what the GitHub update check can answer instead of a version */
function updateError(code) {
	switch (code) {
	case 'not_found': return _('The project repository was not found, or it has no releases yet.');
	case 'forbidden': return _('GitHub refused the request: too many requests from this address. Try again later.');
	case 'network':   return _('Cannot reach GitHub. Check the internet connection of the router.');
	}
	return _('The update check failed (%s).').format(code);
}

function card(icon, title, body, link) {
	return h('div', {
		'style': 'border-radius:8px;padding:.8em 1em;border:1px solid rgba(128,128,128,.4);display:flex;gap:.8em;align-items:flex-start'
	}, [
		h('div', { 'style': 'opacity:.75;padding-top:.15em' }, [ icons.icon(icon, 26) ]),
		h('div', {}, [
			h('div', { 'style': 'opacity:.7;font-size:90%' }, [ title ]),
			h('div', { 'style': 'font-size:115%;font-weight:bold;margin:.15em 0' }, body),
			link || ''
		])
	]);
}

return view.extend({
	load: function() {
		return Promise.all([ callStatus(), callGetLog() ]);
	},

	runAction: function(action, label) {
		return callService(action).then(L.bind(function(res) {
			if (!res || !res.ok)
				ui.addNotification(null, h('div', [
					h('p', _('Command failed: %s').format(label)),
					h('pre', {}, (res && (res.output || res.error)) || '')
				]), 'danger');
			return this.refresh();
		}, this)).catch(function(err) {
			ui.addNotification(null, h('p', err.message), 'danger');
		});
	},

	/* the big switch: turns the service and nfqws2 on or off in one click */
	toggle: function(on) {
		return callSetEnabled(on).then(L.bind(function(res) {
			if (!res || !res.ok)
				ui.addNotification(null, h('div', [
					h('p', _('Cannot change the state: %s').format((res && (res.output || res.error)) || '?'))
				]), 'danger');
			return this.refresh();
		}, this)).catch(function(err) {
			ui.addNotification(null, h('p', err.message), 'danger');
		});
	},

	runJob: function(job) {
		return callJobStart(job).then(function(res) {
			if (!res || !res.ok)
				ui.addNotification(null, h('p', _('Cannot start the task (already running?)')), 'warning');
			else
				ui.addNotification(null, h('p', _('The task was started in the background. See the Lists and Presets pages for progress.')), 'info');
		});
	},

	checkUpdate: function() {
		return callCheckUpdate().then(L.bind(function(res) {
			this.upd = res;
			return this.refresh();
		}, this)).catch(function(err) {
			ui.addNotification(null, h('p', err.message), 'danger');
		});
	},

	refresh: function() {
		return this.load().then(L.bind(function(data) {
			this.update(data[0], data[1]);
		}, this));
	},

	/* ---- the "new version" block ---- */

	updateBox: function(st) {
		var u = this.upd || st.update;
		var cur = (st.versions && st.versions.port) || '';
		var rows = [];

		rows.push(h('div', {}, [
			_('Installed version:'), ' ', h('strong', {}, cur || _('unknown')),
			' · zapret2 ', (st.versions && st.versions.zapret2) || '-'
		]));

		if (u && u.ok && u.available) {
			rows.push(h('div', {
				'style': 'margin:.6em 0;padding:.6em .9em;border-radius:6px;border:1px solid ' + COLOR_WARN + '66;background:' + COLOR_WARN + '14;display:flex;gap:.7em;align-items:center'
			}, [
				h('span', { 'style': 'color:' + COLOR_WARN }, [ icons.icon('download', 24) ]),
				h('strong', {}, _('A new version is available: %s').format(u.latest)),
				u.title && u.title !== u.tag ? ' — ' + u.title : ''
			]));
			if (u.notes)
				rows.push(h('pre', { 'style': 'max-height:12em;overflow:auto;font-size:85%;white-space:pre-wrap' }, u.notes));
			rows.push(h('div', { 'style': 'margin:.4em 0' }, [
				(typeof u.url === 'string' && u.url.indexOf('https://github.com/') === 0)
					? h('a', { 'href': u.url, 'target': '_blank', 'rel': 'noopener noreferrer' }, icons.label('external', _('Open the release page'), 16))
					: '',
				' ',
				_('Download the packages for your router from the release page, copy them to /tmp and install them: "opkg install /tmp/*.ipk" (OpenWrt 24.10 and older) or "apk add --allow-untrusted /tmp/*.apk" (OpenWrt 25.12+).')
			]));
		}
		else if (u && u.ok) {
			rows.push(h('div', { 'style': 'margin:.4em 0;display:flex;flex-wrap:wrap;gap:.6em;align-items:center' }, [
				badge(_('up to date'), COLOR_OK, 'check-circle'),
				_('The latest published version is %s.').format(u.latest),
				h('span', { 'style': 'opacity:.6' }, _('Checked: %s').format(fmtTime(u.checked)))
			]));
		}
		else if (u && u.error) {
			rows.push(h('div', {
				'style': 'margin:.6em 0;padding:.6em .9em;border-radius:6px;border:1px solid ' + COLOR_WARN + '66;background:' + COLOR_WARN + '14;display:flex;gap:.7em;align-items:center'
			}, [
				h('span', { 'style': 'color:' + COLOR_WARN }, [ icons.icon('alert', 22) ]),
				updateError(u.error)
			]));
		}

		rows.push(h('div', { 'style': 'margin-top:.6em;display:flex;flex-wrap:wrap;gap:.8em;align-items:center' }, [
			h('button', { 'class': 'cbi-button cbi-button-action', 'click': ui.createHandlerFn(this, 'checkUpdate') },
				[ icons.label('refresh', _('Check for updates')) ]),
			h('span', { 'style': 'opacity:.6' }, [ st.github_repo ])
		]));

		return h('div', {
			'style': 'border-radius:8px;padding:.8em 1em;border:1px solid rgba(128,128,128,.4);margin-top:1em'
		}, [ h('div', { 'style': 'opacity:.7;font-size:90%;margin-bottom:.3em' }, icons.label('download', _('Updates'), 16)) ].concat(rows));
	},

	update: function(st, log) {
		var self = this;
		var running = st.running;
		var on = st.on;
		var user = st.lists.filter(function(l) { return l.id === 'user'; })[0] || {};
		var excl = st.lists.filter(function(l) { return l.id === 'exclude'; })[0] || {};

		/* ---- the main banner ---- */
		var color = running ? COLOR_OK : (on ? COLOR_WARN : COLOR_OFF);
		var shield = running ? 'shield-check' : (on ? 'shield-alert' : 'shield-off');
		var title, sub;

		if (running) {
			title = _('Zapret2 is working');
			sub = _('Strategy "%s", mode "%s".').format(st.preset.name, modeTitle(st.mode_filter));
		}
		else if (on) {
			title = _('Zapret2 is on, but not running');
			sub = _('Press "Restart". If it does not start, see the system log below.');
		}
		else {
			title = _('Zapret2 is off');
			sub = st.nfqws2_enable
				? _('Press the button to start it.')
				: _('Press the button to turn it on: it enables the service and nfqws2 with the selected strategy.');
		}

		var banner = h('div', {
			'style': 'border-radius:10px;padding:1.1em 1.3em;color:#fff;background:linear-gradient(135deg,' + color + ',' + color + 'cc);' +
				'display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:.9em'
		}, [
			h('div', { 'style': 'display:flex;align-items:center;gap:.9em' }, [
				h('div', {
					'style': 'width:3.4em;height:3.4em;border-radius:50%;background:rgba(255,255,255,.2);display:flex;align-items:center;justify-content:center'
				}, [ icons.icon(shield, 32) ]),
				h('div', {}, [
					h('div', { 'style': 'font-size:140%;font-weight:bold' }, title),
					h('div', { 'style': 'opacity:.92' }, sub)
				])
			]),
			h('div', { 'style': 'display:flex;gap:.6em;flex-wrap:wrap' }, [
				h('button', {
					'class': 'cbi-button',
					'style': 'font-size:110%;padding:.4em 1.3em;font-weight:bold',
					'click': ui.createHandlerFn(this, 'toggle', !on)
				}, [ icons.label('power', on ? _('Turn off') : _('Turn on'), 20) ]),
				on ? h('button', {
					'class': 'cbi-button',
					'style': 'padding:.4em 1em',
					'click': ui.createHandlerFn(this, 'runAction', 'restart', _('Restart'))
				}, [ icons.label('refresh', _('Restart'), 18) ]) : ''
			])
		]);

		/* ---- the cards: strategy, scope, lists, diagnostics ---- */
		var cards = h('div', {
			'style': 'display:grid;grid-template-columns:repeat(auto-fit,minmax(15em,1fr));gap:.8em;margin-top:1em'
		}, [
			card('sliders', _('Strategy'),
				st.preset.found ? [ st.preset.name ] : [ badge(_('not found'), COLOR_WARN, 'alert') ],
				h('a', { 'href': L.url('admin', 'services', 'zapret2', 'presets') }, _('Change strategy'))),
			card(modeIcon(st.mode_filter), _('What goes through zapret'),
				[ modeTitle(st.mode_filter) ],
				h('div', {}, [
					h('div', { 'style': 'opacity:.75;font-size:90%;margin:.2em 0' }, modeText(st.mode_filter)),
					h('a', { 'href': L.url('admin', 'services', 'zapret2', 'lists') }, _('Change'))
				])),
			card('list', _('Lists'),
				[ _('%d through zapret · %d bypass').format(user.lines || 0, excl.lines || 0) ],
				h('a', { 'href': L.url('admin', 'services', 'zapret2', 'lists') }, _('Edit lists'))),
			card('activity', _('Diagnostics'),
				[ _('TCP 16-20 blocking') ],
				h('a', { 'href': L.url('admin', 'services', 'zapret2', 'diagnostics') }, _('Run the check')))
		]);

		/* ---- technical details, collapsed ---- */
		var daemons = h('div', { 'class': 'table' }, [
			h('div', { 'class': 'tr table-titles' }, [
				h('div', { 'class': 'th' }, _('Process')),
				h('div', { 'class': 'th' }, _('Process ID')),
				h('div', { 'class': 'th' }, _('Command line'))
			])
		]);
		st.daemons.forEach(function(d) {
			daemons.appendChild(h('div', { 'class': 'tr' }, [
				h('div', { 'class': 'td' }, [ d.name, ' ', d.running ? badge(_('running'), COLOR_OK, 'play') : badge(_('stopped'), COLOR_OFF, 'stop') ]),
				h('div', { 'class': 'td' }, d.pid ? String(d.pid) : '-'),
				h('div', { 'class': 'td', 'style': 'word-break:break-all;font-family:monospace;font-size:90%' }, d.command)
			]));
		});
		if (!st.daemons.length)
			daemons.appendChild(h('div', { 'class': 'tr placeholder' },
				h('div', { 'class': 'td' }, h('em', _('No zapret2 processes are running')))));

		var lists = h('div', { 'class': 'table' }, [
			h('div', { 'class': 'tr table-titles' }, [
				h('div', { 'class': 'th' }, _('List')),
				h('div', { 'class': 'th' }, _('Entries')),
				h('div', { 'class': 'th' }, _('Size')),
				h('div', { 'class': 'th' }, _('Modified'))
			])
		]);
		st.lists.forEach(function(l) {
			lists.appendChild(h('div', { 'class': 'tr' }, [
				h('div', { 'class': 'td' }, listTitle(l)),
				h('div', { 'class': 'td' }, l.lines == null ? '-' : String(l.lines)),
				h('div', { 'class': 'td' }, l.exists ? fmtSize(l.size) : '-'),
				h('div', { 'class': 'td' }, l.exists ? fmtTime(l.mtime) : '-')
			]));
		});

		var logbox = h('pre', {
			'style': 'max-height:22em;overflow:auto;font-size:85%;white-space:pre-wrap'
		}, (log && log.log) || _('(empty)'));

		var details = h('details', { 'style': 'margin-top:1.2em', 'open': flag(this.detailsOpen) }, [
			h('summary', { 'style': 'cursor:pointer;font-weight:bold' }, icons.label('terminal', _('Details'), 18)),
			h('div', { 'style': 'margin:.6em 0;display:flex;flex-wrap:wrap;gap:.6em;align-items:center' }, [
				h('span', {}, [ _('Firewall'), ': ', st.firewall.backend, ' ',
					st.firewall.active ? badge(_('rules active'), COLOR_OK, 'check-circle') : badge(_('no rules'), COLOR_OFF, 'ban') ]),
				h('button', { 'class': 'cbi-button', 'click': ui.createHandlerFn(this, 'runJob', 'update-lists') },
					[ icons.label('download', _('Update lists now'), 16) ]),
				h('button', { 'class': 'cbi-button', 'click': ui.createHandlerFn(this, 'runJob', 'update-presets') },
					[ icons.label('download', _('Update presets now'), 16) ])
			]),
			h('h4', _('Processes')), daemons,
			h('h4', _('Lists')), lists,
			h('h4', _('System log (zapret2)')), logbox
		]);
		details.addEventListener('toggle', function() { self.detailsOpen = details.open; });

		dom.content(this.container, [ banner, cards, this.updateBox(st), details ]);
		logbox.scrollTop = logbox.scrollHeight;
	},

	render: function(data) {
		this.container = h('div');
		this.detailsOpen = false;
		this.upd = null;
		this.update(data[0], data[1]);

		poll.add(L.bind(this.refresh, this), 5);

		return h('div', {}, [
			h('h2', icons.label('shield-check', _('Zapret2'), 26)),
			h('div', { 'class': 'cbi-map-descr' },
				_('Bypass of DPI-based blocking with nfqws2 and Lua strategies. Pick a strategy on the Presets page.')),
			this.container
		]);
	},

	handleSaveApply: null,
	handleSave: null,
	handleReset: null
});
