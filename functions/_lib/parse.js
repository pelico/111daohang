/**
 * 解析 node_exporter 文本格式（Prometheus exposition）关键指标。
 * 与 worker/ingest/src/parse.js 同源，供 Pages Function（/api/nas/probe）复用。
 * - 计数器以字符串/BigInt 保留，避免 uint64(>2^53) 精度丢失与绕回误判。
 * - 只解析所需行，降低解析开销。
 */
const IGNORED_IFACE = /^(lo|veth|docker0|tailscale0)/;
const PSEUDO_FS = /^(tmpfs|devtmpfs|overlay|squashfs|proc|sysfs|cgroup|cgroup2|mqueue|devpts|fuse\.lxcfs|nsfs|autofs|binfmt_misc|rpc_pipefs|9p|ceph|fuse\.overlayfs)/;

export function parseVmMetrics(text) {
	const out = {
		hostname: null,
		bootTime: 0,
		cpu: { idle: 0, idleValid: false, total: 0 },   // CPU 用浮点（node_exporter 是秒累计，浮点）
		memTotal: 0, memAvail: 0,
		memPct: null,
		temp: null,
		net: { recv: 0n, sent: 0n },   // 选中的主网卡累计字节（BigInt）
		fs: { total: 0, avail: 0 },   // 根分区（或最大真实分区）存储
	};

	const netRaw = {}; // iface -> {recvBig, sentBig}
	const fsRaw = {}; // mountpoint -> { total, avail }

	for (const line of text.split('\n')) {
		if (!line || line.charCodeAt(0) === 35) continue; // 空行 / #

		if (!out.hostname && line.startsWith('node_uname_info')) {
			const m = line.match(/nodename="([^"]+)"/);
			if (m) out.hostname = m[1];
			continue;
		}
		if (out.bootTime === 0 && line.startsWith('node_boot_time_seconds')) {
			out.bootTime = toNumber(line, 0);
			continue;
		}
		if (line.startsWith('node_cpu_seconds_total')) {
			const mode = line.match(/mode="([^"]+)"/);
			const v = toNumber(line, 0);
			out.cpu.total += v;
			if (mode) {
				if (mode[1] === 'idle') { out.cpu.idle += v; out.cpu.idleValid = true; }
			}
			continue;
		}
		if (line.startsWith('node_network_receive_bytes_total') || line.startsWith('node_network_transmit_bytes_total')) {
			const dev = line.match(/device="([^"]+)"/);
			const v = toBig(line, 0n);
			if (dev) {
				const d = dev[1];
				if (!netRaw[d]) netRaw[d] = { recv: 0n, sent: 0n };
				if (line.startsWith('node_network_receive_bytes_total')) netRaw[d].recv = v;
				else netRaw[d].sent = v;
			}
			continue;
		}
		if (line.startsWith('node_memory_MemTotal_bytes')) { out.memTotal = toNumber(line); continue; }
		if (line.startsWith('node_memory_MemAvailable_bytes')) { out.memAvail = toNumber(line); continue; }
		if (out.temp === null && (line.startsWith('node_thermal_zone_temp') || line.startsWith('node_hwmon_temp_input'))) {
			out.temp = toNumber(line);
		}
		// 存储
		if (line.startsWith('node_filesystem_size_bytes') || line.startsWith('node_filesystem_avail_bytes')) {
			const ft = line.match(/fstype="([^"]+)"/);
			if (ft && PSEUDO_FS.test(ft[1])) continue;
			const mp = line.match(/mountpoint="([^"]+)"/);
			if (!mp) continue;
			const mountpoint = mp[1];
			if (!fsRaw[mountpoint]) fsRaw[mountpoint] = { total: 0, avail: 0 };
			if (line.startsWith('node_filesystem_size_bytes')) fsRaw[mountpoint].total = toNumber(line, 0);
			else fsRaw[mountpoint].avail = toNumber(line, 0);
			continue;
		}
	}

	// 网络：优先 WAN 网卡(eth/enp/ens/eno/wl/wlan)，避免 docker 桥(br-/veth/…)重复计入；无 WAN 则综合非忽略口
	const WAN_IFACE = /^(eth|enp|ens|eno|wl|wlan)\d/;
	const nonIgnored = Object.keys(netRaw).filter(d => !IGNORED_IFACE.test(d));
	const wanSet = nonIgnored.filter(d => WAN_IFACE.test(d));
	for (const d of (wanSet.length ? wanSet : nonIgnored)) {
		out.net.recv += netRaw[d].recv;
		out.net.sent += netRaw[d].sent;
	}

	// 存储：优先根分区，无根分区取最大真实分区
	const rootFs = fsRaw['/'];
	let bestFs = rootFs || null;
	if (!bestFs) {
		for (const mp of Object.keys(fsRaw)) {
			if (!bestFs || fsRaw[mp].total > bestFs.total) bestFs = fsRaw[mp];
		}
	}
	if (bestFs && bestFs.total > 0) {
		out.fs = { total: bestFs.total, avail: bestFs.avail };
	}

	if (out.memTotal > 0) {
		const used = out.memTotal - out.memAvail;
		out.memPct = (100 * used) / out.memTotal;
	}
	return out;
}

// 转 BigInt：支持科学计数法（如 5.37e+09）与普通整数；失败归 0n
function toBig(line, fallback = 0n) {
	const sp = line.lastIndexOf(' ');
	const s = (sp >= 0 ? line.slice(sp + 1) : line).trim();
	if (!s) return fallback;
	try { return bigIntFromMetric(s); } catch (e) { return fallback; }
}

// 将 prometheus 数值（整数或科学计数法）精确转成 BigInt，不丢精度
function bigIntFromMetric(s) {
	let neg = false, exp = 0;
	s = s.trim();
	if (s[0] === '-') { neg = true; s = s.slice(1); }
	else if (s[0] === '+') { s = s.slice(1); }
	const e = s.search(/[eE]/);
	if (e !== -1) { exp = parseInt(s.slice(e + 1), 10) || 0; s = s.slice(0, e); }
	const dot = s.indexOf('.');
	let intPart = s, frac = '';
	if (dot !== -1) { intPart = s.slice(0, dot); frac = s.slice(dot + 1); }
	let digits = intPart + frac;
	const shift = exp - frac.length;
	if (shift >= 0) digits += '0'.repeat(shift);
	else {
		const cut = -shift;
		if (cut >= digits.length) return 0n;
		digits = digits.slice(0, digits.length - cut);
	}
	const v = BigInt(digits || '0');
	return neg ? -v : v;
}

function toNumber(line, fallback = 0) {
	const sp = line.lastIndexOf(' ');
	const s = sp >= 0 ? line.slice(sp + 1) : line;
	const v = parseFloat(s);
	return Number.isFinite(v) ? v : fallback;
}