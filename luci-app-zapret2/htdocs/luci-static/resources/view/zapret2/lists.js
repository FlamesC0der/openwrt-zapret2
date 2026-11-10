'use strict';
'require view';
'require rpc';
'require ui';
'require poll';
'require dom';
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


var callLists = rpc.declare({
	object: 'luci.zapret2',
	method: 'lists'
});

var callGetList = rpc.declare({
	object: 'luci.zapret2',
	method: 'get_list',
	params: [ 'id' ]
});

var callViewList = rpc.declare({
	object: 'luci.zapret2',
	method: 'view_list',
	params: [ 'id', 'offset', 'limit', 'filter' ]
});

var callSetList = rpc.declare({
	object: 'luci.zapret2',
	method: 'set_list',
	params: [ 'id', 'content' ]
});

var callSaveList = rpc.declare({
	object: 'luci.zapret2',
	method: 'save_list',
	params: [ 'id', 'title', 'url', 'kind' ]
});

var callDeleteList = rpc.declare({
	object: 'luci.zapret2',
	method: 'delete_list',
	params: [ 'id' ]
});

var callJobStart = rpc.declare({
	object: 'luci.zapret2',
	method: 'job_start',
	params: [ 'job' ]
});

var callJobStop = rpc.declare({
	object: 'luci.zapret2',
	method: 'job_stop',
	params: [ 'job' ]
});

var callJobLog = rpc.declare({
	object: 'luci.zapret2',
	method: 'job_log',
	params: [ 'job' ]
});

var callSetMode = rpc.declare({
	object: 'luci.zapret2',
	method: 'set_mode',
	params: [ 'mode' ]
});

var PAGE = 100;

/* what goes through zapret: the four filter modes, in plain words */
var MODES = [
	{ id: 'none',         icon: 'globe',   title: _('Everything'),
	  descr: _('All traffic goes through zapret, except the sites in the bypass list.') },
	{ id: 'hostlist',     icon: 'list',    title: _('Only my list'),
	  descr: _('Only the sites from the "Through zapret" list (and downloaded lists) go through zapret. Everything else is left alone.') },
	{ id: 'autohostlist', icon: 'zap',     title: _('My list + auto-detect'),
	  descr: _('Like "Only my list", plus sites where blocking was detected automatically.') },
	{ id: 'ipset',        icon: 'network', title: _('By IP address'),
	  descr: _('Match by the IP addresses of the lists (resolved by "Update lists now").') }
];
var ID_RE = /^[a-z0-9][a-z0-9_]{0,39}$/;   /* list ids are UCI section names: no dashes */

/* h() sets any non-null attribute (even "false"), so a boolean attribute must be null when off */
function flag(v) {
	return v ? '' : null;
}

/* "https://WWW.Example.com:443/path?x" -> "www.example.com"; IP addresses and CIDR pass through */
function normalizeHost(raw) {
	var v = String(raw || '').trim().toLowerCase();

	if (/^[0-9a-f:.]+(\/[0-9]{1,3})?$/.test(v) && /[.:]/.test(v))
		return v;

	v = v.replace(/^[a-z][a-z0-9+.-]*:\/\//, '').replace(/[\/?#].*$/, '').replace(/:[0-9]+$/, '').replace(/^\.+|\.+$/g, '');

	return /^[a-z0-9]([a-z0-9._-]*[a-z0-9])?$/.test(v) ? v : '';
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

function listHint(l) {
	switch (l.id) {
	case 'user':       return _('Domains zapret2 should process in the hostlist / autohostlist / ipset modes. One domain per line; subdomains are included. Lines starting with # are comments.');
	case 'exclude':    return _('Domains that are never processed, even if they are in other lists (banks, government services, local resources).');
	case 'ipban':      return _('Domains whose addresses are put to the "ipban" set, which custom scripts can use. Usually empty.');
	case 'auto':       return _('Filled by nfqws2 in autohostlist mode with domains where blocking was detected. You can review or clean it here.');
	case 'downloaded': return _('Produced by the list script chosen in Settings → Lists. It is replaced on every update, so it is read-only.');
	}
	return l.url
		? _('A downloaded list. Your manual changes are overwritten by the next download; remove the URL to keep a list local.')
		: _('Your own list. Use it in presets as <LIST:%s>.').format(l.id);
}

/* an empty include list means "everything" for nfqws2, so the backend keeps a placeholder entry in it */
function hidePlaceholder(text) {
	return String(text || '').split('\n').filter(function(l) { return l.trim() !== 'nonexistent.domain'; }).join('\n');
}

return view.extend({
	load: function() {
		return Promise.all([ callLists(), callGetList('user'), callGetList('exclude') ]);
	},

	/* ---- table of lists ---- */

	reloadLists: function() {
		return callLists().then(L.bind(function(res) {
			this.lists = res.lists || [];
			this.mode = res.mode || 'none';
			this.renderTable();
			this.renderMode();
			this.updateQuickNotes();
		}, this));
	},

	findList: function(id) {
		return this.lists.filter(function(l) { return l.id === id; })[0];
	},

	renderTable: function() {
		var self = this;
		var table = h('div', { 'class': 'table' }, [
			h('div', { 'class': 'tr table-titles' }, [
				h('div', { 'class': 'th' }, _('List')),
				h('div', { 'class': 'th' }, _('Type')),
				h('div', { 'class': 'th' }, _('Entries')),
				h('div', { 'class': 'th' }, _('Size')),
				h('div', { 'class': 'th' }, _('Modified')),
				h('div', { 'class': 'th' }, '')
			])
		]);

		this.lists.forEach(function(l) {
			if (l.id === 'user' || l.id === 'exclude')
				return;

			var actions = [
				h('button', {
					'class': 'cbi-button cbi-button-action',
					'click': ui.createHandlerFn(self, 'openList', l.id)
				}, [ icons.label('eye', _('Open'), 16) ])
			];
			if (!l.builtin)
				actions.push(' ',
					h('button', { 'class': 'cbi-button', 'click': ui.createHandlerFn(self, 'editDefinition', l.id) }, [ icons.label('sliders', _('Settings'), 16) ]),
					' ',
					h('button', { 'class': 'cbi-button cbi-button-negative', 'click': ui.createHandlerFn(self, 'deleteList', l.id) }, [ icons.label('trash', _('Delete'), 16) ]));

			table.appendChild(h('div', { 'class': 'tr' }, [
				h('div', { 'class': 'td' }, [
					h('strong', {}, listTitle(l)),
					l.builtin ? '' : h('div', { 'style': 'opacity:.7;font-size:85%' }, [ h('code', {}, l.id), l.url ? ' · ' : '', l.url ? h('span', { 'title': l.url }, l.url.replace(/^https?:\/\//, '').substr(0, 48)) : '' ])
				]),
				h('div', { 'class': 'td' }, l.kind === 'ips' ? _('IP addresses') : _('domains')),
				h('div', { 'class': 'td' }, l.lines == null ? '-' : String(l.lines)),
				h('div', { 'class': 'td' }, l.exists ? fmtSize(l.size) : '-'),
				h('div', { 'class': 'td' }, l.exists ? fmtTime(l.mtime) : '-'),
				h('div', { 'class': 'td right' }, actions)
			]));
		});

		dom.content(this.tableBox, table);
	},

	/* ---- what goes through zapret ---- */

	setMode: function(id) {
		return callSetMode(id).then(L.bind(function(res) {
			if (!res || !res.ok) {
				ui.addNotification(null, h('p', _('Cannot change the mode: %s').format((res && res.error) || '?')), 'danger');
				return;
			}
			this.mode = id;
			this.renderMode();
			this.updateQuickNotes();
			ui.addNotification(null, h('p', res.running
				? _('The mode was changed, nfqws2 was restarted.')
				: _('The mode was changed. It will be used the next time the service starts.')), 'info');
		}, this));
	},

	renderMode: function() {
		var self = this;
		var blue = icons.colors.info;
		var cards = MODES.map(function(m) {
			var active = (m.id === self.mode);
			return h('button', {
				'type': 'button',
				'class': 'cbi-button',
				'style': 'text-align:left;white-space:normal;word-break:normal;overflow-wrap:break-word;height:auto;padding:.7em .9em;border-radius:8px;border:2px solid ' +
					(active ? blue : 'rgba(128,128,128,.35)') + ';background:' + (active ? blue + '1a' : 'transparent') +
					';display:flex;gap:.8em;align-items:flex-start',
				'click': ui.createHandlerFn(self, 'setMode', m.id)
			}, [
				h('div', { 'style': 'color:' + (active ? blue : 'inherit') + ';opacity:' + (active ? '1' : '.65') + ';padding-top:.1em' }, [ icons.icon(m.icon, 28) ]),
				h('div', { 'style': 'flex:1' }, [
					h('div', { 'style': 'font-weight:bold' }, [ m.title ]),
					h('div', { 'style': 'opacity:.75;font-size:90%;margin-top:.2em' }, [ m.descr ])
				]),
				active ? h('div', { 'style': 'color:' + blue }, [ icons.icon('check-circle', 22) ]) : ''
			]);
		});

		dom.content(this.modeBox, [
			h('h3', [ icons.label('globe', _('What goes through zapret?'), 22) ]),
			h('div', { 'style': 'display:grid;grid-template-columns:repeat(auto-fit,minmax(15em,1fr));gap:.7em' }, cards)
		]);
	},

	/* ---- the two main lists, side by side ---- */

	/* the note under the title of the "through zapret" card depends on the mode */
	userNote: function() {
		if (this.mode === 'none')
			return _('Not used right now: in the "Everything" mode all traffic is processed anyway. Choose "Only my list" above to use this list.');
		if (this.mode === 'ipset')
			return _('Run "Update lists now" after changes: the domains are resolved to IP addresses.');
		return '';
	},

	updateQuickNotes: function() {
		if (!this.cards)
			return;
		this.cards.user.setNote(this.userNote());
		/* in the IP mode the bypass list is resolved to addresses, too */
		this.cards.exclude.setNote(this.mode === 'ipset'
			? _('Run "Update lists now" after changes: the domains are resolved to IP addresses.') : '');
	},

	/* The cards are built once and updated in place: re-rendering them would drop unsaved edits. */
	renderQuick: function() {
		this.cards = {
			user: this.quickCard('user', {
				title: _('Through zapret'),
				icon: 'shield-check',
				color: icons.colors.ok,
				text: _('Sites that should go through zapret.')
			}),
			exclude: this.quickCard('exclude', {
				title: _('Bypass zapret'),
				icon: 'ban',
				color: icons.colors.bad,
				text: _('Sites that never go through zapret, in any mode. IP addresses and subnets (10.0.0.0/8) work too.')
			})
		};

		dom.content(this.quickBox, [
			h('div', { 'style': 'display:grid;grid-template-columns:repeat(auto-fit,minmax(22em,1fr));gap:1em;align-items:start' },
				[ this.cards.user.node, this.cards.exclude.node ])
		]);
		this.updateQuickNotes();
	},

	quickCard: function(id, o) {
		var self = this;
		var st = this.quick[id] || {};
		var area = h('textarea', {
			'class': 'cbi-input-textarea', 'rows': 10, 'wrap': 'off', 'spellcheck': 'false',
			'style': 'width:100%;font-family:monospace;font-size:90%;box-sizing:border-box',
			'disabled': flag(!st.ok)
		}, st.ok ? hidePlaceholder(st.content) : '');
		var count = h('span', { 'style': 'opacity:.7' }, '');
		var addInput = h('input', {
			'type': 'text', 'class': 'cbi-input-text', 'style': 'flex:1;min-width:8em',
			'placeholder': _('Add a site, e.g. example.com'), 'disabled': flag(!st.ok)
		});

		var updateCount = function() {
			var n = area.value.split('\n').filter(function(l) { l = l.trim(); return l && l.charAt(0) !== '#'; }).length;
			count.textContent = _('%d entries').format(n);
		};
		area.addEventListener('input', updateCount);
		updateCount();

		var save = function() {
			return callSetList(id, area.value).then(function(r) {
				if (r && r.ok) {
					ui.addNotification(null, h('p', _('List saved. nfqws2 was told to reload it.')), 'info');
					return self.reloadLists();   /* only the tables below; the cards keep their text */
				}
				ui.addNotification(null, h('p', _('Cannot save the list: %s').format((r && r.error) || '?')), 'danger');
			});
		};

		var add = function() {
			var host = normalizeHost(addInput.value);
			if (!host) {
				ui.addNotification(null, h('p', _('This does not look like a domain name or an IP address.')), 'warning');
				return;
			}
			var lines = area.value.split('\n').map(function(l) { return l.replace(/\r$/, ''); });
			if (lines.some(function(l) { return l.trim().toLowerCase() === host; })) {
				ui.addNotification(null, h('p', _('"%s" is already in the list.').format(host)), 'info');
				return;
			}
			/* upstream puts a placeholder into an empty "my list": drop it when the first real entry arrives */
			lines = lines.filter(function(l) { return l.trim() !== 'nonexistent.domain'; });
			while (lines.length && lines[lines.length - 1].trim() === '')
				lines.pop();
			lines.push(host);
			area.value = lines.join('\n') + '\n';
			addInput.value = '';
			updateCount();
			return save();
		};
		addInput.addEventListener('keydown', function(ev) { if (ev.key === 'Enter') { ev.preventDefault(); add(); } });

		var noteBox = h('div');
		var node = h('div', {
			'style': 'border-radius:6px;padding:.8em 1em;border:2px solid ' + o.color + ';background:' +
				(o.color === '#2e7d32' ? 'rgba(46,125,50,.06)' : 'rgba(198,40,40,.06)')
		}, [
			h('div', { 'style': 'display:flex;justify-content:space-between;align-items:baseline;gap:.5em;flex-wrap:wrap' }, [
				h('strong', { 'style': 'font-size:120%;color:' + o.color + ';display:inline-flex;align-items:center;gap:.4em' }, [ icons.icon(o.icon, 24), o.title ]), count
			]),
			h('div', { 'style': 'margin:.3em 0 .6em' }, [ o.text ]),
			noteBox,
			st.ok ? '' : h('div', { 'class': 'alert-message warning' }, [
				st.error === 'too_large' ? _('The list is too large to edit here. Use the viewer below.') : _('The list cannot be loaded')
			]),
			h('div', { 'style': 'display:flex;gap:.4em;margin-bottom:.5em' }, [
				addInput,
				h('button', { 'class': 'cbi-button cbi-button-add', 'disabled': flag(!st.ok), 'click': ui.createHandlerFn(this, add) }, [ icons.label('plus', _('Add'), 16) ])
			]),
			area,
			h('div', { 'style': 'margin-top:.6em' }, [
				h('button', { 'class': 'cbi-button cbi-button-save', 'disabled': flag(!st.ok), 'click': ui.createHandlerFn(this, save) }, [ icons.label('check', _('Save list'), 16) ])
			])
		]);

		return {
			node: node,
			setNote: function(text) {
				dom.content(noteBox, text ? [ h('div', { 'class': 'alert-message warning', 'style': 'margin:.4em 0' }, [ text ]) ] : []);
			}
		};
	},

	/* ---- custom list definition ---- */

	editDefinition: function(id) {
		var l = id ? this.findList(id) : null;
		var self = this;
		var idInput = h('input', { 'type': 'text', 'class': 'cbi-input-text', 'style': 'width:20em',
			'value': l ? l.id : '', 'placeholder': 'general', 'disabled': flag(!!l) });
		var titleInput = h('input', { 'type': 'text', 'class': 'cbi-input-text', 'style': 'width:100%',
			'value': l ? (l.title || '') : '', 'placeholder': _('Display name (optional)') });
		var urlInput = h('input', { 'type': 'text', 'class': 'cbi-input-text', 'style': 'width:100%',
			'value': l ? (l.url || '') : '', 'placeholder': 'https://example.com/list.txt' });
		var kind = h('select', { 'class': 'cbi-input-select' }, [
			h('option', { 'value': 'hosts', 'selected': flag(!l || l.kind !== 'ips') }, _('domains (hostlist)')),
			h('option', { 'value': 'ips', 'selected': flag(l && l.kind === 'ips') }, _('IP addresses / subnets (ipset)'))
		]);

		var field = function(label, widget) {
			return h('div', { 'style': 'margin-bottom:.7em' }, [ h('div', {}, h('strong', {}, label)), widget ]);
		};

		ui.showModal(l ? _('List settings') : _('Add list'), [
			h('div', { 'style': 'min-width:min(88vw,40em)' }, [
				h('p', { 'class': 'cbi-section-descr' },
					_('The list is stored in /etc/zapret2/lists/<id>.txt and is used in presets as <LIST:id>. If a URL is given, it is downloaded by "Update lists" and by the daily update.')),
				field(_('Id'), idInput),
				field(_('Title'), titleInput),
				field(_('Type'), kind),
				field(_('Download URL'), urlInput),
				h('div', { 'class': 'right' }, [
					h('button', { 'class': 'cbi-button', 'click': ui.hideModal }, _('Cancel')),
					' ',
					h('button', {
						'class': 'cbi-button cbi-button-positive',
						'click': ui.createHandlerFn(this, function() {
							var newId = idInput.value.trim();
							if (!ID_RE.test(newId)) {
								ui.addNotification(null, h('p', _('The id may only contain a-z, 0-9 and "_" (up to 40 characters).')), 'warning');
								return;
							}
							return callSaveList(newId, titleInput.value, urlInput.value.trim(), kind.value).then(function(res) {
								if (!res || !res.ok) {
									ui.addNotification(null, h('p', _('Cannot save the list: %s').format((res && res.error) || '?')), 'danger');
									return;
								}
								ui.hideModal();
								return self.reloadLists();
							});
						})
					}, _('Save'))
				])
			])
		]);
	},

	deleteList: function(id) {
		var self = this;
		var l = this.findList(id);
		ui.showModal(_('Delete list'), [
			h('p', _('Delete the list "%s" and its file? Presets that use <LIST:%s> will get an empty list.').format(listTitle(l), id)),
			h('div', { 'class': 'right' }, [
				h('button', { 'class': 'cbi-button', 'click': ui.hideModal }, _('Cancel')),
				' ',
				h('button', {
					'class': 'cbi-button cbi-button-negative',
					'click': ui.createHandlerFn(this, function() {
						return callDeleteList(id).then(function(res) {
							ui.hideModal();
							if (!res || !res.ok)
								ui.addNotification(null, h('p', (res && res.error) || '?'), 'danger');
							if (self.cur && self.cur.id === id) {
								self.cur = null;
								dom.content(self.detailBox, '');
							}
							return self.reloadLists();
						});
					})
				}, _('Delete'))
			])
		]);
	},

	/* ---- viewer / editor of one list ---- */

	openList: function(id) {
		this.cur = { id: id, offset: 0, filter: '' };
		this.renderViewer();
		return this.loadView();
	},

	renderViewer: function() {
		var self = this;
		var l = this.findList(this.cur.id);
		var filterInput = h('input', {
			'type': 'search', 'class': 'cbi-input-text', 'style': 'width:20em',
			'placeholder': _('Search...'), 'value': this.cur.filter
		});
		var doSearch = function() {
			self.cur.filter = filterInput.value;
			self.cur.offset = 0;
			return self.loadView();
		};
		filterInput.addEventListener('keydown', function(ev) { if (ev.key === 'Enter') doSearch(); });

		this.viewInfo = h('span', { 'style': 'margin:0 1em' }, '');
		this.viewPre = h('pre', {
			'style': 'max-height:30em;overflow:auto;font-size:85%;margin:.5em 0'
		}, '');
		this.prevBtn = h('button', { 'class': 'cbi-button', 'click': ui.createHandlerFn(this, 'page', -1) }, [ icons.icon('chevron', 16) ]);
		this.prevBtn.firstChild.style.transform = 'rotate(180deg)';
		this.nextBtn = h('button', { 'class': 'cbi-button', 'click': ui.createHandlerFn(this, 'page', 1) }, [ icons.icon('chevron', 16) ]);

		var buttons = [ filterInput, ' ',
			h('button', { 'class': 'cbi-button', 'click': ui.createHandlerFn(this, doSearch) }, [ icons.label('search', _('Search'), 16) ]), ' ',
			this.prevBtn, this.viewInfo, this.nextBtn ];

		if (l && l.can_edit)
			buttons.push(' ', h('button', {
				'class': 'cbi-button cbi-button-action', 'style': 'margin-left:1em',
				'click': ui.createHandlerFn(this, 'editContent')
			}, [ icons.label('edit', _('Edit'), 16) ]));

		dom.content(this.detailBox, [
			h('h3', {}, listTitle(l || { id: this.cur.id })),
			h('p', { 'class': 'cbi-section-descr' }, listHint(l || { id: this.cur.id })),
			h('div', {}, buttons),
			this.viewPre
		]);
	},

	loadView: function() {
		var self = this;
		var cur = this.cur;
		return callViewList(cur.id, cur.offset, PAGE, cur.filter).then(function(res) {
			if (self.cur !== cur)
				return;
			if (!res || !res.ok) {
				self.viewPre.textContent = (res && res.error) || '?';
				return;
			}
			self.viewPre.textContent = res.lines.length ? res.lines.join('\n') : _('(no matching lines)');
			var from = res.matched ? cur.offset + 1 : 0;
			var to = cur.offset + res.lines.length;
			self.viewInfo.textContent = cur.filter
				? _('%d-%d of %d matches (%d lines total)').format(from, to, res.matched, res.total)
				: _('%d-%d of %d').format(from, to, res.total);
			cur.matched = res.matched;
			self.prevBtn.disabled = cur.offset <= 0;
			self.nextBtn.disabled = to >= res.matched;
		});
	},

	page: function(dir) {
		var next = this.cur.offset + dir * PAGE;
		if (next < 0)
			next = 0;
		this.cur.offset = next;
		return this.loadView();
	},

	editContent: function() {
		var self = this;
		var id = this.cur.id;
		return callGetList(id).then(function(res) {
			if (!res || !res.ok) {
				ui.addNotification(null, h('p', res && res.error === 'too_large'
					? _('The list is too large to edit in the browser (%s). You can still view and search it.').format(fmtSize(res.size))
					: _('Cannot load the list: %s').format((res && res.error) || '?')), 'warning');
				return;
			}

			var area = h('textarea', {
				'class': 'cbi-input-textarea', 'rows': 24, 'wrap': 'off', 'spellcheck': 'false',
				'style': 'width:100%;font-family:monospace'
			}, res.content);

			dom.content(self.detailBox, [
				h('h3', {}, listTitle(self.findList(id) || { id: id })),
				h('p', { 'class': 'cbi-section-descr' }, listHint(self.findList(id) || { id: id })),
				area,
				h('div', { 'style': 'margin:1em 0' }, [
					h('button', {
						'class': 'cbi-button cbi-button-positive',
						'click': ui.createHandlerFn(self, function() {
							return callSetList(id, area.value).then(function(r) {
								if (r && r.ok) {
									ui.addNotification(null, h('p', _('List saved. nfqws2 was told to reload it. In ipset mode run "Update lists now" to resolve new domains to addresses.')), 'info');
									return self.reloadLists().then(function() { return self.openList(id); });
								}
								ui.addNotification(null, h('p', _('Cannot save the list: %s').format((r && r.error) || '?')), 'danger');
							});
						})
					}, _('Save list')),
					' ',
					h('button', { 'class': 'cbi-button', 'click': ui.createHandlerFn(self, 'openList', id) }, _('Cancel'))
				])
			]);
		});
	},

	/* ---- download job ---- */

	startUpdate: function() {
		return callJobStart('update-lists').then(L.bind(function(res) {
			if (!res || !res.ok)
				ui.addNotification(null, h('p', _('Cannot start the list update (already running?)')), 'warning');
			return this.pollLog();
		}, this));
	},

	stopUpdate: function() {
		return callJobStop('update-lists').then(L.bind(this.pollLog, this));
	},

	pollLog: function() {
		return callJobLog('update-lists').then(L.bind(function(res) {
			var text = (res && res.log) || '';
			var running = !!(res && res.running);

			if (this.jobLog.textContent !== text) {
				this.jobLog.textContent = text || _('(no output yet)');
				this.jobLog.scrollTop = this.jobLog.scrollHeight;
			}

			this.jobStatus.textContent = running ? _('Running...') : _('Idle');
			this.startBtn.disabled = running;
			this.stopBtn.disabled = !running;

			/* the job just finished: refresh sizes and the open list */
			if (this.wasRunning && !running) {
				this.reloadLists();
				if (this.cur)
					this.loadView();
			}
			this.wasRunning = running;
		}, this));
	},

	render: function(data) {
		this.lists = (data[0] && data[0].lists) || [];
		this.mode = (data[0] && data[0].mode) || 'none';
		this.quick = { user: data[1] || {}, exclude: data[2] || {} };
		this.cur = null;
		this.wasRunning = false;

		this.modeBox = h('div');
		this.quickBox = h('div', { 'style': 'margin-top:1.2em' });
		this.tableBox = h('div');
		this.detailBox = h('div', { 'style': 'margin-top:1.5em' });

		this.jobLog = h('pre', {
			'style': 'max-height:16em;overflow:auto;font-size:85%;white-space:pre-wrap'
		}, _('(no output yet)'));
		this.jobStatus = h('span', { 'style': 'margin-left:1em' }, '');
		this.startBtn = h('button', {
			'class': 'cbi-button cbi-button-action',
			'click': ui.createHandlerFn(this, 'startUpdate')
		}, [ icons.label('refresh', _('Update lists now'), 16) ]);
		this.stopBtn = h('button', {
			'class': 'cbi-button cbi-button-negative',
			'disabled': '',
			'click': ui.createHandlerFn(this, 'stopUpdate')
		}, [ icons.label('stop', _('Stop'), 16) ]);

		var node = h('div', {}, [
			h('h2', icons.label('list', _('Zapret2: lists'), 26)),
			h('div', { 'class': 'cbi-map-descr' },
				_('Choose what goes through zapret and what bypasses it. Changes apply immediately.')),
			this.modeBox,
			this.quickBox,
			h('h3', { 'style': 'margin-top:1.8em' }, [ icons.label('file', _('Other lists'), 22) ]),
			h('div', { 'class': 'cbi-section-descr' },
				_('Downloaded and your own lists. Open a list to view, search and (when it is small enough) edit it. Your own lists can be downloaded from a URL.')),
			h('div', { 'style': 'margin:1em 0' }, [
				h('button', { 'class': 'cbi-button cbi-button-add', 'click': ui.createHandlerFn(this, 'editDefinition', null) }, [ icons.label('plus', _('Add list'), 16) ]),
				' ', this.startBtn, ' ', this.stopBtn, this.jobStatus
			]),
			this.tableBox,
			this.detailBox,
			h('h3', [ icons.label('terminal', _('Update log'), 22) ]),
			this.jobLog
		]);

		this.renderMode();
		this.renderQuick();
		this.renderTable();
		poll.add(L.bind(this.pollLog, this), 3);
		this.pollLog();

		return node;
	},

	handleSaveApply: null,
	handleSave: null,
	handleReset: null
});
