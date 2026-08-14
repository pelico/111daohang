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
    const NAS_WORKER_URL = 'https://nas-hook.111312.xyz/';

    // --- 全局变量 ---
    let monitorDataCache = [];
    let notificationsLoaded = false;
    let weatherLoaded = false;
    let monitoringLoaded = false;
    // P1-5: 每个 Tab 上次成功加载时间戳，超时自动补刷
    const tabLastLoaded = { 'tab-monitoring': 0, 'tab-notifications': 0, 'tab-weather': 0 };
    const TAB_STALE_MS = 10 * 60 * 1000; // 10 分钟视为过期
    let nasCpuHistoryChart, nasNetworkHistoryChart, nasTempHistoryChart;
    // P0-3: NAS 轮询 abort 集合
    let nasFetchAbortController = null;

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
        'tab-chat': 'yychat-chat/index.html',
        'tab-voice': 'tmjlchat.html'
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
        iframe.addEventListener('load', function onLoad() {
            iframe.removeEventListener('load', onLoad);
            loading.style.display = 'none';
            iframe.style.display = 'block';
            iframeTabsLoaded[tabId] = true;
        });
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
        if (container) container.innerHTML = `<div class="loading-state"><div class="loading-spinner"></div><p>正在加载服务监控数据...</p></div>`;
        try {
            // P1-7: 超时 + 指数退避重试
            const response = await fetchWithRetry(MONITORING_PROXY_API, { method: 'POST', cache: 'no-cache' }, { timeout: 20000, retries: 3 });
            if (!response.ok) throw new Error(`API 请求失败: ${response.status}`);
            const data = await response.json();
            if (data.stat === 'fail') throw new Error(`API 返回错误: ${(data.error || {}).message || '未知'}`);
            renderCombinedMonitoringPage(data);
            tabLastLoaded['tab-monitoring'] = Date.now();
        } catch (error) {
            console.error('获取监控数据失败:', error);
            showMonitoringError(error.message);
        }
    }
    function renderCombinedMonitoringPage(data) {
        const container = document.getElementById('tab-monitoring');
        if (!container) return;
        // P0-1: 重建 DOM 前，先销毁此 Tab 下所有旧图表实例
        destroyChartsWithPrefix('mon-');
        destroyChartsWithPrefix('nas-history-');
        container.innerHTML = '';
        const hasNasHistory = data.nas_history && (data.nas_history.cpu?.length > 0 || data.nas_history.network?.total?.length > 0 || data.nas_history.temp?.length > 0);
        const hasMonitors = data.monitors && data.monitors.length > 0;
        if (!hasNasHistory && !hasMonitors) { showMonitoringError("未能加载任何监控数据。"); return; }
        if (hasNasHistory) {
            const nasSection = document.createElement('div');
            nasSection.className = 'nas-section';
            nasSection.innerHTML = `<h2 class="section-title"><i class="fas fa-server"></i><span>NAS 历史趋势 (7天)</span></h2><div class="charts-grid"><div class="chart-container"><div class="chart-header"><h3 class="chart-title">CPU 使用率</h3></div><div class="nas-chart-wrapper"><canvas id="nasCpuHistoryChart"></canvas></div></div><div class="chart-container"><div class="chart-header"><h3 class="chart-title">网络总流量</h3></div><div class="nas-chart-wrapper"><canvas id="nasNetworkHistoryChart"></canvas></div></div><div class="chart-container" id="nas-temp-history-chart-container" style="display: none;"><div class="chart-header"><h3 class="chart-title">温度变化</h3></div><div class="nas-chart-wrapper"><canvas id="nasTempHistoryChart"></canvas></div></div></div>`;
            container.appendChild(nasSection);
            renderNasHistoryCharts(data.nas_history);
        }
        if (hasMonitors) {
            const monitors = data.monitors;
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
    }
    function renderNasHistoryCharts(history) {
        destroyChartById('nas-history-cpu');
        destroyChartById('nas-history-net');
        destroyChartById('nas-history-temp');
        if (nasCpuHistoryChart) { try { nasCpuHistoryChart.destroy(); } catch (e) {} nasCpuHistoryChart = null; }
        if (nasNetworkHistoryChart) { try { nasNetworkHistoryChart.destroy(); } catch (e) {} nasNetworkHistoryChart = null; }
        if (nasTempHistoryChart) { try { nasTempHistoryChart.destroy(); } catch (e) {} nasTempHistoryChart = null; }
        const cpuCtx = document.getElementById('nasCpuHistoryChart')?.getContext('2d');
        if (cpuCtx && history.cpu && history.cpu.length > 0) {
            nasCpuHistoryChart = new Chart(cpuCtx, { type: 'line', data: { datasets: [{ label: 'CPU Usage (%)', data: history.cpu.map(d => ({x: d.timestamp * 1000, y: d.usage})), borderColor: 'rgba(30, 136, 229, 0.7)', backgroundColor: 'rgba(30, 136, 229, 0.1)', borderWidth: 1.5, pointRadius: 0, tension: 0.4, fill: true }] }, options: { responsive: true, maintainAspectRatio: false, scales: { x: { type: 'time', time: { unit: 'day' }, ticks: { font: { size: 10 } } }, y: { beginAtZero: true, max: 100, ticks: { font: { size: 10 } } } }, plugins: { legend: { display: false }, tooltip: { enabled: !isMobile, mode: 'x', intersect: false } } } });
            registerChart('nas-history-cpu', nasCpuHistoryChart);
        }
        const netCtx = document.getElementById('nasNetworkHistoryChart')?.getContext('2d');
        if (netCtx && history.network) {
            const datasets = [];
            if (history.network.total && history.network.total.length > 0) {
                datasets.push({ label: '总接收 (GB)', data: history.network.total.map(d => ({ x: d.timestamp * 1000, y: d.total_recv / 1024**3 })), borderColor: 'rgba(76, 175, 80, 0.7)', fill: false, borderWidth: 1.5, pointRadius: 0, tension: 0.4 });
                datasets.push({ label: '总发送 (GB)', data: history.network.total.map(d => ({ x: d.timestamp * 1000, y: d.total_sent / 1024**3 })), borderColor: 'rgba(255, 152, 0, 0.7)', fill: false, borderWidth: 1.5, pointRadius: 0, tension: 0.4 });
            }
            if (history.network.docker && history.network.docker.length > 0) {
                 datasets.push({ label: 'Docker 接收 (GB)', data: history.network.docker.map(d => ({ x: d.timestamp * 1000, y: d.total_recv / 1024**3 })), borderColor: 'rgba(156, 39, 176, 0.7)', fill: false, borderWidth: 1.5, pointRadius: 0, tension: 0.4, borderDash: [5, 5] });
                 datasets.push({ label: 'Docker 发送 (GB)', data: history.network.docker.map(d => ({ x: d.timestamp * 1000, y: d.total_sent / 1024**3 })), borderColor: 'rgba(8, 14, 153, 0.7)', fill: false, borderWidth: 1.5, pointRadius: 0, tension: 0.4, borderDash: [5, 5] });
            }
            if (datasets.length > 0) {
                nasNetworkHistoryChart = new Chart(netCtx, { type: 'line', data: { datasets: datasets }, options: { responsive: true, maintainAspectRatio: false, scales: { x: { type: 'time', time: { unit: 'day' }, ticks: { font: { size: 10 } } }, y: { beginAtZero: true, title: { display: !isMobile, text: 'GB' }, ticks: { font: { size: 10 } } } }, plugins: { legend: { display: !isMobile, position: 'bottom', labels: { font: { size: 10 } } }, tooltip: { enabled: !isMobile, mode: 'x', intersect: false } } } });
                registerChart('nas-history-net', nasNetworkHistoryChart);
            }
        }
        if (history.temp && history.temp.length > 0) {
            const tempContainer = document.getElementById('nas-temp-history-chart-container');
            if (tempContainer) tempContainer.style.display = 'block';
            const tempCtx = document.getElementById('nasTempHistoryChart')?.getContext('2d');
            if(tempCtx) {
                nasTempHistoryChart = new Chart(tempCtx, { type: 'line', data: { datasets: [{ label: '温度 (°C)', data: history.temp.map(d => ({ x: d.timestamp * 1000, y: d.temperature })), borderColor: 'rgba(244, 67, 54, 0.7)', backgroundColor: 'rgba(244, 67, 54, 0.1)', borderWidth: 1.5, pointRadius: 0, tension: 0.4, fill: true }] }, options: { responsive: true, maintainAspectRatio: false, scales: { x: { type: 'time', time: { unit: 'day' }, ticks: { font: { size: 10 } } }, y: { beginAtZero: false, title: { display: !isMobile, text: '°C' }, ticks: { font: { size: 10 } } } }, plugins: { legend: { display: false }, tooltip: { enabled: !isMobile, mode: 'x', intersect: false } } } });
                registerChart('nas-history-temp', nasTempHistoryChart);
            }
        }
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
            const c = new Chart(canvas, { type: 'line', data: { datasets: datasets }, options: { responsive: true, interaction: { mode: 'x', intersect: false, }, plugins: { title: { display: true, text: `${cityName} - 24小时趋势`, font: { size: isMobile ? 14 : 18 } }, legend: { display: !isMobile, position: 'bottom', labels: { font: { size: 10 } } } }, scales: { x: { type: 'time', time: { unit: 'hour', tooltipFormat: 'HH:mm', displayFormats: { hour: 'HH:mm' } }, title: { display: false }, ticks: { font: { size: 10 } } }, y: { type: 'linear', display: true, position: 'left', title: { display: !isMobile, text: '温度 (°C)' }, ticks: { font: { size: 10 } } }, y1: { type: 'linear', display: true, position: 'right', title: { display: !isMobile, text: '湿度 (%)' }, grid: { drawOnChartArea: false }, ticks: { font: { size: 10 } } } } } });
            registerChart(chartId, c);
        }
    }

    // --- 6. NAS 实时动态监控模块 (顶部) ---
    function initNasModule() {
        // 每次修改 DEFAULT_NAS_URLS 时，请将 NAS_URLS_VERSION +1
        // 这样用户浏览器会自动检测到更新并合并新的默认 URL
        const NAS_URLS_VERSION = 1;
        const DEFAULT_NAS_URLS = [
            'https://nas-api.111312.xyz/metrics',
            'https://wkyapi.111312.xyz/metrics',
            'https://macapi.111312.xyz/metrics'
        ];

        // P0-3 / P1-6: 预编译正则（热路径不重复编译）
        const RE_MODE = /mode="([^"]+)"/;
        const RE_DEVICE = /device="([^"]+)"/;
        const RE_MOUNT = /mountpoint="([^"]+)"/;
        const RE_LINESTART = /^node_(cpu_seconds_total|memory_MemTotal_bytes|memory_MemAvailable_bytes|network_receive_bytes_total|network_transmit_bytes_total|boot_time_seconds|thermal_zone_temp|hwmon_temp_input|filesystem_size_bytes|filesystem_avail_bytes)/;
        const IGNORED_IFACE = /^(lo|veth|docker0|tailscale0)/;

        const NAS_CONCURRENT_LIMIT = 3;      // 最多同时 3 个 NAS 请求
        const NAS_FETCH_TIMEOUT = 15000;     // 单次请求 15s 超时
        const NAS_POLL_INTERVAL = 10000;     // 前台 10s
        const NAS_POLL_BACKGROUND = 60000;   // 后台 60s（P1-6）
        const NAS_UPTIME_INTERVAL = 60000;   // P1-4: 60s 更新一次运行时间（分钟级显示）

        let nasInstances = {};                // url -> { 状态数据 + elements: {... 缓存的 DOM 引用 } }
        let nasUrlList = [];
        let updateInterval = null;
        let uptimeInterval = null;
        let totalSpeeds = { up: 0, down: 0 };
        const originalTitle = document.title;
        // P1-6: 可见性状态
        let currentPollInterval = NAS_POLL_INTERVAL;

        // ============ NAS 专用工具 ============
        function nas_formatSize(bytes, sizes, decimals = 1) {
            // 合并 formatBytes / formatSpeed，避免重复 + 去掉 Math.log 边界问题
            if (bytes == null || bytes <= 0) return sizes[0] === 'B' ? `0 ${sizes[0]}` : `0 ${sizes[1]}`;
            const k = 1024;
            let v = bytes, i = 0;
            while (v >= k && i < sizes.length - 1) { v /= k; i++; }
            return `${parseFloat(v.toFixed(decimals))} ${sizes[i]}`;
        }
        function nas_formatBytes(bytes, decimals = 1) { return nas_formatSize(bytes, ['B','KB','MB','GB','TB'], decimals); }
        function nas_formatSpeed(bytesPerSecond, decimals = 2) { return nas_formatSize(bytesPerSecond, ['B/s','KB/s','MB/s','GB/s'], decimals); }
        function nas_formatUptime(seconds) {
            if (!seconds || seconds <= 0) return '--';
            seconds = Math.floor(seconds);
            const d = Math.floor(seconds / 86400);
            const h = Math.floor(seconds % 86400 / 3600);
            const m = Math.floor(seconds % 3600 / 60);
            return `${d}天 ${h}小时 ${m}分钟`;
        }

        // P0-3: parseNasRealtimeMetrics 优化：预编译正则 + indexOf 快速过滤
        function parseNasRealtimeMetrics(text) {
            const metrics = { cpu: { total: 0, idle: 0 }, memory: { total: 0, available: 0 }, network: { received: 0, transmitted: 0 }, bootTime: 0, temp: null, filesystems: {} };
            let primaryInterface = null;
            const networkData = {};
            const targetMountpoint = '/etc/hostname';
            const lines = text.split('\n');
            for (let i = 0; i < lines.length; i++) {
                const line = lines[i];
                if (line.length === 0 || line.charCodeAt(0) === 35 /* # */) continue;
                // 快速跳过不相关行（indexOf 比 N 次 startsWith 快得多）
                if (!RE_LINESTART.test(line)) continue;
                const sp = line.indexOf(' ');
                if (sp < 0) continue;
                const value = parseFloat(line.substring(sp + 1));
                if (line.startsWith('node_cpu_seconds_total')) {
                    const m = line.match(RE_MODE);
                    if (m) {
                        metrics.cpu.total += value;
                        if (m[1] === 'idle') metrics.cpu.idle += value;
                    }
                } else if (line.startsWith('node_memory_MemTotal_bytes')) metrics.memory.total = value;
                else if (line.startsWith('node_memory_MemAvailable_bytes')) metrics.memory.available = value;
                else if (line.startsWith('node_network_receive_bytes_total') || line.startsWith('node_network_transmit_bytes_total')) {
                    const isRecv = line.startsWith('node_network_receive_bytes_total');
                    const m = line.match(RE_DEVICE);
                    if (m) {
                        const dev = m[1];
                        if (!networkData[dev]) networkData[dev] = { received: 0, transmitted: 0 };
                        if (isRecv) networkData[dev].received = value;
                        else networkData[dev].transmitted = value;
                    }
                } else if (line.startsWith('node_boot_time_seconds')) metrics.bootTime = value;
                else if (line.startsWith('node_thermal_zone_temp') || line.startsWith('node_hwmon_temp_input')) {
                    if (metrics.temp === null) metrics.temp = value;
                } else if (line.startsWith('node_filesystem_size_bytes') || line.startsWith('node_filesystem_avail_bytes')) {
                    const m = line.match(RE_MOUNT);
                    if (m && m[1] === targetMountpoint) {
                        const mp = m[1];
                        if (!metrics.filesystems[mp]) metrics.filesystems[mp] = { size: 0, avail: 0 };
                        if (line.startsWith('node_filesystem_size_bytes')) metrics.filesystems[mp].size = value;
                        else metrics.filesystems[mp].avail = value;
                    }
                }
            }
            for (const dev in networkData) {
                if (!IGNORED_IFACE.test(dev)) { primaryInterface = dev; break; }
            }
            if (!primaryInterface && networkData.eth0) primaryInterface = 'eth0';
            if (primaryInterface && networkData[primaryInterface]) metrics.network = networkData[primaryInterface];
            return metrics;
        }

        // storage 带 try-catch（P2 顺便修）
        function safeLsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
        function safeLsSet(k, v) { try { localStorage.setItem(k, v); return true; } catch (e) { return false; } }

        function getUrlsFromStorage() {
            const storedUrls = safeLsGet('nasUrlList');
            const storedVersion = parseInt(safeLsGet('nasUrlsVersion') || '0', 10);
            if (!storedUrls) {
                safeLsSet('nasUrlList', JSON.stringify(DEFAULT_NAS_URLS));
                safeLsSet('nasUrlsVersion', String(NAS_URLS_VERSION));
                return DEFAULT_NAS_URLS.slice();
            }
            let parsedUrls;
            try {
                const parsed = JSON.parse(storedUrls);
                parsedUrls = Array.isArray(parsed) && parsed.length > 0 ? parsed : DEFAULT_NAS_URLS.slice();
            } catch (e) { parsedUrls = DEFAULT_NAS_URLS.slice(); }
            if (storedVersion !== NAS_URLS_VERSION) {
                const userCustomUrls = parsedUrls.filter(url => !DEFAULT_NAS_URLS.includes(url));
                const merged = [...DEFAULT_NAS_URLS, ...userCustomUrls];
                safeLsSet('nasUrlList', JSON.stringify(merged));
                safeLsSet('nasUrlsVersion', String(NAS_URLS_VERSION));
                return merged;
            }
            return parsedUrls;
        }
        function saveUrlsToStorage(urls) {
            safeLsSet('nasUrlList', JSON.stringify(urls));
            safeLsSet('nasUrlsVersion', String(NAS_URLS_VERSION));
        }

        // P1-4: 每个 NAS 实例的 DOM 引用缓存，避免热路径 getElementById
        function cacheNasElements(index) {
            return {
                cpuUsage: document.getElementById(`nas-cpu-usage-${index}`),
                memUsage: document.getElementById(`nas-mem-usage-${index}`),
                memDetails: document.getElementById(`nas-mem-details-${index}`),
                tempCard: document.getElementById(`nas-temp-card-${index}`),
                tempValue: document.getElementById(`nas-temp-value-${index}`),
                netSpeed: document.getElementById(`nas-net-speed-${index}`),
                diskUsage: document.getElementById(`nas-disk-usage-${index}`),
                diskDetails: document.getElementById(`nas-disk-details-${index}`),
                systemUptime: document.getElementById(`nas-system-uptime-${index}`),
                bootTime: document.getElementById(`nas-boot-time-${index}`),
                statusText: document.getElementById(`nas-status-text-${index}`),
                errorText: document.getElementById(`nas-error-text-${index}`)
            };
        }

        function createNasCardHtml(url, index) {
            const urlHostname = escapeHtml(new URL(url).hostname); // P0-2
            return `<div class="nas-card-container" data-url="${escapeHtml(url)}"> <div style="font-weight: bold; color: var(--primary-dark); margin-bottom: 15px; text-align: center;">${urlHostname}</div> <div class="nas-card-grid"> <div class="nas-metric-card"><div class="nas-metric-icon"><i class="fas fa-microchip"></i></div><div class="nas-metric-details"><span class="nas-metric-label">CPU</span><div class="nas-metric-value" id="nas-cpu-usage-${index}">--%</div></div></div> <div class="nas-metric-card"><div class="nas-metric-icon"><i class="fas fa-memory"></i></div><div class="nas-metric-details"><span class="nas-metric-label">内存</span><div class="nas-metric-value" id="nas-mem-usage-${index}">--%</div><div class="nas-metric-subvalue" id="nas-mem-details-${index}">--/--GB</div></div></div> <div class="nas-metric-card" id="nas-temp-card-${index}" style="display: none;"><div class="nas-metric-icon"><i class="fas fa-thermometer-half"></i></div><div class="nas-metric-details"><span class="nas-metric-label">温度</span><div class="nas-metric-value" id="nas-temp-value-${index}">--°C</div></div></div> <div class="nas-metric-card"><div class="nas-metric-icon"><i class="fas fa-exchange-alt"></i></div><div class="nas-metric-details"><span class="nas-metric-label">上传/下载</span><div class="nas-metric-value small-font" id="nas-net-speed-${index}">-- / --</div></div></div> <div class="nas-metric-card"><div class="nas-metric-icon"><i class="fas fa-hdd"></i></div><div class="nas-metric-details"><span class="nas-metric-label">系统存储</span><div class="nas-metric-value" id="nas-disk-usage-${index}">--%</div><div class="nas-metric-subvalue" id="nas-disk-details-${index}">--/--GB</div></div></div> <div class="nas-metric-card"><div class="nas-metric-icon"><i class="fas fa-history"></i></div><div class="nas-metric-details"><span class="nas-metric-label">运行时间</span><div class="nas-metric-value small-font" id="nas-system-uptime-${index}">--</div><div class="nas-metric-subvalue" id="nas-boot-time-${index}">--</div></div></div> </div> <div id="nas-status-footer-${index}" class="nas-status-footer"><span id="nas-status-text-${index}">正在连接...</span><span id="nas-error-text-${index}" class="nas-error"></span></div> </div>`;
        }
        function renderNasContainers() {
            const container = document.getElementById('nas-grid-container');
            if (!container) return;
            container.innerHTML = nasUrlList.map(createNasCardHtml).join('');
            // P1-4: 渲染后立刻缓存所有 DOM 引用
            nasUrlList.forEach((url, index) => {
                if (!nasInstances[url]) nasInstances[url] = {};
                nasInstances[url].elements = cacheNasElements(index);
            });
        }
        function renderUrlListInModal() {
            const listContainer = document.getElementById('nas-url-list');
            if (!listContainer) return;
            listContainer.innerHTML = '';
            const frag = document.createDocumentFragment();
            nasUrlList.forEach((url, index) => {
                const item = document.createElement('div');
                item.className = 'nas-url-item';
                const span = document.createElement('span');
                span.textContent = url;
                const btn = document.createElement('button');
                btn.className = 'delete-nas-button';
                btn.setAttribute('data-index', String(index));
                btn.textContent = '删除';
                item.appendChild(span);
                item.appendChild(btn);
                frag.appendChild(item);
            });
            listContainer.appendChild(frag);
        }

        function updatePageTitle() {
            // P1-6: 页面不可见时不改标题，省资源
            if (document.hidden) return;
            const upSpeed = nas_formatSpeed(totalSpeeds.up, 1);
            const downSpeed = nas_formatSpeed(totalSpeeds.down, 1);
            document.title = `↑${upSpeed} / ↓${downSpeed} | ${originalTitle}`;
        }

        // 快速安全写 DOM（用 textContent，防 XSS + 比 innerHTML 快）
        function setText(el, text) { if (el) el.textContent = text; }

        async function updateSingleNasDisplay(url, index, outerSignal) {
            const inst = nasInstances[url] || (nasInstances[url] = {});
            const els = inst.elements;
            try {
                // P0-3: 15s 超时，且能被外层 AbortController 取消
                const response = await fetchWithTimeout(
                    NAS_WORKER_URL,
                    {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ url: url }),
                        signal: outerSignal
                    },
                    NAS_FETCH_TIMEOUT
                );
                if (!response.ok) throw new Error(`代理请求失败: ${response.status}`);
                const text = await response.text();
                if (text.includes('Error:')) throw new Error(text.replace('Error: ', ''));
                const now = Date.now();
                const currentMetrics = parseNasRealtimeMetrics(text);

                if (inst.previousCpuData) {
                    const totalDiff = currentMetrics.cpu.total - inst.previousCpuData.total;
                    const idleDiff = currentMetrics.cpu.idle - inst.previousCpuData.idle;
                    setText(els?.cpuUsage, `${(totalDiff > 0 ? 100 * (1 - (idleDiff / totalDiff)) : 0).toFixed(1)}%`);
                }
                if (currentMetrics.memory.total > 0) {
                    const memUsed = currentMetrics.memory.total - currentMetrics.memory.available;
                    setText(els?.memUsage, `${(100 * memUsed / currentMetrics.memory.total).toFixed(1)}%`);
                    setText(els?.memDetails, `${nas_formatBytes(memUsed, 2)}/${nas_formatBytes(currentMetrics.memory.total, 2)}`);
                }
                if (currentMetrics.temp !== null) {
                    if (els?.tempCard) els.tempCard.style.display = 'flex';
                    setText(els?.tempValue, `${currentMetrics.temp.toFixed(1)}°C`);
                }
                let upSpeed = 0, downSpeed = 0;
                if (inst.previousNetData && inst.lastFetchTime) {
                    const timeDelta = (now - inst.lastFetchTime) / 1000;
                    if (timeDelta > 0) {
                        downSpeed = Math.max(0, (currentMetrics.network.received - inst.previousNetData.received) / timeDelta);
                        upSpeed = Math.max(0, (currentMetrics.network.transmitted - inst.previousNetData.transmitted) / timeDelta);
                        setText(els?.netSpeed, `${nas_formatSpeed(upSpeed)} / ${nas_formatSpeed(downSpeed)}`);
                    }
                }
                inst.upSpeed = upSpeed; inst.downSpeed = downSpeed;

                const diskData = currentMetrics.filesystems['/etc/hostname'];
                if (diskData && diskData.size > 0) {
                    const diskUsed = diskData.size - diskData.avail;
                    setText(els?.diskUsage, `${(100 * diskUsed / diskData.size).toFixed(1)}%`);
                    setText(els?.diskDetails, `(${nas_formatBytes(diskUsed)}/${nas_formatBytes(diskData.size)})`);
                }
                if (currentMetrics.bootTime > 0) {
                    inst.bootTimestamp = currentMetrics.bootTime;
                    const bootDate = new Date(currentMetrics.bootTime * 1000);
                    setText(els?.bootTime, `开机于: ${bootDate.toLocaleDateString()}`);
                    // 拿到 bootTime 立即算一次 uptime，不用等下次 uptime 定时器
                    if (els?.systemUptime) els.systemUptime.textContent = nas_formatUptime((Date.now() / 1000) - inst.bootTimestamp);
                }
                inst.previousCpuData = currentMetrics.cpu;
                inst.previousNetData = currentMetrics.network;
                inst.lastFetchTime = now;
                setText(els?.statusText, `上次更新: ${new Date().toLocaleTimeString()}`);
                setText(els?.errorText, '');
            } catch (error) {
                if (error.name === 'AbortError') return; // 被取消，不打印不置错
                console.error(`更新NAS[${url}]状态失败:`, error);
                setText(els?.errorText, `错误: ${error.message}`);
                inst.upSpeed = 0; inst.downSpeed = 0;
            }
        }

        function updateAllUptimes() {
            const nowSec = Date.now() / 1000;
            for (let i = 0; i < nasUrlList.length; i++) {
                const url = nasUrlList[i];
                const inst = nasInstances[url];
                if (!inst || !inst.bootTimestamp || inst.bootTimestamp <= 0) continue;
                // P1-4: 走缓存引用，不再 getElementById
                const el = inst.elements?.systemUptime || document.getElementById(`nas-system-uptime-${i}`);
                if (el) el.textContent = nas_formatUptime(nowSec - inst.bootTimestamp);
            }
        }

        function stopUpdatingAllNas() {
            if (updateInterval) { clearInterval(updateInterval); updateInterval = null; }
            // P0-3: 取消当前所有在飞请求
            if (nasFetchAbortController) { try { nasFetchAbortController.abort(); } catch (e) {} nasFetchAbortController = null; }
        }

        function startUpdatingAllNas() {
            stopUpdatingAllNas();
            const updateAll = async () => {
                // P0-3: 每次循环先 abort 掉上次可能残留的，再创建新的
                if (nasFetchAbortController) { try { nasFetchAbortController.abort(); } catch (e) {} }
                nasFetchAbortController = new AbortController();
                // P0-3: 并发限流 3 个，避免同域名连接池打满
                await promiseAllLimited(nasUrlList, NAS_CONCURRENT_LIMIT, (url, idx) =>
                    updateSingleNasDisplay(url, idx, nasFetchAbortController.signal)
                );
                totalSpeeds = { up: 0, down: 0 };
                for (const url of nasUrlList) {
                    const inst = nasInstances[url];
                    if (inst) {
                        totalSpeeds.up += inst.upSpeed || 0;
                        totalSpeeds.down += inst.downSpeed || 0;
                    }
                }
                updatePageTitle();
            };
            updateAll();
            updateInterval = setInterval(updateAll, currentPollInterval);
        }

        // P1-6: 页面可见性变化时调整轮询频率
        function onVisibilityChange() {
            if (document.hidden) {
                // 切后台：标题还原 + 轮询降级到 60s
                if (document.title !== originalTitle) document.title = originalTitle;
                if (currentPollInterval !== NAS_POLL_BACKGROUND) {
                    currentPollInterval = NAS_POLL_BACKGROUND;
                    startUpdatingAllNas();
                }
            } else {
                // 切回前台：立即补刷一次 + 恢复 10s
                if (currentPollInterval !== NAS_POLL_INTERVAL) {
                    currentPollInterval = NAS_POLL_INTERVAL;
                    startUpdatingAllNas();
                } else {
                    // 即使间隔没变，用户切回来也应该让标题和状态立刻新
                    updatePageTitle();
                }
            }
        }
        document.addEventListener('visibilitychange', onVisibilityChange);

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
            addButton.addEventListener('click', () => {
                const newUrl = urlInput.value.trim();
                if (newUrl && !nasUrlList.includes(newUrl)) {
                    nasUrlList.push(newUrl);
                    saveUrlsToStorage(nasUrlList);
                    renderUrlListInModal();
                    renderNasContainers();
                    startUpdatingAllNas();
                    urlInput.value = '';
                }
            });
            urlListContainer.addEventListener('click', (e) => {
                if (e.target.classList.contains('delete-nas-button')) {
                    const indexToRemove = parseInt(e.target.getAttribute('data-index'), 10);
                    const urlToRemove = nasUrlList[indexToRemove];
                    if (nasInstances[urlToRemove]) delete nasInstances[urlToRemove];
                    nasUrlList.splice(indexToRemove, 1);
                    saveUrlsToStorage(nasUrlList);
                    renderUrlListInModal();
                    renderNasContainers();
                    startUpdatingAllNas();
                }
            });
        }

        nasUrlList = getUrlsFromStorage();
        renderNasContainers();
        startUpdatingAllNas();
        // P1-4: 从 1000ms 改到 60000ms，省 ~60 倍的 DOM 查询开销
        updateAllUptimes(); // 启动时先跑一次
        uptimeInterval = setInterval(updateAllUptimes, NAS_UPTIME_INTERVAL);
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
