document.addEventListener('DOMContentLoaded', function() {

    // ==================== 通用工具函数（P0/P1 优化共用） ====================
    // P0-2: HTML 转义，防 XSS
    function escapeHtml(str) {
        if (str == null) return '';
        return String(str).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    }

    // P0-3 & P1-7: 带超时 + 可取消的 fetch
    function fetchWithTimeout(url, options = {}, timeoutMs = 15000) {
        const controller = new AbortController();
        const abortId = setTimeout(() => controller.abort(), timeoutMs);
        const signalFromOuter = options.signal;
        if (signalFromOuter) signalFromOuter.addEventListener('abort', () => controller.abort(), { once: true });
        return fetch(url, { ...options, signal: controller.signal }).finally(() => clearTimeout(abortId));
    }

    // P1-7: 指数退避重试
    async function fetchWithRetry(url, options = {}, { timeout = 15000, retries = 3, baseDelay = 500 } = {}) {
        let lastErr;
        for (let attempt = 0; attempt <= retries; attempt++) {
            try {
                return await fetchWithTimeout(url, options, timeout);
            } catch (err) {
                lastErr = err;
                if (attempt === retries) break;
                if (err.name === 'AbortError') break; // 手动取消不重试
                await new Promise(r => setTimeout(r, baseDelay * Math.pow(2, attempt)));
            }
        }
        throw lastErr;
    }

    // P0-3: Promise.all 并发限流
    async function promiseAllLimited(items, limit, mapper) {
        const results = new Array(items.length);
        let idx = 0;
        async function worker() {
            while (idx < items.length) {
                const cur = idx++;
                results[cur] = await mapper(items[cur], cur);
            }
        }
        await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
        return results;
    }

    // P0-1: Chart 实例注册表，集中管理防泄漏
    const chartRegistry = new Map();
    function registerChart(id, chart) {
        destroyChartById(id);
        chartRegistry.set(id, chart);
    }
    function destroyChartById(id) {
        const old = chartRegistry.get(id);
        if (old) { try { old.destroy(); } catch (e) {} chartRegistry.delete(id); }
    }
    function destroyChartsWithPrefix(prefix) {
        for (const [id, c] of Array.from(chartRegistry.entries())) {
            if (id.startsWith(prefix)) destroyChartById(id);
        }
    }
    function destroyAllCharts() {
        for (const [id, c] of Array.from(chartRegistry.entries())) destroyChartById(id);
    }

    // ==================== 响应式检测（P2 顺便修一下） ====================
    let isMobile = window.innerWidth <= 768;
    const mql = window.matchMedia('(max-width: 768px)');
    function updateIsMobile() { isMobile = mql.matches; }
    try { mql.addEventListener('change', updateIsMobile); } catch (e) { try { mql.addListener(updateIsMobile); } catch (e2) {} }

    // --- API Endpoints ---
    const NOTIFICATIONS_API = 'https://jy-api.111312.xyz/notifications';
    const MONITORING_PROXY_API = 'https://up-api.111312.xyz/';
    const WEATHER_API = 'https://tq-api.111312.xyz';
    // NAS 数据走本站 Pages Function 内部流转，无需外部 worker 域名
    const NAS_HISTORY_API = '/api/nas/history';
    const NAS_INDEX_API = '/api/nas/index';

    // --- 全局变量 ---
    let monitorDataCache = [];
    let notificationsLoaded = false;
    let weatherLoaded = false;
    let monitoringLoaded = false;
    // P1-5: 每个 Tab 上次成功加载时间戳，超时自动补刷
    const tabLastLoaded = { 'tab-monitoring': 0, 'tab-notifications': 0, 'tab-weather': 0 };
    const TAB_STALE_MS = 10 * 60 * 1000; // 10 分钟视为过期
    // NAS 历史设备选择状态（监控页用）
    let nasSelectedDevices = [];
    let nasHistoryRange = '7d';

    // --- 1. 基础功能 ---
    function updateTime() {
        const now = new Date();
        const timeEl = document.getElementById('current-time');
        const dateEl = document.getElementById('current-date');
        if (timeEl) timeEl.textContent = now.toLocaleTimeString('zh-CN', { hour12: false });
        if (dateEl) dateEl.textContent = `${now.getFullYear()}年${now.getMonth() + 1}月${now.getDate()}日 ${['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'][now.getDay()]}`;
    }
    function countSites() {
        const sites = document.querySelectorAll('.nav-link');
        const siteCountEl = document.getElementById('site-count');
        if (siteCountEl) siteCountEl.textContent = sites.length;
        const yearEl = document.getElementById('footer-year');
        if (yearEl) yearEl.textContent = String(new Date().getFullYear());
    }

    // --- 2. 选项卡切换逻辑 ---
    const iframeTabsLoaded = { 'tab-chat': false, 'tab-voice': false };
    const iframeTabSources = {
        'tab-chat': 'yychat-chat/index.html?v=aacd8f9',
        'tab-voice': 'tmjlchat.html?v=aacd8f9'
    };
    function handleTabs() {
        const tabButtons = document.querySelectorAll('.tab-button');
        const tabContents = document.querySelectorAll('.tab-content');
        tabButtons.forEach(button => {
            button.addEventListener('click', () => {
                tabButtons.forEach(btn => btn.classList.remove('active'));
                tabContents.forEach(content => content.classList.remove('active'));
                button.classList.add('active');
                const tabId = button.getAttribute('data-tab');
                const activeTab = document.getElementById(tabId);
                if (activeTab) activeTab.classList.add('active');
                // 懒加载 iframe 标签页
                if (tabId === 'tab-chat' || tabId === 'tab-voice') {
                    lazyLoadIframeTab(tabId);
                }
                // P1-5: 首次加载 或 距上次成功加载超过 10 分钟则补刷
                const now = Date.now();
                const isStale = now - tabLastLoaded[tabId] > TAB_STALE_MS;
                if (tabId === 'tab-monitoring' && (!monitoringLoaded || isStale)) {
                    initMonitoring(); monitoringLoaded = true;
                }
                if (tabId === 'tab-notifications' && (!notificationsLoaded || isStale)) {
                    fetchNotifications(); notificationsLoaded = true;
                }
                if (tabId === 'tab-weather' && (!weatherLoaded || isStale)) {
                    fetchWeatherData(); weatherLoaded = true;
                }
            });
        });
    }

    function lazyLoadIframeTab(tabId) {
        if (iframeTabsLoaded[tabId]) return;
        const iframeId = tabId === 'tab-chat' ? 'chat-iframe' : 'voice-iframe';
        const loadingId = tabId === 'tab-chat' ? 'chat-loading' : 'voice-loading';
        const iframe = document.getElementById(iframeId);
        const loading = document.getElementById(loadingId);
        if (!iframe || !loading) return;
        const src = iframeTabSources[tabId];
        let done = false;
        const reveal = () => {
            if (done) return;
            done = true;
            loading.classList.add('hidden');
            iframeTabsLoaded[tabId] = true;
        };
        iframe.addEventListener('load', reveal);
        iframe.addEventListener('error', reveal);
        setTimeout(reveal, 15000);
        iframe.src = src;
    }

    // --- 3. 我的通知功能 ---
    function showNotificationStatus(message, type = 'info') {
        const statusEl = document.getElementById('notifications-status-message');
        if (!statusEl) return;
        statusEl.innerHTML = '';
        const div = document.createElement('div');
        div.className = `status-msg ${type}`;
        div.textContent = message;
        statusEl.appendChild(div);
        if (type === 'success') { setTimeout(() => { statusEl.innerHTML = ''; }, 5000); }
    }
    async function fetchNotifications() {
        const listEl = document.getElementById('notifications-list');
        if (!listEl) return;
        listEl.innerHTML = `<div class="loading-state"><div class="loading-spinner"></div><div>正在刷新...</div></div>`;
        try {
            // P1-7: 超时 + 指数退避重试
            const response = await fetchWithRetry(NOTIFICATIONS_API, {}, { timeout: 15000, retries: 3 });
            if (!response.ok) throw new Error(`HTTP错误! 状态码: ${response.status}`);
            const data = await response.json();
            if (data.success === false) throw new Error(`API返回错误: ${data.error || '未知错误'}`);
            listEl.innerHTML = '';
            if (data.notifications && data.notifications.length > 0) {
                const frag = document.createDocumentFragment();
                data.notifications.forEach(item => {
                    const div = document.createElement('div');
                    div.className = 'notification-item';
                    const contentEl = document.createElement('span');
                    contentEl.className = 'notification-content';
                    // P0-2: 纯文本用 textContent，防 XSS
                    contentEl.textContent = item.content || '';
                    const date = new Date(item.timestamp);
                    const timeEl = document.createElement('span');
                    timeEl.className = 'notification-timestamp';
                    timeEl.textContent = date.toLocaleString('zh-CN', { year: '2-digit', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
                    div.appendChild(contentEl);
                    div.appendChild(timeEl);
                    frag.appendChild(div);
                });
                listEl.appendChild(frag);
                showNotificationStatus(`成功加载 ${data.notifications.length} 条通知`, 'success');
                // P1-5: 记录成功加载时间
                tabLastLoaded['tab-notifications'] = Date.now();
            } else {
                const empty = document.createElement('div');
                empty.className = 'empty-state';
                const p = document.createElement('p');
                p.textContent = '暂无通知或短信';
                empty.appendChild(p);
                listEl.appendChild(empty);
                tabLastLoaded['tab-notifications'] = Date.now();
            }
        } catch (error) {
            console.error('获取通知失败:', error);
            listEl.innerHTML = '';
            const err = document.createElement('div');
            err.className = 'error-state';
            const p = document.createElement('p');
            p.textContent = `加载失败: ${error.message}`;
            err.appendChild(p);
            listEl.appendChild(err);
            showNotificationStatus(`加载失败: ${error.message}`, 'error');
        }
    }

    // --- 4. 服务监控功能 ---
    const STATUS_MAP = { 0: { text: '暂停中', class: 'status-warning', icon: 'fa-pause-circle' }, 1: { text: '未检查', class: 'status-warning', icon: 'fa-question-circle' }, 2: { text: '运行中', class: 'status-up', icon: 'fa-check-circle' }, 8: { text: '疑似故障', class: 'status-warning', icon: 'fa-exclamation-circle' }, 9: { text: '服务中断', class: 'status-down', icon: 'fa-times-circle' } };
    function showMonitoringError(message) {
        const container = document.getElementById('tab-monitoring');
        if (!container) return;
        container.innerHTML = '';
        const err = document.createElement('div');
        err.className = 'error-state';
        const h2 = document.createElement('h2');
        h2.textContent = '加载数据失败';
        const p = document.createElement('p');
        p.textContent = message;
        err.appendChild(h2); err.appendChild(p);
        container.appendChild(err);
    }
    async function initMonitoring() {
        const container = document.getElementById('tab-monitoring');
        if (container) container.innerHTML = `<div class="loading-state" id="mon-loading"><div class="loading-spinner"></div><p>正在加载服务监控数据...</p></div>`;
        const hideLoading = () => document.getElementById('mon-loading')?.remove();
        try {
            // NAS 历史：走本站 Pages Function 内部流转（多设备勾选 + 范围切换）
            await loadNasMonitoring();
            // 核心 NAS 区块已渲染，先撤掉 loading，避免一直挂转圈
            hideLoading();
            // UptimeRobot 网站服务监控：仍从 up-api 聚合器取（只取 monitors，失败不影响 NAS 区）
            try {
                const response = await fetchWithRetry(MONITORING_PROXY_API, { method: 'POST', cache: 'no-cache' }, { timeout: 20000, retries: 3 });
                if (!response.ok) throw new Error(`API 请求失败: ${response.status}`);
                const data = await response.json();
                if (data.stat === 'fail') throw new Error(`API 返回错误: ${(data.error || {}).message || '未知'}`);
                renderUptimeMonitoring(data);
            } catch (e) {
                console.error('UptimeRobot 监控获取失败:', e);
            }
            tabLastLoaded['tab-monitoring'] = Date.now();
        } catch (error) {
            console.error('获取监控数据失败:', error);
            hideLoading();
        }
        // 兜底：NAS 与 UptimeRobot 均无内容时给出提示
        const tab = document.getElementById('tab-monitoring');
        if (tab && !tab.querySelector('.nas-section') && !tab.querySelector('#uptime-robot-container') && !tab.querySelector('.error-state')) {
            showMonitoringError('未能加载任何监控数据。');
        }
    }
    function renderUptimeMonitoring(data) {
        const container = document.getElementById('tab-monitoring');
        if (!container) return;
        // P0-1: 重建 uptime 图前销毁旧图
        destroyChartsWithPrefix('mon-');
        const monitors = data.monitors;
        if (!monitors || !monitors.length) return;
        monitorDataCache = monitors;
        let totalUptime = 0;
        monitors.forEach(m => {
            let uptimeRatio = parseFloat(m.custom_uptime_ratios?.split('-')[0]);
            if ((isNaN(uptimeRatio) || uptimeRatio === 0) && m.status === 2) { uptimeRatio = 100.0; }
            else if (isNaN(uptimeRatio)) { uptimeRatio = parseFloat(m.all_time_uptime_ratio) || 0; }
            totalUptime += uptimeRatio;
        });
        // P0-2: friendly_name 等用户可控字符串用 escapeHtml
        const servicesHTML = monitors.map(monitor => {
            const status = STATUS_MAP[monitor.status] || { text: '未知', class: 'status-warning', icon: 'fa-question-circle' };
            return `<div class="service-card" id="monitor-card-${monitor.id}"> <div class="service-card-header" onclick="toggleDetailChart(${monitor.id})"> <div class="service-header"> <div class="service-name">${escapeHtml(monitor.friendly_name)} <i class="fas fa-chevron-down"></i></div> <div class="service-status ${status.class}"><i class="fas ${status.icon}"></i> ${escapeHtml(status.text)}</div> </div> </div> <div class="service-details"> <div class="service-details-content"> <div class="detail-chart-container"><canvas id="detail-chart-${monitor.id}"></canvas></div> </div> </div> </div>`;
        }).join('');
        const uptimeContainer = document.createElement('div');
        uptimeContainer.id = 'uptime-robot-container';
        uptimeContainer.innerHTML = `<h2 class="section-title"><i class="fas fa-network-wired"></i><span>网站服务监控 (UptimeRobot)</span></h2><div class="charts-grid"><div class="summary-card uptime"><div class="card-icon"><i class="fas fa-chart-line"></i></div><div class="card-title">平均正常率 (7天)</div><div class="card-value">${monitors.length > 0 ? (totalUptime / monitors.length).toFixed(2) : '0'}%</div></div><div class="chart-container"><div class="chart-header"><h3 class="chart-title">平均响应时间 (24小时)</h3></div><div class="chart-wrapper"><canvas id="responseTimeChart"></canvas></div></div></div><div class="services-grid" style="margin-top: 30px;"><div id="services-list">${servicesHTML}</div></div>`;
        container.appendChild(uptimeContainer);
        renderOverviewCharts(monitors);
    }

    // ============ NAS 历史（多设备 + 范围切换，服务器内部流转） ============
    const NAS_DEVICE_PALETTE = ['rgb(30,136,229)', 'rgb(76,175,80)', 'rgb(255,152,0)', 'rgb(156,39,176)', 'rgb(244,67,54)', 'rgb(0,172,193)', 'rgb(139,195,74)', 'rgb(121,85,72)'];
    function nasChartRateTick(v) {
        if (v == null || v <= 0) return '0';
        const sizes = ['B/s', 'KB/s', 'MB/s', 'GB/s'];
        const k = 1024; let x = v, i = 0;
        while (x >= k && i < sizes.length - 1) { x /= k; i++; }
        return parseFloat(x.toFixed(1)) + ' ' + sizes[i];
    }
    async function loadNasMonitoring() {
        const container = document.getElementById('tab-monitoring');
        if (!container) return;
        // 每次进入清掉旧 NAS 区块与历史图，避免重复堆叠
        destroyChartsWithPrefix('nas-history-');
        document.getElementById('nas-history-section')?.remove();
        let devices = [];
        try {
            const res = await fetchWithTimeout(NAS_INDEX_API, { cache: 'no-store' }, 15000);
            const data = res.ok ? await res.json() : {};
            devices = (data && Array.isArray(data.devices)) ? data.devices : [];
        } catch (e) { devices = []; }
        if (!nasSelectedDevices.length) nasSelectedDevices = devices.map(d => d.id);
        renderNasHistorySection(devices);
        await fetchNasHistory();
    }
    function renderNasHistorySection(devices) {
        const container = document.getElementById('tab-monitoring');
        if (!container) return;
        const section = document.createElement('div');
        section.id = 'nas-history-section';
        section.className = 'nas-section';
        const cb = devices.map(d => {
            const checked = nasSelectedDevices.includes(d.id) ? ' checked' : '';
            return `<label class="nas-dev-check"><input type="checkbox" data-device="${escapeHtml(d.id)}"${checked}> ${escapeHtml(d.id)}</label>`;
        }).join('') || '<span class="nas-empty-text">暂无可选的 NAS 设备</span>';
        const rangeBtn = (v, label) => `<button class="nas-range-btn${nasHistoryRange === v ? ' active' : ''}" data-range="${v}">${label}</button>`;
        section.innerHTML = `<h2 class="section-title"><i class="fas fa-server"></i><span>NAS 历史趋势</span></h2><div class="nas-toolbar"><div class="nas-dev-checks">${cb}</div><div class="nas-range-group">${rangeBtn('24h', '24小时')}${rangeBtn('7d', '7天')}${rangeBtn('30d', '30天')}</div></div><div class="charts-grid" id="nas-history-charts"></div>`;
        container.appendChild(section);
        section.querySelectorAll('input[type="checkbox"]').forEach(inp => {
            inp.addEventListener('change', () => {
                const id = inp.getAttribute('data-device');
                if (inp.checked) { if (!nasSelectedDevices.includes(id)) nasSelectedDevices.push(id); }
                else nasSelectedDevices = nasSelectedDevices.filter(x => x !== id);
                fetchNasHistory();
            });
        });
        section.querySelectorAll('.nas-range-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                nasHistoryRange = btn.getAttribute('data-range');
                section.querySelectorAll('.nas-range-btn').forEach(b => b.classList.toggle('active', b === btn));
                fetchNasHistory();
            });
        });
    }
    async function fetchNasHistory() {
        if (!nasSelectedDevices.length) { renderNasHistoryChartsFromPoints([], nasHistoryRange); return; }
        const qs = new URLSearchParams({ devices: nasSelectedDevices.join(','), range: nasHistoryRange });
        let points = [];
        try {
            const res = await fetchWithTimeout(NAS_HISTORY_API + '?' + qs.toString(), { cache: 'no-store' }, 20000);
            if (res.ok) { const data = await res.json(); points = (data && data.points) || data.devices || []; }
        } catch (e) { console.error('NAS 历史加载失败:', e); }
        renderNasHistoryChartsFromPoints(points, nasHistoryRange);
    }
    function renderNasHistoryChartsFromPoints(points, range) {
        const chartBox = document.getElementById('nas-history-charts');
        if (!chartBox) return;
        destroyChartsWithPrefix('nas-history-');
        chartBox.innerHTML = '';
        if (!points.length) {
            const d = document.createElement('div');
            d.className = 'nas-empty-text';
            d.textContent = '暂无历史数据（等待采集，或确认 Pages 已绑定 D1 数据库）';
            chartBox.appendChild(d);
            return;
        }
        const byDevice = {};
        for (const p of points) { (byDevice[p.device_id] = byDevice[p.device_id] || []).push(p); }
        const ids = Object.keys(byDevice);
        const timeUnit = range && range.startsWith('24') ? 'hour' : 'day';
        const charts = [
            { key: 'cpu',  title: 'CPU 使用率 (%)', bps: false, begin0: true },
            { key: 'mem',  title: '内存使用 (%)',   bps: false, begin0: false },
            { key: 'up',   title: '上行速率',        bps: true,  begin0: true },
            { key: 'down', title: '下行速率',        bps: true,  begin0: true },
            { key: 'temp', title: '温度 (°C)',       bps: false, begin0: false }
        ];
        charts.forEach((ch, ci) => {
            const datasets = [];
            let has = false;
            ids.forEach((id, di) => {
                const rows = byDevice[id].filter(r => r[ch.key] != null);
                if (!rows.length) return;
                has = true;
                const color = NAS_DEVICE_PALETTE[di % NAS_DEVICE_PALETTE.length];
                datasets.push({
                    label: String(id),
                    data: rows.map(r => ({ x: r.ts * 1000, y: ch.bps ? Math.abs(r[ch.key]) : r[ch.key] })),
                    borderColor: color, backgroundColor: color.replace('rgb', 'rgba').replace(')', ', 0.15)'),
                    borderWidth: 1.5, pointRadius: 0, tension: 0.4, fill: true
                });
            });
            if (!has) return;
            const w = document.createElement('div');
            w.className = 'chart-container';
            w.innerHTML = `<div class="chart-header"><h3 class="chart-title">${ch.title}</h3></div><div class="nas-chart-wrapper"><canvas id="nas-history-canvas-${ci}"></canvas></div>`;
            chartBox.appendChild(w);
            const ctx = w.querySelector('canvas')?.getContext('2d');
            if (!ctx) return;
            const yTicks = ch.bps ? { font: { size: 10 }, callback: v => nasChartRateTick(v) } : { font: { size: 10 } };
            const c = new Chart(ctx, { type: 'line', data: { datasets }, options: {
                responsive: true, maintainAspectRatio: false,
                scales: {
                    x: { type: 'time', time: { unit: timeUnit }, ticks: { font: { size: 10 } } },
                    y: { beginAtZero: ch.begin0, ticks: yTicks }
                },
                plugins: { legend: { display: ids.length > 1, labels: { font: { size: 10 }, boxWidth: 10, boxHeight: 10 } }, tooltip: { enabled: !isMobile, mode: 'x', intersect: false } }
            } });
            registerChart(`nas-history-${ci}`, c);
        });
    }
    window.toggleDetailChart = function(monitorId) {
        const card = document.getElementById(`monitor-card-${monitorId}`);
        if (!card) return;
        const isExpanded = card.classList.toggle('expanded');
        if (isExpanded) {
            const monitor = monitorDataCache.find(m => m.id === monitorId);
            if (monitor && monitor.response_times) createDetailChart(monitor);
        } else {
            // 收起时销毁对应图表，省内存
            destroyChartById(`mon-detail-${monitorId}`);
        }
    };
    function createDetailChart(monitor) {
        const chartId = `mon-detail-${monitor.id}`;
        const canvasId = `detail-chart-${monitor.id}`;
        const ctx = document.getElementById(canvasId)?.getContext('2d');
        if (!ctx) return;
        destroyChartById(chartId);
        const chartData = monitor.response_times.map(rt => ({ x: rt.datetime * 1000, y: rt.value })).reverse();
        const c = new Chart(ctx, { type: 'line', data: { datasets: [{ label: '响应时间 (ms)', data: chartData, borderColor: 'rgba(30, 136, 229, 0.5)', backgroundColor: 'rgba(30, 136, 229, 0.1)', borderWidth: 1, tension: 0.3, fill: true, pointRadius: 0 }] }, options: { responsive: true, maintainAspectRatio: false, scales: { x: { type: 'time', time: { unit: 'hour' }, ticks: { font: { size: 10 } } }, y: { beginAtZero: true, ticks: { font: { size: 10 } } } }, plugins: { legend: { display: false }, tooltip: { enabled: !isMobile, mode: 'x', intersect: false } } } });
        registerChart(chartId, c);
    }
    function renderOverviewCharts(monitors) {
        const rtCtx = document.getElementById('responseTimeChart')?.getContext('2d');
        if (rtCtx) {
            destroyChartById('mon-overview-rt');
            const c = new Chart(rtCtx, { type: 'bar', data: { labels: monitors.map(m => {
                const name = m.friendly_name || '';
                const max = isMobile ? 5 : 12;
                return name.substring(0, max) + (name.length > max ? '...' : '');
            }), datasets: [{ label: '响应时间 (ms)', data: monitors.map(m => m.average_response_time || 0), backgroundColor: 'rgba(30, 136, 229, 0.7)' }] }, options: { responsive: true, maintainAspectRatio: false, scales: { x: { ticks: { font: { size: 10 } } }, y: { beginAtZero: true, ticks: { font: { size: 10 } } } }, plugins: { legend: { display: false }, tooltip: { enabled: !isMobile, mode: 'x', intersect: false } } } });
            registerChart('mon-overview-rt', c);
        }
    }
    
    // --- 5. 天气仪表盘功能 ---
    const sourceStyles = { 'HefengAPI': { label: 'API', tempColor: 'rgb(255, 99, 132)', humidColor: 'rgb(255, 159, 64)' }, 'ESP8266':   { label: '设备', tempColor: 'rgb(54, 162, 235)', humidColor: 'rgb(75, 192, 192)' }, 'default':   { label: '其他', tempColor: 'rgb(201, 203, 207)', humidColor: 'rgb(153, 102, 255)' } };
    async function fetchWeatherData() {
        const loadingMessage = document.getElementById('weather-loading-message');
        const cardsContainer = document.getElementById('latest-weather-cards');
        const chartsContainer = document.getElementById('weather-charts-container');
        try {
            // P1-7: 超时 + 指数退避重试
            const response = await fetchWithRetry(WEATHER_API, {}, { timeout: 15000, retries: 3 });
            if (!response.ok) throw new Error(`无法从 Worker 获取数据，状态码: ${response.status}`);
            const data = await response.json();
            if (loadingMessage) loadingMessage.style.display = 'none';
            if (cardsContainer) cardsContainer.style.display = 'flex';
            if (chartsContainer) chartsContainer.style.display = 'flex';
            displayLatestWeather(data.latest);
            displayTrendCharts(data.history);
            tabLastLoaded['tab-weather'] = Date.now();
        } catch (error) {
            console.error('加载天气数据时发生错误:', error);
            if (loadingMessage) {
                loadingMessage.innerHTML = '';
                const err = document.createElement('div');
                err.className = 'error-state';
                const h2 = document.createElement('h2');
                h2.textContent = '加载天气数据失败';
                const p = document.createElement('p');
                p.textContent = error.message;
                err.appendChild(h2); err.appendChild(p);
                loadingMessage.appendChild(err);
            }
        }
    }
    function displayLatestWeather(latestData) {
        const container = document.getElementById('latest-weather-cards');
        if (!container) return;
        container.innerHTML = '';
        if (!latestData || latestData.length === 0) {
            const p = document.createElement('p');
            p.textContent = '暂无最新的天气数据。';
            container.appendChild(p);
            return;
        }
        const frag = document.createDocumentFragment();
        for (const cityData of latestData) {
            const card = document.createElement('div');
            card.className = 'weather-card';
            const h2 = document.createElement('h2');
            h2.textContent = cityData.city_name || '';
            const pWeather = document.createElement('p');
            pWeather.className = 'weather-text';
            pWeather.textContent = cityData.weather_text || '';
            const pTemp = document.createElement('p');
            const s1 = document.createElement('strong');
            s1.textContent = '温度:';
            pTemp.appendChild(s1);
            pTemp.appendChild(document.createTextNode(` ${cityData.temperature}°C (体感 ${cityData.feels_like}°C)`));
            const pHumid = document.createElement('p');
            const s2 = document.createElement('strong');
            s2.textContent = '相对湿度:';
            pHumid.appendChild(s2);
            pHumid.appendChild(document.createTextNode(` ${cityData.humidity}%`));
            const pTime = document.createElement('p');
            pTime.className = 'timestamp';
            pTime.textContent = `更新于: ${new Date(cityData.observation_time).toLocaleString()}`;
            card.appendChild(h2);
            card.appendChild(pWeather);
            card.appendChild(pTemp);
            card.appendChild(pHumid);
            card.appendChild(pTime);
            frag.appendChild(card);
        }
        container.appendChild(frag);
    }
    function displayTrendCharts(historyData) {
        const container = document.getElementById('weather-charts-container');
        if (!container) return;
        // P0-1: 每次重建前销毁所有天气图表
        destroyChartsWithPrefix('weather-');
        container.innerHTML = '';
        if (!historyData || historyData.length === 0) return;
        const cities = {};
        for (const record of historyData) { if (!cities[record.city_name]) cities[record.city_name] = []; cities[record.city_name].push(record); }
        for (const cityName in cities) {
            const chartContainer = document.createElement('div');
            chartContainer.className = 'weather-chart-container';
            const canvas = document.createElement('canvas');
            chartContainer.appendChild(canvas);
            container.appendChild(chartContainer);
            const datasets = [];
            const cityHistory = cities[cityName];
            const sources = {};
            for (const record of cityHistory) { if (!sources[record.source]) sources[record.source] = []; sources[record.source].push(record); }
            for (const sourceName in sources) {
                const style = sourceStyles[sourceName] || sourceStyles.default;
                const sourceData = sources[sourceName];
                datasets.push({ label: `温度 - ${style.label}`, data: sourceData.map(d => ({ x: new Date(d.observation_time), y: d.temperature })), borderColor: style.tempColor, backgroundColor: style.tempColor.replace('rgb', 'rgba').replace(')', ', 0.5)'), yAxisID: 'y', tension: 0.1, borderWidth: 1.5, pointRadius: 0 });
                datasets.push({ label: `湿度 - ${style.label}`, data: sourceData.map(d => ({ x: new Date(d.observation_time), y: d.humidity })), borderColor: style.humidColor, backgroundColor: style.humidColor.replace('rgb', 'rgba').replace(')', ', 0.5)'), yAxisID: 'y1', borderDash: [5, 5], tension: 0.1, borderWidth: 1.5, pointRadius: 0 });
            }
            // P0-1: 用城市名做唯一 id，注册到注册表
            const chartId = `weather-${cityName}`;
            const c = new Chart(canvas, { type: 'line', data: { datasets: datasets }, options: { responsive: true, interaction: { mode: 'x', intersect: false, }, plugins: { title: { display: true, text: `${cityName} - 24小时趋势`, font: { size: isMobile ? 14 : 18 } }, legend: { display: !isMobile, position: 'bottom', labels: { font: { size: 10 }, boxWidth: 10, boxHeight: 10 } } } }, scales: { x: { type: 'time', time: { unit: 'hour', tooltipFormat: 'HH:mm', displayFormats: { hour: 'HH:mm' } }, title: { display: false }, ticks: { font: { size: 10 } } }, y: { type: 'linear', display: true, position: 'left', title: { display: !isMobile, text: '温度 (°C)' }, ticks: { font: { size: 10 } } }, y1: { type: 'linear', display: true, position: 'right', title: { display: !isMobile, text: '湿度 (%)' }, grid: { drawOnChartArea: false }, ticks: { font: { size: 10 } } } } } });
            registerChart(chartId, c);
        }
    }

    // --- 6. NAS 实时动态监控模块 (顶部) ---
    function initNasModule() {
        // 数据来自服务器端 KV 快照（/api/nas/realtime），不再在前端直接抓取 metrics
        const NAS_API = {
            index: '/api/nas/index',
            realtime: '/api/nas/realtime',
            history: '/api/nas/history',
            probe: '/api/nas/probe',
            register: '/api/nas/register',
            unregister: '/api/nas/unregister'
        };
        const NAS_POLL_INTERVAL = 5000;     // 前台 5s：probe 即时抓源，前端差分算速率/CPU
        const NAS_POLL_BACKGROUND = 60000;  // 后台/隐藏 60s：改读 KV 快照，省资源
        const originalTitle = document.title;

        let realtimeTimer = null;
        let currentPollInterval = NAS_POLL_INTERVAL;
        let nasDevices = [];                 // [{device_id,url,ts,cpu,mem,up,down,temp,fs}]
        let totalSpeeds = { up: 0, down: 0 };
        let probeLast = {};                  // device_id -> { ts, bootTime, cpuIdle, cpuTotal, netRecv, netSent }
        let usingProbe = true;               // 前台=true 用 probe，后台=false 用 realtime

        // ============ NAS 格式工具（实时卡片/标题用） ============
        function nas_formatSize(bytes, sizes, decimals = 1) {
            if (bytes == null || bytes <= 0) return sizes[0] === 'B' ? `0 ${sizes[0]}` : `0 ${sizes[1]}`;
            const k = 1024;
            let v = bytes, i = 0;
            while (v >= k && i < sizes.length - 1) { v /= k; i++; }
            return `${parseFloat(v.toFixed(decimals))} ${sizes[i]}`;
        }
        function nas_formatSpeed(bytesPerSecond, decimals = 2) { return nas_formatSize(bytesPerSecond, ['B/s','KB/s','MB/s','GB/s'], decimals); }

        // ============ 顶部实时卡片 ============
        async function fetchRealtime() {
            const res = await fetchWithTimeout(NAS_API.realtime, { cache: 'no-store' }, 15000);
            if (!res.ok) throw new Error(`realtime ${res.status}`);
            const data = await res.json();
            return (data && Array.isArray(data.devices)) ? data.devices : [];
        }
        function deviceLabel(dev) {
            if (dev.device_id) return dev.device_id;
            try { return new URL(dev.url).hostname; } catch (e) { return dev.url || '设备'; }
        }
        function createNasCardHtml(dev) {
            const label = escapeHtml(deviceLabel(dev));
            const tempTile = (dev.temp != null)
                ? `<div class="nas-metric-card"><div class="nas-metric-icon"><i class="fas fa-thermometer-half"></i></div><div class="nas-metric-details"><span class="nas-metric-label">温度</span><div class="nas-metric-value">${Number(dev.temp).toFixed(1)}°C</div></div></div>`
                : '';
            const fsPct = (dev.fs && dev.fs.total > 0) ? ((dev.fs.total - dev.fs.avail) / dev.fs.total * 100) : null;
            const fsTile = (fsPct != null)
                ? `<div class="nas-metric-card"><div class="nas-metric-icon"><i class="fas fa-hdd"></i></div><div class="nas-metric-details"><span class="nas-metric-label">存储</span><div class="nas-metric-value">${fsPct.toFixed(1)}%</div></div></div>`
                : '';
            return `<div class="nas-card-container" data-device="${escapeHtml(dev.device_id||'')}" data-url="${escapeHtml(dev.url||'')}"> <div class="nas-card-header"><span class="nas-card-title">${label}</span><span class="nas-card-updated">${dev.ts?('更新: '+new Date(dev.ts*1000).toLocaleTimeString()):'等待数据...'}</span></div> <div class="nas-card-grid"> <div class="nas-metric-card"><div class="nas-metric-icon"><i class="fas fa-microchip"></i></div><div class="nas-metric-details"><span class="nas-metric-label">CPU</span><div class="nas-metric-value">${dev.cpu==null?'--':Number(dev.cpu).toFixed(1)+'%'}</div></div></div> <div class="nas-metric-card"><div class="nas-metric-icon"><i class="fas fa-memory"></i></div><div class="nas-metric-details"><span class="nas-metric-label">内存</span><div class="nas-metric-value">${dev.mem==null?'--':Number(dev.mem).toFixed(1)+'%'}</div></div></div> ${tempTile} ${fsTile} <div class="nas-metric-card"><div class="nas-metric-icon"><i class="fas fa-exchange-alt"></i></div><div class="nas-metric-details"><span class="nas-metric-label">上传/下载</span><div class="nas-metric-value small-font">${nas_formatSpeed(dev.up||0)} / ${nas_formatSpeed(dev.down||0)}</div></div></div> </div> </div>`;
        }
        function renderRealtimeCards() {
            const container = document.getElementById('nas-grid-container');
            if (!container) return;
            container.innerHTML = nasDevices.length
                ? nasDevices.map(createNasCardHtml).join('')
                : `<div style="padding:20px;text-align:center;color:var(--text-secondary);">暂无 NAS 数据，点击右上角 <i class="fas fa-cog"></i> 在设置里添加 metrics 链接</div>`;
        }
        function updatePageTitle() {
            if (document.hidden) return;
            document.title = `↑${nas_formatSpeed(totalSpeeds.up,1)} / ↓${nas_formatSpeed(totalSpeeds.down,1)} | ${originalTitle}`;
        }
        // 前台 probe：即时抓源 + 前端差分算速率/CPU，不写 DB
        async function updateViaProbe() {
            try {
                const res = await fetchWithTimeout(NAS_API.probe, { cache: 'no-store' }, 15000);
                if (!res.ok) throw new Error(`probe ${res.status}`);
                const data = await res.json();
                const devices = (data && Array.isArray(data.devices)) ? data.devices : [];

                const merged = devices.map(dev => {
                    const prev = probeLast[dev.device_id];
                    let cpuPct = null, upSpeed = 0, downSpeed = 0;

                    if (prev && dev.bootTime === prev.bootTime) {
                        const dt = dev.ts - prev.ts;
                        if (dt > 0) {
                            if (dev.cpu.idleValid && prev.cpuIdle > 0 && dev.cpu.total > prev.cpuTotal) {
                                const idleDiff = dev.cpu.idle - prev.cpuIdle;
                                const totalDiff = dev.cpu.total - prev.cpuTotal;
                                if (totalDiff > 0) cpuPct = Math.max(0, Math.min(100, 100 * (1 - idleDiff / totalDiff)));
                            }
                            try {
                                const recvNew = BigInt(dev.net.recv), recvOld = BigInt(prev.netRecv);
                                if (recvNew >= recvOld) downSpeed = Number(recvNew - recvOld) / dt;
                            } catch(e) {}
                            try {
                                const sentNew = BigInt(dev.net.sent), sentOld = BigInt(prev.netSent);
                                if (sentNew >= sentOld) upSpeed = Number(sentNew - sentOld) / dt;
                            } catch(e) {}
                        }
                    }

                    probeLast[dev.device_id] = {
                        ts: dev.ts,
                        bootTime: dev.bootTime,
                        cpuIdle: dev.cpu.idle,
                        cpuTotal: dev.cpu.total,
                        netRecv: dev.net.recv,
                        netSent: dev.net.sent,
                    };

                    return {
                        device_id: dev.device_id,
                        url: dev.url,
                        ts: dev.ts,
                        cpu: cpuPct != null ? Math.round(cpuPct * 10) / 10 : null,
                        mem: dev.mem,
                        memTotal: dev.memTotal || 0,
                        up: Math.round(upSpeed),
                        down: Math.round(downSpeed),
                        temp: dev.temp,
                        fs: dev.fs || null,
                    };
                });

                nasDevices = merged;
                renderRealtimeCards();
                totalSpeeds = { up: 0, down: 0 };
                merged.forEach(d => { totalSpeeds.up += d.up || 0; totalSpeeds.down += d.down || 0; });
                updatePageTitle();
            } catch (e) {
                if (e.name === 'AbortError') return;
                console.error('NAS probe 刷新失败:', e);
            }
        }
        // 后台 snapshot：读 KV 快照（已有速率，零计算）
        async function updateViaSnapshot() {
            try {
                const devs = await fetchRealtime();
                nasDevices = devs;
                renderRealtimeCards();
                totalSpeeds = { up: 0, down: 0 };
                devs.forEach(d => { totalSpeeds.up += d.up || 0; totalSpeeds.down += d.down || 0; });
                updatePageTitle();
            } catch (e) {
                if (e.name === 'AbortError') return;
                console.error('NAS 实时刷新失败:', e);
            }
        }
        function startRealtime() {
            if (realtimeTimer) clearInterval(realtimeTimer);
            const fn = usingProbe ? updateViaProbe : updateViaSnapshot;
            fn();
            realtimeTimer = setInterval(fn, currentPollInterval);
        }
        // 页面可见性变化：前台用 probe(5s)，后台用 snapshot(60s)
        function onVisibilityChange() {
            if (document.hidden) {
                if (document.title !== originalTitle) document.title = originalTitle;
                if (usingProbe || currentPollInterval !== NAS_POLL_BACKGROUND) {
                    usingProbe = false;
                    currentPollInterval = NAS_POLL_BACKGROUND;
                    startRealtime();
                }
            } else {
                if (!usingProbe || currentPollInterval !== NAS_POLL_INTERVAL) {
                    usingProbe = true;
                    currentPollInterval = NAS_POLL_INTERVAL;
                    startRealtime();
                } else updatePageTitle();
            }
        }
        document.addEventListener('visibilitychange', onVisibilityChange);

        // ============ 设置弹窗：设备注册/注销（写入服务器 KV） ============
        async function postJson(url, body) {
            try {
                const res = await fetchWithTimeout(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }, 15000);
                return await res.json().catch(() => ({}));
            } catch (e) { return { ok: false, error: e.message }; }
        }
        async function loadDeviceList() {
            try {
                const res = await fetchWithTimeout(NAS_API.index, { cache: 'no-store' }, 15000);
                const data = res.ok ? await res.json() : {};
                return (data && Array.isArray(data.devices)) ? data.devices : [];
            } catch (e) { return []; }
        }
        async function renderUrlListInModal() {
            const listContainer = document.getElementById('nas-url-list');
            if (!listContainer) return;
            listContainer.innerHTML = '';
            const devices = await loadDeviceList();
            if (!devices.length) {
                listContainer.textContent = '（暂无设备，可在下方添加 metrics 链接）';
                return;
            }
            const frag = document.createDocumentFragment();
            devices.forEach((dev) => {
                const item = document.createElement('div');
                item.className = 'nas-url-item';
                const span = document.createElement('span');
                span.setAttribute('title', dev.url || '');
                span.textContent = `${dev.id}  ${dev.url || ''}`;
                const btn = document.createElement('button');
                btn.className = 'delete-nas-button';
                btn.setAttribute('data-device', dev.id);
                btn.textContent = '删除';
                item.appendChild(span); item.appendChild(btn);
                frag.appendChild(item);
            });
            listContainer.appendChild(frag);
        }
        function setupSettingsModal() {
            const icon = document.getElementById('settings-icon');
            const overlay = document.getElementById('settings-modal-overlay');
            const closeButton = document.getElementById('settings-close-button');
            const addButton = document.getElementById('add-nas-button');
            const urlInput = document.getElementById('new-nas-url');
            const urlListContainer = document.getElementById('nas-url-list');
            if (!icon || !overlay || !closeButton || !addButton || !urlInput || !urlListContainer) return;
            const openModal = () => { renderUrlListInModal(); overlay.style.display = 'flex'; };
            const closeModal = () => { overlay.style.display = 'none'; };
            icon.addEventListener('click', openModal);
            closeButton.addEventListener('click', closeModal);
            overlay.addEventListener('click', (e) => { if (e.target === overlay) closeModal(); });
            addButton.addEventListener('click', async () => {
                const newUrl = urlInput.value.trim();
                if (!newUrl) return;
                const r = await postJson(NAS_API.register, { url: newUrl });
                if (r.ok) {
                    urlInput.value = '';
                    renderUrlListInModal();
                    usingProbe ? updateViaProbe() : updateViaSnapshot();
                    if (typeof loadNasMonitoring === 'function') loadNasMonitoring();
                } else {
                    alert('登记失败: ' + (r.error || '未知错误'));
                }
            });
            urlListContainer.addEventListener('click', async (e) => {
                const btn = e.target.closest('.delete-nas-button');
                if (!btn) return;
                const deviceId = btn.getAttribute('data-device');
                await postJson(NAS_API.unregister, { device_id: deviceId });
                renderUrlListInModal();
                usingProbe ? updateViaProbe() : updateViaSnapshot();
                if (typeof loadNasMonitoring === 'function') loadNasMonitoring();
            });
        }

        startRealtime();
        setupSettingsModal();
    }

    // --- 主应用初始化 ---
    function initialize() {
        updateTime();
        setInterval(updateTime, 1000);
        countSites();
        handleTabs();
        initNasModule();
        const refreshBtn = document.getElementById('refresh-notifications-btn');
        if (refreshBtn) refreshBtn.addEventListener('click', fetchNotifications);
    }

    initialize();
});
