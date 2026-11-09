'use strict';
'require view';
'require rpc';
'require ui';
'require poll';

var callJobStart = rpc.declare({
	object: 'luci.zapret',
	method: 'job_start',
	params: [ 'job', 'domains', 'scanlevel', 'ipvs', 'tests' ]
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

var TESTS = [
	[ 'http',  _('HTTP') ],
	[ 'tls12', _('HTTPS (TLS 1.2)') ],
	[ 'tls13', _('HTTPS (TLS 1.3)') ],
	[ 'quic',  _('QUIC (HTTP/3)') ]
];

return view.extend({
	selectedTests: function() {
		return this.testBoxes.filter(function(b) { return b.checked; })
			.map(function(b) { return b.value; }).join(',');
	},

	startTest: function() {
		var tests = this.selectedTests();

		if (!tests) {
			ui.addNotification(null, E('p', _('Select at least one test.')), 'warning');
			return;
		}

		return callJobStart('blockcheck', this.domains.value, this.scanlevel.value,
			this.ipvs.value, tests).then(L.bind(function(res) {
			if (!res || !res.ok)
				ui.addNotification(null, E('p',
					_('Cannot start the test: %s').format((res && res.error) || _('already running?'))), 'danger');
			return this.pollLog();
		}, this));
	},

	stopTest: function() {
		return callJobStop('blockcheck').then(L.bind(this.pollLog, this));
	},

	pollLog: function() {
		return callJobLog('blockcheck').then(L.bind(function(res) {
			var text = (res && res.log) || '';
			var stick = this.logbox.scrollTop + this.logbox.clientHeight >= this.logbox.scrollHeight - 20;

			if (this.logbox.textContent !== text) {
				this.logbox.textContent = text || _('(no output yet)');
				if (stick)
					this.logbox.scrollTop = this.logbox.scrollHeight;
			}

			this.status.textContent = res && res.running ? _('Running...') : _('Idle');
			this.startBtn.disabled = !!(res && res.running);
			this.stopBtn.disabled = !(res && res.running);
		}, this));
	},

	render: function() {
		var self = this;

		this.domains = E('input', {
			'type': 'text', 'class': 'cbi-input-text', 'style': 'width:100%',
			'value': 'rutracker.org', 'placeholder': 'rutracker.org youtube.com'
		});
		this.scanlevel = E('select', { 'class': 'cbi-input-select' }, [
			E('option', { 'value': 'quick' }, _('quick - find something that works, fast')),
			E('option', { 'value': 'standard' }, _('standard - more variants')),
			E('option', { 'value': 'force' }, _('force - everything, even if the site already works'))
		]);
		this.ipvs = E('select', { 'class': 'cbi-input-select' }, [
			E('option', { 'value': '4' }, 'IPv4'),
			E('option', { 'value': '6' }, 'IPv6'),
			E('option', { 'value': '46' }, 'IPv4 + IPv6')
		]);
		this.testBoxes = TESTS.map(function(t) {
			return E('input', { 'type': 'checkbox', 'value': t[0], 'checked': true });
		});

		var testLabels = TESTS.map(function(t, i) {
			return E('label', { 'style': 'margin-right:1.5em;white-space:nowrap' }, [ self.testBoxes[i], ' ', t[1] ]);
		});

		this.startBtn = E('button', {
			'class': 'cbi-button cbi-button-action',
			'click': ui.createHandlerFn(this, 'startTest')
		}, _('Start test'));
		this.stopBtn = E('button', {
			'class': 'cbi-button cbi-button-negative',
			'disabled': true,
			'click': ui.createHandlerFn(this, 'stopTest')
		}, _('Stop'));
		this.status = E('span', { 'style': 'margin-left:1em' }, '');
		this.logbox = E('pre', {
			'style': 'height:32em;overflow:auto;font-size:85%;white-space:pre-wrap'
		}, _('(no output yet)'));

		var field = function(label, widget) {
			return E('div', { 'class': 'cbi-value' }, [
				E('label', { 'class': 'cbi-value-title' }, label),
				E('div', { 'class': 'cbi-value-field' }, widget)
			]);
		};

		var node = E('div', {}, [
			E('h2', _('Zapret: strategy test')),
			E('div', { 'class': 'cbi-map-descr' }, [
				_('Runs blockcheck.sh from zapret: it tries different nfqws/tpws strategies against the chosen domains and reports which of them work with your ISP.'),
				E('br'),
				E('strong', _('While the test is running, the zapret service is stopped (and started again afterwards). The test takes from minutes to over an hour.')),
				E('br'),
				_('When it finishes, look for the SUMMARY section at the end of the log, and copy the working options into Settings → NFQWS (or TPWS).')
			]),
			E('div', { 'class': 'cbi-section' }, [
				field(_('Domains'), this.domains),
				field(_('Scan level'), this.scanlevel),
				field(_('IP version'), this.ipvs),
				field(_('Tests'), testLabels),
				E('div', { 'style': 'margin:1em 0' },
					[ this.startBtn, ' ', this.stopBtn, this.status ])
			]),
			E('h3', _('Output')),
			this.logbox
		]);

		poll.add(L.bind(this.pollLog, this), 2);
		this.pollLog();

		return node;
	},

	handleSaveApply: null,
	handleSave: null,
	handleReset: null
});
