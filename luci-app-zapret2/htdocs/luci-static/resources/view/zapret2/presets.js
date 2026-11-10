'use strict';
'require view';
'require rpc';
'require ui';
'require poll';
'require dom';
'require uci';
'require zapret2.icons as icons';

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


var callPresets = rpc.declare({
	object: 'luci.zapret2',
	method: 'presets'
});

var callGetPreset = rpc.declare({
	object: 'luci.zapret2',
	method: 'get_preset',
	params: [ 'id' ]
});

var callSavePreset = rpc.declare({
	object: 'luci.zapret2',
	method: 'save_preset',
	params: [ 'id', 'content' ]
});

var callDeletePreset = rpc.declare({
	object: 'luci.zapret2',
	method: 'delete_preset',
	params: [ 'id' ]
});

var callSetPreset = rpc.declare({
	object: 'luci.zapret2',
	method: 'set_preset',
	params: [ 'id' ]
});

var callJobStart = rpc.declare({
	object: 'luci.zapret2',
	method: 'job_start',
	params: [ 'job' ]
});

var callJobLog = rpc.declare({
	object: 'luci.zapret2',
	method: 'job_log',
	params: [ 'job' ]
});

var ID_RE = /^[a-z0-9][a-z0-9_-]{0,39}$/;

var NEW_PRESET_TEMPLATE =
	'#@name: My preset\n' +
	'#@description: Describe what this strategy is for\n' +
	'#@tcp_ports: 80,443\n' +
	'#@udp_ports: 443\n' +
	'--filter-tcp=80 --filter-l7=http <HOSTLIST> --payload=http_req --lua-desync=multisplit:pos=method+2 --new\n' +
	'--filter-tcp=443 --filter-l7=tls <HOSTLIST> --payload=tls_client_hello --lua-desync=multisplit:pos=1,midsld --new\n' +
	'--filter-udp=443 --filter-l7=quic <HOSTLIST_NOAUTO> --payload=quic_initial --lua-desync=fake:blob=fake_default_quic:repeats=6\n';

/* h() sets any non-null attribute (even "false"), so a boolean attribute must be null when off */
function flag(v) {
	return v ? '' : null;
}

function isRu() {
	return ((document.documentElement.lang || navigator.language || '') + '').toLowerCase().indexOf('ru') === 0;
}

function originLabel(p) {
	switch (p.origin) {
	case 'builtin':    return _('built-in');
	case 'downloaded': return _('downloaded');
	case 'user':       return _('mine');
	}
	return p.origin;
}

function tag(text, color, icon) {
	var chip = icons.chip(icon || 'check', text, color, 14);

	chip.style.marginLeft = '.5em';
	return chip;
}

return view.extend({
	load: function() {
		return Promise.all([ callPresets(), uci.load('zapret2') ]);
	},

	urls: function() {
		var u = uci.get('zapret2', 'main', 'preset_url');
		if (Array.isArray(u))
			return u;
		return u ? [ u ] : [];
	},

	reload: function() {
		return callPresets().then(L.bind(function(res) {
			this.data = res;
			this.renderPresets();
		}, this));
	},

	/* ask before switching to a preset that runs custom Lua code or downloads lists from the Internet */
	confirmActivate: function(p) {
		var missing = (p.lists || []).filter(function(l) { return !l.exists; });

		if (!p.custom_lua && !missing.length)
			return this.activate(p.id);

		var self = this;
		var body = [];

		if (p.custom_lua)
			body.push(h('p', _('The preset "%s" contains custom Lua code that will run inside nfqws2. Activate it only if you trust its source. Activate?').format(p.name)));

		if (missing.length) {
			body.push(h('p', _('The preset "%s" needs these lists. They are added to the Lists page and downloaded now and then every day:').format(p.name)));
			body.push(h('ul', { 'style': 'margin:.3em 0 1em 1.2em' }, missing.map(function(l) {
				return h('li', { 'style': 'margin-bottom:.4em;word-break:break-all' }, [ h('strong', {}, l.title), h('br'), h('code', {}, l.url) ]);
			})));
		}

		ui.showModal(p.custom_lua ? _('Preset with custom Lua code') : _('Preset with lists'), body.concat([
			h('div', { 'class': 'right' }, [
				h('button', { 'class': 'cbi-button', 'click': ui.hideModal }, _('Cancel')),
				' ',
				h('button', {
					'class': 'cbi-button ' + (p.custom_lua ? 'cbi-button-negative' : 'cbi-button-positive'),
					'click': ui.createHandlerFn(this, function() {
						ui.hideModal();
						return self.activate(p.id);
					})
				}, _('Activate'))
			])
		]));
	},

	activate: function(id) {
		return callSetPreset(id).then(L.bind(function(res) {
			if (!res || !res.ok)
				ui.addNotification(null, h('p', _('Cannot activate the preset: %s').format((res && res.error) || '?')), 'danger');
			else {
				ui.addNotification(null, h('p', res.running
					? _('The preset is active, nfqws2 was restarted.')
					: _('The preset is selected. It will be used the next time the service starts.')), 'info');
				if (res.lists_added && res.lists_added.length)
					ui.addNotification(null, h('p', _('Added lists: %s. They are being downloaded, the progress is shown on the Lists page.').format(res.lists_added.join(', '))), 'info');
			}
			return this.reload();
		}, this)).catch(function(err) {
			ui.addNotification(null, h('p', err.message), 'danger');
		});
	},

	/* modal editor: opts = { id, content, isNew, editable, title } */
	openEditor: function(opts) {
		var self = this;
		var idInput = h('input', {
			'type': 'text', 'class': 'cbi-input-text', 'value': opts.id || '',
			'placeholder': 'my-preset', 'style': 'width:20em', 'disabled': flag(!opts.isNew)
		});
		var area = h('textarea', {
			'class': 'cbi-input-textarea', 'rows': 22, 'wrap': 'off', 'spellcheck': 'false',
			'style': 'width:100%;font-family:monospace;font-size:90%',
			'readonly': flag(!opts.editable)
		}, opts.content);

		var buttons = [
			h('button', { 'class': 'cbi-button', 'click': ui.hideModal }, _('Close'))
		];

		if (opts.editable)
			buttons.push(' ', h('button', {
				'class': 'cbi-button cbi-button-positive',
				'click': ui.createHandlerFn(this, function() {
					var id = idInput.value.trim();
					if (!ID_RE.test(id)) {
						ui.addNotification(null, h('p', _('The id may only contain a-z, 0-9, "-" and "_" (up to 40 characters).')), 'warning');
						return;
					}
					return callSavePreset(id, area.value).then(function(res) {
						if (!res || !res.ok) {
							ui.addNotification(null, h('p', _('Cannot save the preset: %s').format((res && res.error) || '?')), 'danger');
							return;
						}
						ui.hideModal();
						return self.reload();
					});
				})
			}, _('Save')));

		ui.showModal(opts.title, [
			h('div', { 'style': 'min-width:min(88vw,56em)' }, [
				h('p', { 'class': 'cbi-section-descr' }, opts.hint || ''),
				h('div', { 'style': 'margin-bottom:.6em' }, [ h('strong', _('Preset id') + ': '), idInput ]),
				area,
				h('div', { 'class': 'right', 'style': 'margin-top:1em' }, buttons)
			])
		]);
	},

	viewPreset: function(p) {
		return callGetPreset(p.id).then(L.bind(function(res) {
			if (!res || !res.ok) {
				ui.addNotification(null, h('p', (res && res.error) || '?'), 'danger');
				return;
			}
			this.openEditor({
				id: p.id,
				content: res.content,
				isNew: false,
				editable: res.editable,
				title: res.editable ? _('Edit preset') : _('Preset (read-only)'),
				hint: res.editable
					? (res.shadows ? _('This preset replaces the %s preset with the same id. Delete it to get the original back.').format(res.shadows) : '')
					: _('Built-in and downloaded presets cannot be edited. Use "Copy" to make your own version.')
			});
		}, this));
	},

	copyPreset: function(p) {
		return callGetPreset(p.id).then(L.bind(function(res) {
			if (!res || !res.ok)
				return;
			var text = res.content
				.replace(/^#@source:.*\n?/mg, '')
				.replace(/^#@name:\s*(.*)$/m, function(m, n) { return '#@name: ' + n + ' (copy)'; });
			var newId = (p.id + '-my').substr(0, 40);
			this.openEditor({
				id: newId, content: text, isNew: true, editable: true,
				title: _('Copy preset'),
				hint: _('Choose an id for your copy and edit the options. It will appear in the list as your own preset.')
			});
		}, this));
	},

	newPreset: function() {
		this.openEditor({
			id: '', content: NEW_PRESET_TEMPLATE, isNew: true, editable: true,
			title: _('New preset'),
			hint: _('Lines starting with #@ are the preset description; the rest are nfqws2 options.')
		});
	},

	deletePreset: function(p) {
		var self = this;
		ui.showModal(_('Delete preset'), [
			h('p', _('Delete your preset "%s"?').format(p.name)),
			h('div', { 'class': 'right' }, [
				h('button', { 'class': 'cbi-button', 'click': ui.hideModal }, _('Cancel')),
				' ',
				h('button', {
					'class': 'cbi-button cbi-button-negative',
					'click': ui.createHandlerFn(this, function() {
						return callDeletePreset(p.id).then(function(res) {
							ui.hideModal();
							if (!res || !res.ok)
								ui.addNotification(null, h('p', (res && res.error) || '?'), 'danger');
							return self.reload();
						});
					})
				}, _('Delete'))
			])
		]);
	},

	/* ---- download of preset bundles ---- */

	downloadPresets: function() {
		return callJobStart('update-presets').then(L.bind(function(res) {
			if (!res || !res.ok) {
				ui.addNotification(null, h('p', _('Cannot start the download (already running?)')), 'warning');
				return;
			}
			this.watchJob();
		}, this));
	},

	watchJob: function() {
		var self = this;
		if (this.jobPoll)
			return;

		this.jobPoll = function() {
			return callJobLog('update-presets').then(function(res) {
				var text = (res && res.log) || '';
				self.jobLog.style.display = text ? '' : 'none';
				self.jobLog.textContent = text;
				self.jobLog.scrollTop = self.jobLog.scrollHeight;

				if (res && !res.running) {
					poll.remove(self.jobPoll);
					self.jobPoll = null;
					return self.reload();
				}
			});
		};
		poll.add(this.jobPoll, 2);
		this.jobPoll();
	},

	/* ---- list of presets ---- */

	renderPresets: function() {
		var self = this;
		var ru = isRu();
		var items = [];

		this.data.presets.forEach(function(p) {
			var descr = (ru && p.description_ru) ? p.description_ru : p.description;
			var ports = [];
			if (p.tcp_ports) ports.push('TCP ' + p.tcp_ports);
			if (p.udp_ports) ports.push('UDP ' + p.udp_ports);

			var actions = [];
			if (!p.active)
				actions.push(h('button', {
					'class': 'cbi-button cbi-button-positive',
					'click': ui.createHandlerFn(self, 'confirmActivate', p)
				}, [ icons.label('check-circle', _('Use'), 16) ]), ' ');
			actions.push(h('button', {
				'class': 'cbi-button',
				'click': ui.createHandlerFn(self, 'viewPreset', p)
			}, [ p.origin === 'user' ? icons.label('edit', _('Edit'), 16) : icons.label('eye', _('View'), 16) ]), ' ');
			actions.push(h('button', {
				'class': 'cbi-button',
				'click': ui.createHandlerFn(self, 'copyPreset', p)
			}, [ icons.label('copy', _('Copy'), 16) ]));
			if (p.origin === 'user')
				actions.push(' ', h('button', {
					'class': 'cbi-button cbi-button-negative',
					'click': ui.createHandlerFn(self, 'deletePreset', p)
				}, [ p.shadows ? icons.label('refresh', _('Restore original'), 16) : icons.label('trash', _('Delete'), 16) ]));

			items.push(h('div', {
				'class': 'cbi-section',
				'style': 'margin-bottom:.8em;padding:.6em 1em;border-radius:4px;border:2px solid ' + (p.active ? '#2e7d32' : 'rgba(128,128,128,.35)')
			}, [
				h('div', { 'style': 'display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:.5em' }, [
					h('div', {}, [
						h('strong', { 'style': 'font-size:115%' }, p.name),
						' ',
						h('code', {}, p.id),
						p.active ? tag(_('active'), icons.colors.ok, 'check-circle') : '',
						p.custom_lua ? tag(_('custom Lua'), icons.colors.bad, 'alert') : '',
						tag(originLabel(p), p.origin === 'user' ? icons.colors.info : p.origin === 'downloaded' ? icons.colors.lua : icons.colors.off,
							p.origin === 'user' ? 'edit' : p.origin === 'downloaded' ? 'download' : 'file')
					]),
					h('div', {}, actions)
				]),
				descr ? h('div', { 'style': 'margin-top:.3em' }, descr) : '',
				ports.length ? h('div', { 'style': 'margin-top:.2em;opacity:.7;font-size:90%' }, ports.join(', ')) : '',
				(p.lists && p.lists.length) ? h('div', { 'style': 'margin-top:.2em;opacity:.7;font-size:90%' },
					_('Lists: %s').format(p.lists.map(function(l) { return l.title; }).join(', '))) : '',
				p.source ? h('div', { 'style': 'margin-top:.2em;opacity:.7;font-size:85%;word-break:break-all' }, _('Source: %s').format(p.source)) : ''
			]));
		});

		dom.content(this.listBox, items);
	},

	render: function(data) {
		var urls;

		this.data = data[0];
		this.listBox = h('div');
		this.jobLog = h('pre', {
			'style': 'display:none;max-height:12em;overflow:auto;font-size:85%;white-space:pre-wrap'
		});
		urls = this.urls();

		var dlInfo = urls.length
			? h('div', {}, [ _('Sources:'), ' ' ].concat(urls.map(function(u) { return h('code', { 'style': 'margin-right:.7em;word-break:break-all' }, u); })))
			: h('em', {}, [ _('No download source is configured. Add a preset URL in'), ' ',
				h('a', { 'href': L.url('admin', 'services', 'zapret2', 'settings') }, _('Settings')), ' → ', _('Presets'), '.' ]);

		var node = h('div', {}, [
			h('h2', icons.label('sliders', _('Zapret2: presets'), 26)),
			h('div', { 'class': 'cbi-map-descr' }, [
				_('A preset is a ready-made set of nfqws2 options (a strategy). Switch between them to find what works with your ISP, or make your own.'),
				' ',
				_('The active preset is applied immediately; if the service is running, nfqws2 is restarted.')
			]),
			h('div', { 'style': 'margin:1em 0' }, [
				h('button', { 'class': 'cbi-button cbi-button-add', 'click': ui.createHandlerFn(this, 'newPreset') }, [ icons.label('plus', _('New preset'), 16) ]),
				' ',
				h('button', {
					'class': 'cbi-button cbi-button-action',
					'disabled': flag(!urls.length),
					'click': ui.createHandlerFn(this, 'downloadPresets')
				}, [ icons.label('download', _('Download presets'), 16) ])
			]),
			h('div', { 'style': 'margin-bottom:1em' }, dlInfo),
			h('div', { 'class': 'cbi-section-descr', 'style': 'margin-bottom:1em' },
				_('A preset can contain Lua code that runs inside nfqws2. Download presets only from sources you trust, preferably over https.')),
			this.jobLog,
			this.listBox,
			h('details', { 'style': 'margin-top:1.5em' }, [
				h('summary', { 'style': 'cursor:pointer;font-weight:bold' }, [ icons.label('file', _('Preset file format'), 18) ]),
				h('div', { 'class': 'cbi-section-descr', 'style': 'margin-top:.5em' }, [
					h('p', _('A preset is a text file. Header lines have the form "#@key: value": name, description, description.ru, tcp_ports, udp_ports (ports redirected to nfqws2), and optionally tcp_pkt_out, tcp_pkt_in, udp_pkt_out, udp_pkt_in.')),
					h('p', _('All other lines (except comments starting with #) are nfqws2 options. Placeholders: <HOSTLIST> and <HOSTLIST_NOAUTO> (replaced according to the filter mode), <LIST:name> (path of your list "name", see the Lists page), <BASE> (zapret2 files, e.g. <BASE>/files/fake/stun.bin). An option cannot contain spaces: put Lua code into a file and pass it as --lua-init=@<RW>/lua/file.lua (<RW> is /etc/zapret2).')),
					h('p', _('A line "#@list: id hosts|ips URL title" declares a list that the preset needs: it is added on the Lists page and downloaded when the preset is activated, and then every day.')),
					h('p', _('A download source is a text file with presets one after another, each starting with a line "#@id: some-id"; a file without such lines is treated as a single preset named after the file.'))
				])
			])
		]);

		this.renderPresets();
		return node;
	},

	handleSaveApply: null,
	handleSave: null,
	handleReset: null
});
