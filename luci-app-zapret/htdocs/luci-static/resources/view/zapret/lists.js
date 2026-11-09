'use strict';
'require view';
'require rpc';
'require ui';
'require poll';
'require dom';

var callGetList = rpc.declare({
	object: 'luci.zapret',
	method: 'get_list',
	params: [ 'name' ]
});

var callSetList = rpc.declare({
	object: 'luci.zapret',
	method: 'set_list',
	params: [ 'name', 'content' ]
});

var callJobStart = rpc.declare({
	object: 'luci.zapret',
	method: 'job_start',
	params: [ 'job' ]
});

var callJobStop = rpc.declare({
	object: 'luci.zapret',
	method: 'job_stop',
	params: [ 'job' ]
});

var callJobLog = rpc.declare({
	object: 'luci.zapret',
	method: 'job_log',
	params: [ 'job' ]
});

var LISTS = [
	{
		id: 'hosts-user',
		title: _('My hostlist'),
		descr: _('Domains zapret should process in the hostlist / autohostlist / ipset modes. One domain per line; subdomains are included. Lines starting with # are comments.')
	},
	{
		id: 'hosts-user-exclude',
		title: _('Exclusions'),
		descr: _('Domains that are never processed, even if they are in other lists (banks, government services, local resources).')
	},
	{
		id: 'hosts-user-ipban',
		title: _('IP ban list'),
		descr: _('Domains whose addresses are put to the "ipban" set, which custom scripts can use. Usually empty.')
	},
	{
		id: 'hosts-auto',
		title: _('Auto hostlist'),
		descr: _('Filled by nfqws/tpws in autohostlist mode with domains where blocking was detected. You can review or clean it here.')
	}
];

return view.extend({
	load: function() {
		return Promise.all(LISTS.map(function(l) { return callGetList(l.id); }));
	},

	saveList: function(id, textarea) {
		return callSetList(id, textarea.value).then(function(res) {
			if (res && res.ok)
				ui.addNotification(null, E('p', _('List saved. Daemons were told to reload it. In ipset mode run "Update lists now" to resolve new domains to addresses.')), 'info');
			else
				ui.addNotification(null, E('p', _('Cannot save the list: %s').format((res && res.error) || '?')), 'danger');
		}).catch(function(err) {
			ui.addNotification(null, E('p', err.message), 'danger');
		});
	},

	startUpdate: function() {
		return callJobStart('update-lists').then(L.bind(function(res) {
			if (!res || !res.ok)
				ui.addNotification(null, E('p', _('Cannot start the list update (already running?)')), 'warning');
			return this.pollLog();
		}, this));
	},

	stopUpdate: function() {
		return callJobStop('update-lists').then(L.bind(this.pollLog, this));
	},

	pollLog: function() {
		return callJobLog('update-lists').then(L.bind(function(res) {
			var text = (res && res.log) || '';

			if (this.jobLog.textContent !== text) {
				this.jobLog.textContent = text || _('(no output yet)');
				this.jobLog.scrollTop = this.jobLog.scrollHeight;
			}

			this.jobStatus.textContent = res && res.running ? _('Running...') : _('Idle');
			this.startBtn.disabled = !!(res && res.running);
			this.stopBtn.disabled = !(res && res.running);
		}, this));
	},

	render: function(data) {
		var self = this;
		var tabs = E('div');

		LISTS.forEach(function(l, i) {
			var info = data[i] || {};
			var textarea = E('textarea', {
				'class': 'cbi-input-textarea',
				'style': 'width:100%;font-family:monospace',
				'rows': 16,
				'wrap': 'off',
				'spellcheck': 'false'
			}, info.ok ? info.content : '');

			tabs.appendChild(E('div', { 'data-tab': l.id, 'data-tab-title': l.title }, [
				E('p', { 'class': 'cbi-section-descr' }, l.descr),
				info.ok ? '' : E('div', { 'class': 'alert-message warning' }, info.error || _('The list cannot be loaded')),
				textarea,
				E('div', { 'style': 'margin:1em 0' }, [
					E('button', {
						'class': 'cbi-button cbi-button-save',
						'click': ui.createHandlerFn(self, 'saveList', l.id, textarea)
					}, _('Save list'))
				])
			]));
		});

		this.jobLog = E('pre', {
			'style': 'max-height:20em;overflow:auto;font-size:85%;white-space:pre-wrap'
		}, _('(no output yet)'));
		this.jobStatus = E('span', { 'style': 'margin-left:1em' }, '');
		this.startBtn = E('button', {
			'class': 'cbi-button cbi-button-action',
			'click': ui.createHandlerFn(this, 'startUpdate')
		}, _('Update lists now'));
		this.stopBtn = E('button', {
			'class': 'cbi-button cbi-button-negative',
			'disabled': true,
			'click': ui.createHandlerFn(this, 'stopUpdate')
		}, _('Stop'));

		var node = E('div', {}, [
			E('h2', _('Zapret: lists')),
			tabs,
			E('h3', _('Download lists')),
			E('p', { 'class': 'cbi-section-descr' },
				_('Runs the list script chosen in Settings → Lists and reloads the daemons when it finishes.')),
			E('div', {}, [ this.startBtn, ' ', this.stopBtn, this.jobStatus ]),
			this.jobLog
		]);

		ui.tabs.initTabGroup(tabs.childNodes);
		poll.add(L.bind(this.pollLog, this), 3);
		this.pollLog();

		return node;
	},

	handleSaveApply: null,
	handleSave: null,
	handleReset: null
});
