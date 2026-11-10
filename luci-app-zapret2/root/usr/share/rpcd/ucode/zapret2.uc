// SPDX-License-Identifier: MIT
//
// rpcd plugin (ucode) for luci-app-zapret2: ubus object "luci.zapret2".
// Only fixed commands are executed; every user-supplied value is validated
// against a whitelist/regex and is never interpolated into a shell string.

'use strict';

import { stat, readfile, writefile, rename, unlink, popen, mkdir, lsdir, chmod } from 'fs';
import { cursor } from 'uci';
import { connect } from 'ubus';

const BASE = '/usr/share/zapret2';
const RW = '/etc/zapret2';
const LIBEXEC = '/usr/libexec/zapret2';
const LOGDIR = '/var/log/zapret2';
const STATE = '/var/run/zapret2.started';
const INIT = '/etc/init.d/zapret2';
const UCI = 'zapret2';

const MAX_EDIT_SIZE = 256 * 1024;   /* ubus messages are size-limited; bigger lists are view-only */
const MAX_PRESET_SIZE = 64 * 1024;
const MAX_PRESET_LISTS = 8;
const MAX_LOG_SIZE = 64 * 1024;
const VIEW_MAX_LIMIT = 500;

const PRESET_DIRS = [
	{ dir: BASE + '/presets', origin: 'builtin' },
	{ dir: RW + '/presets/downloaded', origin: 'downloaded' },
	{ dir: RW + '/presets/user', origin: 'user' }
];

const BUILTIN_LISTS = [
	{ id: 'user',       file: RW + '/ipset/zapret-hosts-user.txt',         title: 'My hostlist',   kind: 'hosts', editable: true },
	{ id: 'exclude',    file: RW + '/ipset/zapret-hosts-user-exclude.txt', title: 'Exclusions',    kind: 'hosts', editable: true },
	{ id: 'ipban',      file: RW + '/ipset/zapret-hosts-user-ipban.txt',   title: 'IP ban list',   kind: 'hosts', editable: true },
	{ id: 'auto',       file: RW + '/ipset/zapret-hosts-auto.txt',         title: 'Auto hostlist', kind: 'hosts', editable: true },
	{ id: 'downloaded', file: RW + '/ipset/zapret-hosts.txt',              title: 'Downloaded list', kind: 'hosts', editable: false, gz: true }
];

/* nfqws2 treats an include list without a single entry as "match everything", so an empty list gets an entry
 * that matches nothing (the init script does the same, see zapret_list_guard in env.sh) */
const PLACEHOLDER = { hosts: 'nonexistent.domain', ips: '203.0.113.113/32' };

let view_seq = 0;

const GITHUB_REPO = 'FlamesC0der/openwrt-zapret';
const GITHUB_API = 'https://api.github.com';
const UPDATE_CACHE = '/var/run/zapret2-update.json';
const MODES = [ 'none', 'hostlist', 'autohostlist', 'ipset' ];

const JOBS = [ 'update-lists', 'update-presets', 'update-all', 'blockcheck', 'diagnose' ];
const DIAG_DIR = '/var/run/zapret2-diag';

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

/* preset ids are file names */
function valid_id(id) {
	return type(id) == 'string' && length(id) <= 40 && !!match(id, /^[a-z0-9][a-z0-9_-]*$/);
}

/* list ids are UCI section names: no "-" allowed there */
function valid_list_id(id) {
	return type(id) == 'string' && length(id) <= 40 && !!match(id, /^[a-z0-9][a-z0-9_]*$/);
}

function file_info(path) {
	let st = stat(path);
	if (!st)
		return { path, exists: false, size: 0, mtime: 0 };
	return { path, exists: true, size: st.size, mtime: st.mtime };
}

/* atomic write; returns true on success */
function write_atomic(path, data) {
	let tmp = path + '.tmp';
	if (writefile(tmp, data) == null)
		return false;
	/* nfqws2 re-reads lists on SIGHUP as an unprivileged user */
	chmod(tmp, 0644);
	if (!rename(tmp, path)) {
		unlink(tmp);
		return false;
	}
	return true;
}

function text_ok(s, max) {
	return type(s) == 'string' && length(s) <= max && index(s, "\x00") < 0;
}

/* POSIX ERE has no \t/\x escapes, so character classes are checked by code */
function clean_text(s) {
	return join('', map(split(s, ''), (c) => ord(c) < 32 ? ' ' : c));
}

function safe_url(url) {
	if (length(url) > 1024 || !match(url, /^https?:\/\/./))
		return false;
	for (let c in split(url, ''))
		if (ord(c) <= 32 || ord(c) == 127 || c in [ "'", '"', '`', '$', '\\' ])
			return false;
	return true;
}

function hup_daemons() {
	run('killall -HUP nfqws2');
}

function daemons() {
	let res = [];
	let conn = connect();
	if (!conn)
		return res;

	let r = conn.call('service', 'list', { name: 'zapret2' });
	let inst = r?.zapret2?.instances ?? {};

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
	let fwtype = ctx.get(UCI, 'main', 'fwtype') || '';
	let tables = run('nft list tables');
	let nft_ok = (tables.rc == 0);
	let backend = fwtype;

	if (!backend)
		backend = nft_ok ? 'nftables' : 'iptables';

	let active = false;
	if (backend == 'nftables') {
		/* on stop zapret2 removes its chains but keeps the table with the ip sets */
		if (nft_ok && index(tables.out, ' zapret2') >= 0)
			active = index(run('nft -t list table inet zapret2').out, 'chain ') >= 0;   /* -t: skip set elements (can be huge) */
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
		if (line != '' && substr(line, 0, 1) != '#' && line != PLACEHOLDER.hosts && line != PLACEHOLDER.ips)
			n++;
	}
	return n;
}

/* text of a list with the guard entry added when it has no real entries */
function guard_list_text(content, kind) {
	for (let raw in split(content, '\n')) {
		let line = trim(raw);
		if (line != '' && substr(line, 0, 1) != '#')
			return content;
	}
	return content + PLACEHOLDER[kind == 'ips' ? 'ips' : 'hosts'] + '\n';
}

/* ---- presets ------------------------------------------------------------------ */

/* "#@list: <id> <hosts|ips> <url> [title]" - a list the preset needs. Anything malformed is ignored. */
function parse_list_decl(str) {
	let m = match(str, /^([a-z0-9_]+)[[:space:]]+(hosts|ips)[[:space:]]+(https?:\/\/[^[:space:]]+)([[:space:]]+(.*))?$/);
	if (!m || !valid_list_id(m[1]) || m[1] == 'main' || !safe_url(m[3]))
		return null;
	for (let b in BUILTIN_LISTS)
		if (b.id == m[1])
			return null;

	let title = trim(clean_text(m[5] ?? ''));
	return { id: m[1], kind: m[2], url: m[3], title: title != '' && length(title) <= 80 ? title : m[1] };
}

/* create the lists a preset declares (UCI "userlist" with the URL), unless a list with that id already exists */
function provision_lists(decls) {
	let ctx = cursor();
	let created = [];

	for (let d in decls) {
		if (ctx.get(UCI, d.id) != null)
			continue;   /* the user's own list or an earlier one: keep it as it is */
		let ok = ctx.set(UCI, d.id, 'userlist') &&
			ctx.set(UCI, d.id, 'title', d.title) &&
			ctx.set(UCI, d.id, 'kind', d.kind) &&
			ctx.set(UCI, d.id, 'url', d.url);
		if (!ok) {
			ctx.revert(UCI);
			return null;
		}
		push(created, d.id);
	}

	if (length(created) && !ctx.commit(UCI)) {
		ctx.revert(UCI);
		return null;
	}

	mkdir(RW);
	mkdir(RW + '/lists');
	for (let d in decls) {
		let path = RW + '/lists/' + d.id + '.txt';
		let cur = readfile(path) ?? '';
		let guarded = guard_list_text(cur, d.kind);
		if (guarded != cur)
			write_atomic(path, guarded);
	}
	return created;
}

function parse_preset(path, origin, id) {
	let txt = readfile(path);
	if (txt == null)
		return null;

	let h = {}, body = 0, lists = [];
	for (let raw in split(txt, '\n')) {
		let line = replace(raw, '\r', '');
		let m = match(line, /^#@([a-z_.]+):[[:space:]]*(.*)$/);
		if (m) {
			if (m[1] == 'list') {
				let d = parse_list_decl(trim(m[2]));
				if (d && length(lists) < MAX_PRESET_LISTS)
					push(lists, d);
			}
			else if (h[m[1]] == null)
				h[m[1]] = trim(m[2]);
		}
		else if (trim(line) != '' && substr(trim(line), 0, 1) != '#')
			body++;
	}

	return {
		id,
		origin,
		path,
		name: h.name ?? id,
		description: h.description ?? '',
		description_ru: h['description.ru'] ?? '',
		tcp_ports: h.tcp_ports ?? '',
		udp_ports: h.udp_ports ?? '',
		source: h.source ?? '',
		lists,
		lines: body,
		/* presets can carry Lua code that runs inside nfqws2 */
		custom_lua: index(txt, '--lua-init') >= 0 || index(txt, 'luaexec') >= 0 || index(txt, '--lua-gc') >= 0
	};
}

/* id -> { path, origin, shadows } with precedence user > downloaded > builtin */
function preset_index() {
	let idx = {};
	for (let d in PRESET_DIRS) {
		let files = lsdir(d.dir) ?? [];
		for (let f in files) {
			let m = match(f, /^(.+)\.preset$/);
			if (!m || !valid_id(m[1]))
				continue;
			idx[m[1]] = { path: d.dir + '/' + f, origin: d.origin, shadows: idx[m[1]]?.origin };
		}
	}
	return idx;
}

function active_preset() {
	return cursor().get(UCI, 'main', 'preset') || 'default';
}

function reapply_if_running() {
	/* the init script regenerates the config; restart only a running service */
	if (stat(STATE))
		system([ INIT, 'restart' ], 120000);
}

/* ---- lists -------------------------------------------------------------------- */

function lists_registry() {
	let res = [];

	for (let b in BUILTIN_LISTS) {
		let file = b.file;
		if (b.gz && !stat(file) && stat(file + '.gz'))
			file += '.gz';
		push(res, { id: b.id, title: b.title, kind: b.kind, file, editable: b.editable, builtin: true, url: '' });
	}

	cursor().foreach(UCI, 'userlist', (s) => {
		let id = s['.name'];
		if (s['.anonymous'] || !valid_list_id(id))
			return;
		push(res, {
			id,
			title: s.title || id,
			kind: s.kind == 'ips' ? 'ips' : 'hosts',
			file: RW + '/lists/' + id + '.txt',
			editable: true,
			builtin: false,
			url: s.url ?? ''
		});
	});

	return res;
}

function find_list(id) {
	for (let l in lists_registry())
		if (l.id == id)
			return l;
	return null;
}


/* ---- diagnostics (TCP 16-20) -------------------------------------------------- */

const DIAG_ALIVE = [ 'yes', 'no', 'unknown' ];
const DIAG_DPI = [ 'no', 'detected', 'probably', 'possible', 'unlikely', 'skip' ];

function num(v) {
	let n = int(v);
	return (n == n) ? n : 0;
}

/* one run of the check: /var/run/zapret2-diag/<on|off>.tsv, written by job.sh while the job works */
function diag_read(state) {
	let txt = readfile(DIAG_DIR + '/' + state + '.tsv');
	if (txt == null)
		return null;

	let run = { state, started: 0, finished: 0, preset: '', total: 0, asn: null, items: [] };

	for (let raw in split(txt, '\n')) {
		let f = split(raw, '\t');
		if (f[0] == '#run') {
			run.started = num(f[1]);
			run.preset = substr(f[3] ?? '', 0, 40);
		}
		else if (f[0] == '#asn')
			run.asn = { asn: num(f[1]), holder: substr(f[2] ?? '', 0, 80), country: substr(f[3] ?? '', 0, 8), city: substr(f[4] ?? '', 0, 60) };
		else if (f[0] == '#total')
			run.total = num(f[1]);
		else if (f[0] == '#done')
			run.finished = num(f[1]);
		else if (length(f) >= 7 && match(f[0], /^[0-9]+$/))
			push(run.items, {
				n: num(f[0]),
				id: substr(f[1], 0, 24),
				provider: substr(f[2], 0, 40),
				country: substr(f[3], 0, 16),
				host: substr(f[4], 0, 100),
				alive: (f[5] in DIAG_ALIVE) ? f[5] : 'unknown',
				dpi: (f[6] in DIAG_DPI) ? f[6] : 'skip'
			});
	}

	run.items = sort(run.items, (a, b) => a.n - b.n);
	return run;
}

/* ---- versions and the GitHub update check ------------------------------------- */

/* installed version of a package from opkg or apk, without the "-rN" revision */
function installed_version(name) {
	let ver = '';

	if (stat('/usr/bin/opkg')) {
		let m = match(run('opkg status ' + name).out, /Version: ([^\n]+)/);
		if (m)
			ver = trim(m[1]);
	}
	else if (stat('/usr/bin/apk') || stat('/sbin/apk')) {
		let first = split(trim(run('apk list -I ' + name).out), ' ')[0] ?? '';
		if (substr(first, 0, length(name) + 1) == name + '-')
			ver = substr(first, length(name) + 1);
	}

	return replace(ver, /-r[0-9]+$/, '');
}

function version_parts(v) {
	let m = match(replace(trim('' + v), /^[vV]/, ''), /^([0-9]+(\.[0-9]+)*)/);
	return m ? map(split(m[1], '.'), (x) => int(x)) : [];
}

/* -1, 0, 1 like strcmp, numeric per component: 2.0.10 > 2.0.9 */
function version_cmp(a, b) {
	let x = version_parts(a), y = version_parts(b);
	let n = length(x) > length(y) ? length(x) : length(y);

	for (let i = 0; i < n; i++) {
		let p = x[i] ?? 0, q = y[i] ?? 0;
		if (p != q)
			return p < q ? -1 : 1;
	}
	return 0;
}

let fetch_seq = 0;

/* GET a GitHub API URL with curl (anonymous: the repository of the project is public) */
function github_get(url) {
	fetch_seq++;
	let base = sprintf('/tmp/zapret2-gh.%d.%d', time(), fetch_seq);
	let body = base + '.body', hdrs = base + '.hdr';
	let cmd = [ 'curl', '-sS', '-L', '-m', '25', '--max-filesize', '3000000',
		'-H', 'Accept: application/vnd.github+json', '-H', 'User-Agent: openwrt-zapret-luci',
		'-D', hdrs, '-o', body, url ];

	let rc = system(cmd, 40000);

	let status = 0;
	for (let l in split(readfile(hdrs) ?? '', '\n')) {
		let m = match(l, /^HTTP\/[0-9.]+ ([0-9]+)/);
		if (m)
			status = int(m[1]);
	}
	let text = readfile(body) ?? '';

	unlink(body);
	unlink(hdrs);

	return { rc, status, data: text != '' ? json(text) : null };
}

function update_cache_read() {
	let t = readfile(UPDATE_CACHE);
	return t ? json(t) : null;
}

/* Is a newer version published in the project repository on GitHub? */
function check_update() {
	let repo = GITHUB_REPO;
	let current = installed_version('luci-app-zapret2');
	let res = { ok: false, repo, current, checked: time() };

	let latest = null, source = 'release';
	let r = github_get(GITHUB_API + '/repos/' + repo + '/releases/latest');

	if (r.rc != 0) {
		res.error = 'network';
		return res;
	}
	if (r.status == 200 && r.data?.tag_name) {
		latest = { tag: r.data.tag_name, name: r.data.name ?? '', url: r.data.html_url ?? '',
			notes: substr(r.data.body ?? '', 0, 2000), published: r.data.published_at ?? '' };
	}
	else if (r.status == 401 || r.status == 403) {
		/* anonymous requests are rate limited (60 per hour per address) */
		res.error = 'forbidden';
		return res;
	}
	else if (r.status == 404) {
		/* no releases yet: try plain tags */
		let t = github_get(GITHUB_API + '/repos/' + repo + '/tags?per_page=50');
		if (t.status == 200 && type(t.data) == 'array' && length(t.data)) {
			let best = null;
			for (let e in t.data)
				if (length(version_parts(e.name)) && (!best || version_cmp(e.name, best) > 0))
					best = e.name;
			if (best) {
				latest = { tag: best, name: best, url: 'https://github.com/' + repo + '/releases/tag/' + best, notes: '', published: '' };
				source = 'tag';
			}
		}
		if (!latest) {
			res.error = 'not_found';
			return res;
		}
	}
	else {
		res.error = 'http_' + r.status;
		return res;
	}

	res.ok = true;
	res.source = source;
	res.latest = replace(latest.tag, /^[vV]/, '');
	res.tag = latest.tag;
	res.title = latest.name;
	res.url = latest.url;
	res.notes = latest.notes;
	res.published = latest.published;
	res.available = (current != '') && version_cmp(res.latest, current) > 0;
	res.summary = res.available
		? sprintf('update available: %s -> %s (%s)', current || '?', res.latest, res.url)
		: sprintf('up to date (%s)', current || res.latest);

	writefile(UPDATE_CACHE, sprintf('%J', res));
	return res;
}

function set_uci_and_apply(settings) {
	let ctx = cursor();
	for (let k in keys(settings))
		if (!ctx.set(UCI, 'main', k, settings[k]))
			return false;
	return ctx.commit(UCI);
}

const methods = {
	status: {
		call: function() {
			let ctx = cursor();
			let get = (opt, def) => ctx.get(UCI, 'main', opt) ?? def;

			let version = trim(readfile(BASE + '/version') ?? '');

			let idx = preset_index();
			let pid = get('preset', 'default');
			let preset = idx[pid] ? parse_preset(idx[pid].path, idx[pid].origin, pid) : null;

			let lists = [];
			for (let l in lists_registry()) {
				let fi = file_info(l.file);
				push(lists, {
					id: l.id, title: l.title, kind: l.kind, builtin: l.builtin, url: l.url,
					exists: fi.exists, size: fi.size, mtime: fi.mtime,
					lines: count_lines(l.file, fi.size)
				});
			}

			let jobs = {};
			for (let j in JOBS)
				jobs[j] = job_state(j);

			return {
				enabled: get('enabled', '0') == '1',
				on: get('enabled', '0') == '1' && get('nfqws2_enable', '0') == '1',
				running: !!stat(STATE),
				version,
				versions: { port: installed_version('luci-app-zapret2'), zapret2: version },
				update: update_cache_read(),
				github_repo: GITHUB_REPO,
				mode_filter: get('mode_filter', 'none'),
				nfqws2_enable: get('nfqws2_enable', '0') == '1',
				preset: { id: pid, found: !!preset, name: preset?.name ?? pid, origin: preset?.origin ?? '' },
				daemons: daemons(),
				firewall: firewall(),
				lists,
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

	/* master switch: one click enables/disables both the service and nfqws2 */
	set_enabled: {
		args: { on: true },
		call: function(req) {
			let on = !!req.args?.on;

			if (!set_uci_and_apply(on ? { enabled: '1', nfqws2_enable: '1' } : { enabled: '0' }))
				return { ok: false, error: 'cannot write the configuration' };

			mkdir(LOGDIR);
			let logfile = LOGDIR + '/ctl.log';
			let rc = system(`${INIT} ${on ? 'restart' : 'stop'} >${logfile} 2>&1 </dev/null`, 120000);
			return { ok: rc == 0, rc, output: trim_tail(readfile(logfile) ?? '', 4096) };
		}
	},

	/* which traffic goes through zapret: all / only listed domains / listed + auto / by ip */
	set_mode: {
		args: { mode: 'mode' },
		call: function(req) {
			let mode = req.args?.mode;
			if (!(mode in MODES))
				return { ok: false, error: 'invalid mode' };

			if (!set_uci_and_apply({ mode_filter: mode }))
				return { ok: false, error: 'cannot write the configuration' };

			reapply_if_running();
			return { ok: true, running: !!stat(STATE) };
		}
	},

	check_update: {
		call: function() {
			return check_update();
		}
	},

	/* ---- presets ---- */

	presets: {
		call: function() {
			let idx = preset_index();
			let active = active_preset();
			let ctx = cursor();
			let res = [];

			for (let id in keys(idx)) {
				let p = parse_preset(idx[id].path, idx[id].origin, id);
				if (!p)
					continue;
				for (let d in p.lists)
					d.exists = (ctx.get(UCI, d.id) != null);
				p.active = (id == active);
				p.shadows = idx[id].shadows ?? '';
				push(res, p);
			}

			/* default first, then alphabetically by id */
			res = sort(res, (a, b) => a.id == 'default' ? -1 : b.id == 'default' ? 1 : (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

			return { ok: true, active, presets: res };
		}
	},

	get_preset: {
		args: { id: 'id' },
		call: function(req) {
			let id = req.args?.id;
			let ent = valid_id(id) ? preset_index()[id] : null;

			if (!ent)
				return { ok: false, error: 'no such preset' };

			let content = readfile(ent.path) ?? '';
			return { ok: true, id, origin: ent.origin, editable: ent.origin == 'user', shadows: ent.shadows ?? '', content };
		}
	},

	save_preset: {
		args: { id: 'id', content: 'content' },
		call: function(req) {
			let id = req.args?.id;
			let content = req.args?.content;

			if (!valid_id(id))
				return { ok: false, error: 'invalid id: use a-z, 0-9, "-" and "_" (up to 40 characters)' };
			if (!text_ok(content, MAX_PRESET_SIZE))
				return { ok: false, error: 'invalid content' };

			content = replace(content, '\r', '');

			/* the preset must contain at least one non-comment option line */
			let body = 0;
			for (let l in split(content, '\n'))
				if (trim(l) != '' && substr(trim(l), 0, 1) != '#')
					body++;
			if (!body)
				return { ok: false, error: 'the preset has no nfqws2 options' };

			if (content != '' && substr(content, -1) != '\n')
				content += '\n';

			mkdir(RW);
			mkdir(RW + '/presets');
			mkdir(RW + '/presets/user');
			if (!write_atomic(RW + '/presets/user/' + id + '.preset', content))
				return { ok: false, error: 'write failed' };

			/* a changed active preset must be re-applied */
			if (id == active_preset())
				reapply_if_running();

			return { ok: true };
		}
	},

	delete_preset: {
		args: { id: 'id' },
		call: function(req) {
			let id = req.args?.id;
			if (!valid_id(id))
				return { ok: false, error: 'invalid id' };

			let path = RW + '/presets/user/' + id + '.preset';
			if (!stat(path))
				return { ok: false, error: 'only your own presets can be deleted' };

			unlink(path);
			if (id == active_preset())
				reapply_if_running();

			return { ok: true };
		}
	},

	set_preset: {
		args: { id: 'id' },
		call: function(req) {
			let id = req.args?.id;
			if (!valid_id(id) || !preset_index()[id])
				return { ok: false, error: 'no such preset' };

			let ctx = cursor();
			ctx.set(UCI, 'main', 'preset', id);
			ctx.commit(UCI);

			/* the lists the preset declares (#@list:) are added and downloaded */
			let decls = parse_preset(preset_index()[id].path, '', id)?.lists ?? [];
			let created = length(decls) ? provision_lists(decls) : [];
			if (created == null)
				return { ok: false, error: 'cannot write the configuration' };

			reapply_if_running();

			/* download what is still a placeholder (new lists, or lists that were never fetched) */
			let pending = [];
			for (let d in decls) {
				let fi = file_info(RW + '/lists/' + d.id + '.txt');
				if (d.id in created || count_lines(RW + '/lists/' + d.id + '.txt', fi.size) === 0)
					push(pending, d.id);
			}
			let downloading = false;
			if (length(pending))
				downloading = system([ LIBEXEC + '/job.sh', 'start', 'update-lists' ], 10000) == 0;

			return { ok: true, running: !!stat(STATE), lists_added: created, lists_downloading: downloading };
		}
	},

	/* ---- lists ---- */

	lists: {
		call: function() {
			let res = [];
			for (let l in lists_registry()) {
				let fi = file_info(l.file);
				push(res, {
					id: l.id, title: l.title, kind: l.kind, builtin: l.builtin, url: l.url, editable: l.editable,
					exists: fi.exists, size: fi.size, mtime: fi.mtime,
					lines: count_lines(l.file, fi.size),
					can_edit: l.editable && fi.size <= MAX_EDIT_SIZE
				});
			}
			return { ok: true, lists: res, mode: cursor().get(UCI, 'main', 'mode_filter') || 'none' };
		}
	},

	get_list: {
		args: { id: 'id' },
		call: function(req) {
			let l = find_list(req.args?.id);
			if (!l)
				return { ok: false, error: 'no such list' };

			let fi = file_info(l.file);
			if (fi.exists && fi.size > MAX_EDIT_SIZE)
				return { ok: false, error: 'too_large', size: fi.size };

			let content = '';
			if (fi.exists) {
				if (substr(l.file, -3) == '.gz')
					return { ok: false, error: 'too_large', size: fi.size };
				content = readfile(l.file) ?? '';
			}

			return { ok: true, id: l.id, path: l.file, exists: fi.exists, editable: l.editable, content };
		}
	},

	view_list: {
		args: { id: 'id', offset: 0, limit: 0, filter: 'filter' },
		call: function(req) {
			let a = req.args ?? {};
			let l = find_list(a.id);
			if (!l)
				return { ok: false, error: 'no such list' };
			if (!stat(l.file))
				return { ok: true, lines: [], total: 0, matched: 0 };

			let off = int(a.offset), lim = int(a.limit);
			if (off != off || off < 0) off = 0;
			if (lim != lim || lim < 1) lim = 100;
			if (lim > VIEW_MAX_LIMIT) lim = VIEW_MAX_LIMIT;

			let flt = type(a.filter) == 'string' ? substr(a.filter, 0, 200) : '';
			view_seq++;
			let tag = sprintf('%d.%d', time(), view_seq);
			let out = '/tmp/zapret2-view.' + tag, meta = '/tmp/zapret2-view-meta.' + tag;

			let rc = system([ LIBEXEC + '/listview.sh', l.file, sprintf('%d', off), sprintf('%d', lim), out, meta, flt ], 20000);
			let text = readfile(out) ?? '';
			let m = split(trim(readfile(meta) ?? '0 0'), ' ');
			unlink(out);
			unlink(meta);

			if (rc != 0)
				return { ok: false, error: 'cannot read the list' };

			let lines = split(text, '\n');
			if (length(lines) && lines[length(lines) - 1] == '')
				pop(lines);

			return { ok: true, lines, total: int(m[0]), matched: int(m[1]), offset: off };
		}
	},

	set_list: {
		args: { id: 'id', content: 'content' },
		call: function(req) {
			let l = find_list(req.args?.id);
			let content = req.args?.content;

			if (!l)
				return { ok: false, error: 'no such list' };
			if (!l.editable)
				return { ok: false, error: 'this list is read-only' };
			if (!text_ok(content, MAX_EDIT_SIZE))
				return { ok: false, error: 'invalid content' };

			content = replace(content, '\r', '');
			if (content != '' && substr(content, -1) != '\n')
				content += '\n';

			/* "my list" and your own lists are include lists: empty would mean "everything" */
			if (l.id == 'user' || !l.builtin)
				content = guard_list_text(content, l.kind);

			mkdir(RW);
			mkdir(RW + '/ipset');
			mkdir(RW + '/lists');
			if (!write_atomic(l.file, content))
				return { ok: false, error: 'write failed' };

			/* nfqws2 reloads lists on SIGHUP */
			hup_daemons();
			return { ok: true };
		}
	},

	/* create or update the definition of a custom list (UCI section "userlist") */
	save_list: {
		args: { id: 'id', title: 'title', url: 'url', kind: 'kind' },
		call: function(req) {
			let a = req.args ?? {};

			if (!valid_list_id(a.id))
				return { ok: false, error: 'invalid id: use a-z, 0-9 and "_" (up to 40 characters)' };
			if (a.id == 'main')
				return { ok: false, error: 'this id is reserved' };
			for (let b in BUILTIN_LISTS)
				if (b.id == a.id)
					return { ok: false, error: 'this id is reserved' };

			let title = type(a.title) == 'string' ? trim(clean_text(a.title)) : '';
			let url = type(a.url) == 'string' ? trim(a.url) : '';
			let kind = a.kind == 'ips' ? 'ips' : 'hosts';

			if (length(title) > 80)
				return { ok: false, error: 'the title is too long' };
			if (url != '' && !safe_url(url))
				return { ok: false, error: 'the URL must start with http:// or https:// and contain no spaces or quotes' };

			let ctx = cursor();
			let existing = ctx.get(UCI, a.id);
			if (existing != null && existing != 'userlist')
				return { ok: false, error: 'this id is reserved' };

			let ok = ctx.set(UCI, a.id, 'userlist') &&
				ctx.set(UCI, a.id, 'title', title != '' ? title : a.id) &&
				ctx.set(UCI, a.id, 'kind', kind);
			if (ok && url != '')
				ok = ctx.set(UCI, a.id, 'url', url);
			else if (ok)
				ctx.delete(UCI, a.id, 'url');
			if (!ok || !ctx.commit(UCI)) {
				ctx.revert(UCI);
				return { ok: false, error: 'cannot write the configuration' };
			}

			mkdir(RW + '/lists');
			let path = RW + '/lists/' + a.id + '.txt';
			if (!stat(path))
				write_atomic(path, guard_list_text('', kind));

			system([ LIBEXEC + '/job.sh', 'cron-sync' ], 10000);
			return { ok: true };
		}
	},

	delete_list: {
		args: { id: 'id' },
		call: function(req) {
			let id = req.args?.id;
			let l = find_list(id);
			if (!l || l.builtin)
				return { ok: false, error: 'only your own lists can be deleted' };

			let ctx = cursor();
			if (!ctx.delete(UCI, id) || !ctx.commit(UCI))
				return { ok: false, error: 'cannot write the configuration' };
			unlink(l.file);

			system([ LIBEXEC + '/job.sh', 'cron-sync' ], 10000);
			return { ok: true };
		}
	},

	/* ---- background jobs ---- */

	job_start: {
		args: { job: 'job', domains: 'domains', scanlevel: 'scanlevel', ipvs: 'ipvs', tests: 'tests', host: 'host', timeout: 15, compare: 'compare' },
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
				if (!(scanlevel in [ 'veryquick', 'quick', 'standard', 'force' ]))
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

			if (a.job == 'diagnose') {
				/* an own host name (a DNS name: no address, no port), the timeout of one request, and the comparison run */
				let host = trim(a.host ?? '');
				if (host != '') {
					if (length(host) > 100 || !match(host, /^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$/) || !match(host, /[A-Za-z]/) || !match(host, /\./) || match(host, /\.\./))
						return { ok: false, error: 'invalid host name' };
					push(cmd, 'HOST=' + host);
				}

				let timeout = int(a.timeout ?? 15);
				if (!(timeout >= 5 && timeout <= 60))
					return { ok: false, error: 'invalid timeout' };
				push(cmd, 'TIMEOUT=' + timeout);
				push(cmd, 'COMPARE=' + ((a.compare == '1' || a.compare === true || a.compare == 1) ? 1 : 0));
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

	/* the results of the TCP 16-20 check: with zapret2 running ("on") and stopped ("off") */
	diag_results: {
		call: function() {
			return {
				ok: true,
				running: job_state('diagnose') == 'running',
				runs: { on: diag_read('on'), off: diag_read('off') }
			};
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
			let r = run('logread -e zapret2 -l 200');
			/* LuCI's own "accepted login on /admin/services/zapret2/..." lines match the pattern too */
			let lines = filter(split(r.out, '\n'), (l) => index(l, 'dispatcher.uc') < 0);
			return { ok: true, log: trim_tail(join('\n', lines), MAX_LOG_SIZE) };
		}
	}
};

return { 'luci.zapret2': methods };
