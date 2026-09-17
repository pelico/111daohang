/**
 * 解析 node_exporter 文本格式（Prometheus exposition）关键指标。
 * - 计数器以字符串/BigInt 保留，避免 uint64(>2^53) 精度丢失与绕回误判。
 * - 只解析所需行，降低解析开销。
 */
const IGNORED_IFACE = /^(lo|veth|docker0|tailscale0)/;

export function parseVmMetrics(text) {
	const out = {
		hostname: null,
		bootTime: 0,
		cpu: { idle: 0, idleValid: false, total: 0 },   // CPU 用浮点（node_exporter 是秒累计，浮点）
		// memPct / temp 由调用方决定如何展示
		memTotal: 0, memAvail: 0,
		memPct: null,
		temp: null,
		net: { recv: 0n, sent: 0n },   // 选中的主网卡累计字节（BigInt）
	};

	const netRaw = {}; // iface -> {recvBig, sentBig}

	for (const line of text.split('\n')) {
		if (!line || line.charCodeAt(0) === 35) continue; // 空行 / #

		// 主机名（用于设备识别）
		if (!out.hostname && line.startsWith('node_uname_info')) {
			const m = line.match(/nodename="([^"]+)"/);
			if (m) out.hostname = m[1];
			continue;
		}
		if (out.bootTime === 0 && line.startsWith('node_boot_time_seconds')) {
			out.bootTime = toNumber(line, 0);
			continue;
		}
		// CPU
		if (line.startsWith('node_cpu_seconds_total')) {
			const mode = line.match(/mode="([^"]+)"/);
			const v = toNumber(line, 0);
			out.cpu.total += v;
			if (mode) {
				if (mode[1] === 'idle') { out.cpu.idle += v; out.cpu.idleValid = true; }
			}
			continue;
		}
		// 网络
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
		// 内存
		if (line.startsWith('node_memory_MemTotal_bytes')) { out.memTotal = toNumber(line); continue; }
		if (line.startsWith('node_memory_MemAvailable_bytes')) { out.memAvail = toNumber(line); continue; }
		// 温度
		if (out.temp === null && (line.startsWith('node_thermal_zone_temp') || line.startsWith('node_hwmon_temp_input'))) {
			out.temp = toNumber(line);
		}
	}

	// 网络：汇总所有非忽略网卡（loopback/veth/docker0/tailscale0 除外）。
	// 避免只挑一块"无流量口"导致速率恒为 0。
	for (const d in netRaw) {
		if (IGNORED_IFACE.test(d)) continue;
		out.net.recv += netRaw[d].recv;
		out.net.sent += netRaw[d].sent;
	}

	if (out.memTotal > 0) {
		const used = out.memTotal - out.memAvail;
		out.memPct = (100 * used) / out.memTotal;
	}
	return out;
}

// 转 BigInt：Scientific/整数均可；失败归 0n。用于不可能溢出的计数器
function toBig(line, fallback = 0n) {
	const sp = line.lastIndexOf(' ');
	let s = sp >= 0 ? line.slice(sp + 1) : line;
	s = s.trim();
	if (!s || /\D/.test(s) || s === '') return fallback;
	try { return BigInt(s); } catch (e) { return fallback; }
}

function toNumber(line, fallback = 0) {
	const sp = line.lastIndexOf(' ');
	const s = sp >= 0 ? line.slice(sp + 1) : line;
	const v = parseFloat(s);
	return Number.isFinite(v) ? v : fallback;
}