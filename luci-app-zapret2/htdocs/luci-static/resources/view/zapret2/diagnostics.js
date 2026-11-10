'use strict';
'require view';
'require rpc';
'require ui';
'require poll';
'require dom';
'require zapret2.icons as icons';

var callDiagResults = rpc.declare({
	object: 'luci.zapret2',
	method: 'diag_results'
});

var callJobStart = rpc.declare({
	object: 'luci.zapret2',
	method: 'job_start',
	params: [ 'job', 'host', 'timeout', 'compare' ]
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

var CHECKER_URL = 'https://hyperion-cs.github.io/dpi-checkers/ru/tcp-16-20/';
var DISCUSSION_URL = 'https://github.com/net4people/bbs/issues/490';
var REPO_URL = 'https://github.com/hyperion-cs/dpi-checkers';

/*
 * E() inserts a lone string child with innerHTML. Provider names and host names come from a list
 * that is downloaded from the Internet, so everything goes through h(), which always creates
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

function fmtTime(ts) {
	return ts ? new Date(ts * 1000).toLocaleString() : '-';
}

/* the two special providers of the list get a readable name */
function providerName(p) {
	if (p === 'Self check')
		return _('Self-check');
	if (p === 'Custom')
		return _('Your host');
	return p;
}

/* what the result of the check means: [icon, color, text] */
function dpiView(dpi) {
	var c = icons.colors;

	switch (dpi) {
	case 'detected': return [ 'x-circle', c.bad,  _('Detected') ];
	case 'probably': return [ 'alert',    c.bad,  _('Probably') ];
	case 'possible': return [ 'alert',    c.warn, _('Possible') ];
	case 'unlikely': return [ 'help',     c.off,  _('Unlikely') ];
	case 'no':       return [ 'check-circle', c.ok, _('Not detected') ];
	case 'skip':     return [ 'ban',      c.off,  _('Skipped') ];
	}
	return [ 'clock', c.off, _('Waiting') ];
}

function aliveView(alive) {
	var c = icons.colors;

	switch (alive) {
	case 'yes':     return [ 'check-circle', c.ok,   _('Yes') ];
	case 'no':      return [ 'x-circle',     c.bad,  _('No') ];
	case 'unknown': return [ 'help',         c.warn, _('Unknown') ];
	}
	return [ 'clock', c.off, _('Checking') ];
}

function cell(view) {
	return icons.chip(view[0], view[2], view[1]);
}

/* counters of one run */
function tally(run) {
	var t = { detected: 0, probably: 0, possible: 0, unlikely: 0, no: 0, skip: 0, done: 0 };

	run.items.forEach(function(it) {
		t[it.dpi] = (t[it.dpi] || 0) + 1;
		t.done++;
	});
	return t;
}

function card(icon, color, title, body) {
	return h('div', {
		'style': 'display:flex;gap:.9em;align-items:center;border-radius:8px;padding:.9em 1.1em;border:1px solid ' + color + '55;background:' + color + '14'
	}, [
		h('div', { 'style': 'color:' + color }, [ icons.icon(icon, 34) ]),
		h('div', {}, [
			h('div', { 'style': 'font-weight:bold;font-size:115%;color:' + color }, title),
			h('div', {}, body)
		])
	]);
}

return view.extend({
	load: function() {
		return Promise.all([ callDiagResults(), callJobLog('diagnose') ]);
	},

	/* ---- start and stop ---- */

	start: function(host) {
		var self = this;
		var timeout = parseInt(this.timeoutSel.value, 10) || 15;

		return callJobStart('diagnose', host || '', timeout, this.compareBox.checked ? '1' : '0').then(function(res) {
			if (!res || !res.ok) {
				ui.addNotification(null, h('p', _('Cannot start the check: %s').format((res && res.error) || _('it may be running already'))), 'danger');
				return;
			}
			self.starting = true;
			self.startedAt = Date.now();
			return self.refresh();
		}).catch(function(err) {
			ui.addNotification(null, h('p', err.message), 'danger');
		});
	},

	startCustom: function() {
		var host = this.hostInput.value.trim().toLowerCase();

		/* a DNS name only: the same rule is checked on the router */
		if (!/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/.test(host) || host.indexOf('.') < 0 || host.indexOf('..') >= 0 || !/[a-z]/.test(host)) {
			ui.addNotification(null, h('p', _('Enter a host name, for example example.com (no address, no port).')), 'warning');
			return;
		}
		return this.start(host);
	},

	stop: function() {
		return callJobStop('diagnose').then(L.bind(this.refresh, this));
	},

	/* ---- drawing ---- */

	refresh: function() {
		return this.load().then(L.bind(function(data) {
			this.update(data[0], data[1]);
		}, this));
	},

	summary: function(run, running) {
		var c = icons.colors;
		var t = tally(run);
		var bad = t.detected + t.probably;
		var where = run.state === 'on'
			? _('zapret2 was running (strategy: %s).').format(run.preset || '-')
			: _('zapret2 was stopped.');

		if (running)
			return card('activity', c.info, _('Checking: %d of %d').format(t.done, run.total || t.done),
				[ h('div', { 'style': 'height:.5em;border-radius:.25em;background:rgba(128,128,128,.25);margin:.4em 0;min-width:14em' }, [
					h('div', { 'style': 'height:100%;border-radius:.25em;background:' + c.info + ';width:' + (run.total ? Math.min(100, Math.round(100 * t.done / run.total)) : 0) + '%' })
				]) ]);

		if (!run.finished)
			return card('alert', c.warn, _('The check was interrupted'), [ _('%d of %d hosts were checked.').format(t.done, run.total || t.done) ]);

		if (bad > 0)
			return card('shield-alert', c.bad, _('TCP 16-20 blocking detected: %d of %d hosts').format(bad, t.done - t.skip),
				[ where, ' ', _('The provider cuts connections to these hosts after the first kilobytes of data.') ]);

		if (t.possible > 0)
			return card('alert', c.warn, _('Blocking is possible: %d of %d hosts').format(t.possible, t.done - t.skip),
				[ where, ' ', _('The connections ended with an error, not with a freeze: the result is not certain.') ]);

		return card('shield-check', c.ok, _('TCP 16-20 blocking is not detected'),
			[ where, ' ', _('Connections to the checked hosts carry 64 KiB without a freeze.') ]);
	},

	update: function(res, log) {
		var self = this;
		var runs = (res && res.runs) || {};
		var running = !!(res && res.running);
		var order = [];
		var c = icons.colors;

		/* the job has been asked to start, but it is not seen as running yet (or it ended at once) */
		if (this.starting && (running || Date.now() - this.startedAt > 8000))
			this.starting = false;
		var waiting = this.starting && !running;

		/* the freshest run first: the main one; the other one is the comparison column */
		[ 'on', 'off' ].forEach(function(s) { if (runs[s]) order.push(runs[s]); });
		order.sort(function(a, b) { return b.started - a.started; });

		var main = order[0] || null;
		var other = order[1] || null;

		/* ---- the buttons ---- */
		this.runBtn.style.display = running ? 'none' : '';
		this.stopBtn.style.display = running ? '' : 'none';
		[ this.runBtn, this.customBtn, this.compareBox, this.timeoutSel, this.hostInput ].forEach(function(el) {
			if (running || waiting) el.setAttribute('disabled', ''); else el.removeAttribute('disabled');
		});

		var blocks = [];

		if (main)
			blocks.push(this.summary(main, running));
		else if (running || waiting)
			blocks.push(card('activity', c.info, _('Preparing the check…'), [ _('The host list is being downloaded.') ]));

		/* the provider of the router */
		var asn = (main && main.asn) || (other && other.asn);
		if (asn && asn.asn)
			blocks.push(h('div', { 'style': 'margin:.6em 0;opacity:.85' }, [
				icons.label('globe', _('Provider (by the address of the router): AS%d %s').format(asn.asn, asn.holder) +
					((asn.country || asn.city) ? ' · ' + [ asn.country, asn.city ].filter(Boolean).join(', ') : ''), 16)
			]));

		/* ---- the table ---- */
		if (main) {
			var otherMap = {};
			if (other)
				other.items.forEach(function(it) { otherMap[it.id] = it; });

			var title = function(run) {
				return (run.state === 'on' ? _('With zapret2') : _('Without zapret2')) + ' · ' + fmtTime(run.started);
			};

			var head = [
				h('div', { 'class': 'th', 'style': 'width:2.5em' }, '#'),
				h('div', { 'class': 'th' }, _('Provider')),
				h('div', { 'class': 'th' }, _('Reachable')),
				h('div', { 'class': 'th' }, [ 'TCP 16-20', h('div', { 'style': 'font-weight:normal;opacity:.7;font-size:85%' }, title(main)) ])
			];
			if (other)
				head.push(h('div', { 'class': 'th' }, [ 'TCP 16-20', h('div', { 'style': 'font-weight:normal;opacity:.7;font-size:85%' }, title(other)) ]));

			var table = h('div', { 'class': 'table' }, [ h('div', { 'class': 'tr table-titles' }, head) ]);
			var known = {};
			main.items.forEach(function(it) { known[it.n] = it; });
			var total = Math.max(main.total || 0, main.items.length);

			/* every row of the list: the finished ones with their result, the rest as "waiting" */
			var rows = [];
			for (var n = 1; n <= total; n++)
				rows.push(known[n] || { n: n, pending: true });

			rows.forEach(function(it) {
				var row = [];
				var suite = it.pending ? null : it;

				row.push(h('div', { 'class': 'td' }, String(it.n)));
				row.push(h('div', { 'class': 'td' }, suite
					? [ h('div', {}, [ suite.country ? suite.country + ' ' : '', h('strong', {}, providerName(suite.provider)) ]),
					    h('div', { 'style': 'opacity:.65;font-size:85%;word-break:break-all' }, suite.host) ]
					: [ h('div', { 'style': 'opacity:.5' }, '…') ]));
				row.push(h('div', { 'class': 'td' }, cell(aliveView(suite ? suite.alive : null))));
				row.push(h('div', { 'class': 'td' }, cell(dpiView(suite ? suite.dpi : null))));

				if (other) {
					var o = suite ? otherMap[suite.id] : null;
					row.push(h('div', { 'class': 'td' }, o ? cell(dpiView(o.dpi)) : h('span', { 'style': 'opacity:.5' }, '-')));
				}
				table.appendChild(h('div', { 'class': 'tr' }, row));
			});

			blocks.push(h('div', { 'style': 'margin-top:1em' }, [ table ]));
		}
		else if (!running && !waiting) {
			blocks.push(h('div', { 'class': 'cbi-section-descr', 'style': 'margin:1em 0' },
				_('No results yet. Press "Run the check".')));
		}

		/* ---- the log of the job ---- */
		var logbox = h('pre', {
			'style': 'max-height:16em;overflow:auto;font-size:85%;white-space:pre-wrap'
		}, (log && log.log) || _('(empty)'));
		var details = h('details', { 'style': 'margin-top:1.2em', 'open': flag(this.detailsOpen) }, [
			h('summary', { 'style': 'cursor:pointer;font-weight:bold' }, icons.label('terminal', _('Log of the check'), 16)),
			logbox
		]);
		details.addEventListener('toggle', function() { self.detailsOpen = details.open; });
		blocks.push(details);

		dom.content(this.resultBox, blocks);
		logbox.scrollTop = logbox.scrollHeight;
	},

	render: function(data) {
		var self = this;

		this.detailsOpen = false;
		this.starting = false;
		this.startedAt = 0;

		this.runBtn = h('button', { 'class': 'cbi-button cbi-button-positive', 'click': ui.createHandlerFn(this, 'start', '') },
			[ icons.label('play', _('Run the check')) ]);
		this.stopBtn = h('button', { 'class': 'cbi-button cbi-button-negative', 'style': 'display:none', 'click': ui.createHandlerFn(this, 'stop') },
			[ icons.label('stop', _('Stop')) ]);

		this.compareBox = h('input', { 'type': 'checkbox', 'id': 'zapret2-diag-compare' });
		this.timeoutSel = h('select', { 'class': 'cbi-input-select', 'style': 'width:auto' }, [
			h('option', { 'value': '10' }, _('%d s').format(10)),
			h('option', { 'value': '15', 'selected': '' }, _('%d s').format(15)),
			h('option', { 'value': '30' }, _('%d s').format(30))
		]);
		this.hostInput = h('input', {
			'type': 'text', 'class': 'cbi-input-text', 'style': 'width:19em',
			'placeholder': _('Your host, e.g. example.com')
		});
		this.hostInput.addEventListener('keydown', function(ev) { if (ev.key === 'Enter') { ev.preventDefault(); self.startCustom(); } });
		this.customBtn = h('button', { 'class': 'cbi-button cbi-button-action', 'click': ui.createHandlerFn(this, 'startCustom') },
			[ icons.label('search', _('Check this host')) ]);

		this.resultBox = h('div');

		var controls = h('div', {
			'style': 'display:flex;flex-wrap:wrap;gap:.8em 1.4em;align-items:center;padding:.8em 1em;border-radius:8px;border:1px solid rgba(128,128,128,.35)'
		}, [
			h('div', {}, [ this.runBtn, this.stopBtn ]),
			h('label', { 'style': 'display:inline-flex;align-items:center;gap:.4em', 'for': 'zapret2-diag-compare',
				'title': _('The service is stopped for the time of the second pass and started again.') }, [
				this.compareBox, _('Also check with zapret2 stopped')
			]),
			h('label', { 'style': 'display:inline-flex;align-items:center;gap:.4em' }, [
				icons.icon('clock', 16), _('Wait for an answer:'), ' ', this.timeoutSel
			]),
			h('div', { 'style': 'display:inline-flex;align-items:center;gap:.5em' }, [ this.hostInput, this.customBtn ])
		]);

		var about = h('details', { 'style': 'margin:.8em 0' }, [
			h('summary', { 'style': 'cursor:pointer;font-weight:bold' }, icons.label('info', _('What is checked and how'), 16)),
			h('div', { 'class': 'cbi-section-descr', 'style': 'margin-top:.5em' }, [
				h('p', _('Some providers cut a TCP connection to foreign hosting providers and CDNs after the client has sent 16-20 KB of data. Sites on such hosts open halfway, uploads stall, and nothing changes in the browser except the freeze.')),
				h('p', _('For every host of the list the router checks that it answers, then sends 64 KiB to it: first one POST request, then ten requests with long addresses in a single connection. A connection that freezes means that the DPI of the provider cuts it.')),
				h('p', _('The check runs on the router, so its traffic goes through the zapret2 rules just like the traffic of your devices. Run it with zapret2 on and off (or tick the box below) to see whether the strategy changes anything.')),
				h('p', _('The list of hosts is taken from the dpi-checkers project at the start of each check. To show the provider, the public RIPE Stat service is asked for the autonomous system of the address of the router. Nothing else is sent anywhere.')),
				h('p', [
					h('a', { 'href': CHECKER_URL, 'target': '_blank', 'rel': 'noopener noreferrer' }, icons.label('external', _('The original checker'), 14)), '  ',
					h('a', { 'href': DISCUSSION_URL, 'target': '_blank', 'rel': 'noopener noreferrer' }, icons.label('external', _('Discussion of the method'), 14)), '  ',
					h('a', { 'href': REPO_URL, 'target': '_blank', 'rel': 'noopener noreferrer' }, icons.label('external', _('dpi-checkers repository'), 14))
				])
			])
		]);

		this.update(data[0], data[1]);

		poll.add(L.bind(this.refresh, this), 3);

		return h('div', {}, [
			h('h2', icons.label('activity', _('Zapret2: diagnostics'), 26)),
			h('div', { 'class': 'cbi-map-descr' },
				_('Checks whether your provider cuts TCP connections after 16-20 KB of data (the "TCP 16-20" blocking).')),
			about, controls, this.resultBox
		]);
	},

	handleSaveApply: null,
	handleSave: null,
	handleReset: null
});
