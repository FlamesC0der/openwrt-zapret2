// SPDX-License-Identifier: MIT
//
// rpcd plugin (ucode) for luci-app-zapret: ubus object "luci.zapret".
// Only fixed commands are executed; every user-supplied value is validated
// against a whitelist/regex and is never interpolated into a shell string.

'use strict';

import { stat, readfile, writefile, rename, unlink, popen, mkdir } from 'fs';
import { cursor } from 'uci';
import { connect } from 'ubus';

const BASE = '/usr/share/zapret';
const RW = '/etc/zapret';
const LIBEXEC = '/usr/libexec/zapret';
const LOGDIR = '/var/log/zapret';
const STATE = '/var/run/zapret.started';
const INIT = '/etc/init.d/zapret';

const MAX_LIST_SIZE = 256 * 1024;    /* lists edited here are small; ubus messages are size-limited */
const MAX_LOG_SIZE = 64 * 1024;

const LISTS = {
	'hosts-user':         RW + '/ipset/zapret-hosts-user.txt',
	'hosts-user-exclude': RW + '/ipset/zapret-hosts-user-exclude.txt',
	'hosts-user-ipban':   RW + '/ipset/zapret-hosts-user-ipban.txt',
	'hosts-auto':         RW + '/ipset/zapret-hosts-auto.txt'
};

const JOBS = [ 'update-lists', 'blockcheck' ];

/* run a fixed command line, return { rc, out } */
function run(cmd) {
	let p = popen(cmd + ' 2>&1', 'r');
	if (!p)
		return { rc: -1, out: '' };

	let out = p.read('all') ?? '';
	let rc = p.close();

	return { rc, out };
}

function trim_tail(s, max) {
	if (length(s) > max)
		s = substr(s, length(s) - max);
	return s;
}

function file_info(path) {
	let st = stat(path);
	if (!st)
		return { path, exists: false, size: 0, mtime: 0 };
	return { path, exists: true, size: st.size, mtime: st.mtime };
}

function daemons() {
	let res = [];
	let conn = connect();
	if (!conn)
		return res;

	let r = conn.call('service', 'list', { name: 'zapret' });
	let inst = r?.zapret?.instances ?? {};

	for (let k in inst) {
		let i = inst[k];
		let cmd = i.command ?? [];
		let bin = length(cmd) ? split(cmd[0], '/') : [];
		push(res, {
			name: length(bin) ? bin[length(bin) - 1] : k,
			pid: i.pid ?? 0,
			running: !!i.running,
			command: join(' ', cmd)
		});
	}

	return res;
}

function firewall() {
	let ctx = cursor();
	let fwtype = ctx.get('zapret', 'main', 'fwtype') || '';
	let tables = run('nft list tables');
	let nft_ok = (tables.rc == 0);
	let backend = fwtype;

	if (!backend)
		backend = nft_ok ? 'nftables' : 'iptables';

	let active = false;
	if (backend == 'nftables') {
		/* on stop zapret removes its chains but keeps the table with the ip sets */
		if (nft_ok && index(tables.out, ' zapret') >= 0)
			active = index(run('nft -t list table inet zapret').out, 'chain ') >= 0;   /* -t: skip set elements (can be huge) */
	}
	else
		active = index(run('iptables-save -t mangle').out, 'NFQUEUE') >= 0;

	return { backend, active };
}

function job_state(job) {
	let r = run(LIBEXEC + '/job.sh status ' + job);
	return trim(r.out) == 'running' ? 'running' : 'stopped';
}

function count_lines(path, size) {
	if (size <= 0 || size > 512 * 1024)
		return null;
	let s = readfile(path);
	if (s == null)
		return null;
	let n = 0;
	for (let raw in split(s, '\n')) {
		let line = trim(raw);
		if (line != '' && substr(line, 0, 1) != '#')
			n++;
	}
	return n;
}

const methods = {
	status: {
		call: function() {
			let ctx = cursor();
			let get = (opt, def) => ctx.get('zapret', 'main', opt) ?? def;

			let version = trim(readfile(BASE + '/version') ?? '');

			let lists = [];
			for (let id in keys(LISTS)) {
				let fi = file_info(LISTS[id]);
				fi.id = id;
				fi.lines = count_lines(fi.path, fi.size);
				push(lists, fi);
			}

			let downloaded = file_info(RW + '/ipset/zapret-hosts.txt.gz');
			if (!downloaded.exists)
				downloaded = file_info(RW + '/ipset/zapret-hosts.txt');

			let jobs = {};
			for (let j in JOBS)
				jobs[j] = job_state(j);

			return {
				enabled: get('enabled', '0') == '1',
				running: !!stat(STATE),
				version,
				mode_filter: get('mode_filter', 'none'),
				nfqws_enable: get('nfqws_enable', '0') == '1',
				tpws_enable: get('tpws_enable', '0') == '1',
				tpws_socks_enable: get('tpws_socks_enable', '0') == '1',
				getlist: get('getlist', ''),
				daemons: daemons(),
				firewall: firewall(),
				lists,
				downloaded,
				jobs
			};
		}
	},

	service: {
		args: { action: 'action' },
		call: function(req) {
			let action = req.args?.action;

			if (!(action in [ 'start', 'stop', 'restart', 'restart_fw', 'restart_daemons' ]))
				return { ok: false, error: 'invalid action' };

			mkdir(LOGDIR);
			let logfile = LOGDIR + '/ctl.log';
			let rc = system(`${INIT} ${action} >${logfile} 2>&1 </dev/null`, 120000);

			return {
				ok: rc == 0,
				rc,
				output: trim_tail(readfile(logfile) ?? '', 4096)
			};
		}
	},

	get_list: {
		args: { name: 'name' },
		call: function(req) {
			let name = req.args?.name;
			let path = LISTS[name];

			if (!path)
				return { ok: false, error: 'invalid list name' };

			let fi = file_info(path);
			if (fi.exists && fi.size > MAX_LIST_SIZE)
				return { ok: false, error: 'file is too large to edit here' };

			return {
				ok: true,
				name,
				path,
				exists: fi.exists,
				content: fi.exists ? (readfile(path) ?? '') : ''
			};
		}
	},

	set_list: {
		args: { name: 'name', content: 'content' },
		call: function(req) {
			let name = req.args?.name;
			let content = req.args?.content;
			let path = LISTS[name];

			if (!path)
				return { ok: false, error: 'invalid list name' };
			if (type(content) != 'string' || length(content) > MAX_LIST_SIZE)
				return { ok: false, error: 'invalid content' };

			/* normalize line endings, make sure the file ends with a newline */
			content = replace(content, '\r', '');
			if (content != '' && substr(content, -1) != '\n')
				content += '\n';

			mkdir(RW);
			mkdir(RW + '/ipset');

			let tmp = path + '.tmp';
			if (writefile(tmp, content) == null)
				return { ok: false, error: 'write failed' };
			if (!rename(tmp, path)) {
				unlink(tmp);
				return { ok: false, error: 'rename failed' };
			}

			/* daemons reload their hostlists on SIGHUP */
			run('killall -HUP nfqws tpws');

			return { ok: true };
		}
	},

	job_start: {
		args: { job: 'job', domains: 'domains', scanlevel: 'scanlevel', ipvs: 'ipvs', tests: 'tests' },
		call: function(req) {
			let a = req.args ?? {};

			if (!(a.job in JOBS))
				return { ok: false, error: 'invalid job' };

			let cmd = [ LIBEXEC + '/job.sh', 'start', a.job ];

			if (a.job == 'blockcheck') {
				let domains = trim(a.domains ?? '');
				if (length(domains) > 512 || !match(domains, /^[A-Za-z0-9._ -]+$/))
					return { ok: false, error: 'invalid domain list' };
				push(cmd, 'DOMAINS=' + domains);

				let scanlevel = a.scanlevel ?? 'quick';
				if (!(scanlevel in [ 'quick', 'standard', 'force' ]))
					return { ok: false, error: 'invalid scan level' };
				push(cmd, 'SCANLEVEL=' + scanlevel);

				let ipvs = a.ipvs ?? '4';
				if (!(ipvs in [ '4', '6', '46' ]))
					return { ok: false, error: 'invalid IP version' };
				push(cmd, 'IPVS=' + ipvs);

				let want = {};
				for (let t in split(a.tests ?? 'http,tls12,tls13,quic', ',')) {
					if (!(t in [ 'http', 'tls12', 'tls13', 'quic' ]))
						return { ok: false, error: 'invalid test name' };
					want[t] = true;
				}
				push(cmd, 'ENABLE_HTTP=' + (want.http ? 1 : 0));
				push(cmd, 'ENABLE_HTTPS_TLS12=' + (want.tls12 ? 1 : 0));
				push(cmd, 'ENABLE_HTTPS_TLS13=' + (want.tls13 ? 1 : 0));
				push(cmd, 'ENABLE_HTTP3=' + (want.quic ? 1 : 0));
			}

			let rc = system(cmd, 10000);
			return { ok: rc == 0, rc };
		}
	},

	job_stop: {
		args: { job: 'job' },
		call: function(req) {
			let job = req.args?.job;
			if (!(job in JOBS))
				return { ok: false, error: 'invalid job' };

			let rc = system([ LIBEXEC + '/job.sh', 'stop', job ], 10000);
			return { ok: rc == 0, rc };
		}
	},

	job_log: {
		args: { job: 'job' },
		call: function(req) {
			let job = req.args?.job;
			if (!(job in JOBS))
				return { ok: false, error: 'invalid job' };

			let log = readfile(LOGDIR + '/' + job + '.log') ?? '';

			return {
				ok: true,
				running: job_state(job) == 'running',
				log: trim_tail(log, MAX_LOG_SIZE)
			};
		}
	},

	get_log: {
		call: function() {
			let r = run('logread -e zapret -l 200');
			/* LuCI's own "accepted login on /admin/services/zapret/..." lines match the pattern too */
			let lines = filter(split(r.out, '\n'), (l) => index(l, 'dispatcher.uc') < 0);
			return { ok: true, log: trim_tail(join('\n', lines), MAX_LOG_SIZE) };
		}
	}
};

return { 'luci.zapret': methods };
