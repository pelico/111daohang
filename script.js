document.addEventListener('DOMContentLoaded', function() {
    console.log('[DIAGNOSTIC] DOMContentLoaded event fired. Main script starting.');

    const isMobile = window.innerWidth <= 768;

    // --- API Endpoints ---
    const NOTIFICATIONS_API = 'https://jy-api.111312.xyz/notifications';
    const MONITORING_PROXY_API = 'https://up-api.111312.xyz/';
    const WEATHER_API = 'https://tq-api.111312.xyz';

    // --- 全局变量和状态 ---
    let monitorDataCache = [];
    let notificationsLoaded = false;
    let weatherLoaded = false;
    let nasCpuHistoryChart, nasNetworkHistoryChart;

    // --- 1. 基础功能 ---
    function updateTime() {
        const now = new Date();
        const hours = String(now.getHours()).padStart(2, '0');
        const minutes = String(now.getMinutes()).padStart(2, '0');
        const seconds = String(now.getSeconds()).padStart(2, '0');
        const year = now.getFullYear();
        const month = now.getMonth() + 1;
        const day = now.getDate();
        const weekdays = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];
        const weekday = weekdays[now.getDay()];
        
        const timeEl = document.getElementById('current-time');
        const dateEl = document.getElementById('current-date');
        if (timeEl) timeEl.textContent = `${hours}:${minutes}:${seconds}`;
        if (dateEl) dateEl.textContent = `${year}年${month}月${day}日 ${weekday}`;
    }

    function countSites() {
        const sites = document.querySelectorAll('.nav-link');
        const siteCountEl = document.getElementById('site-count');
        if (siteCountEl) siteCountEl.textContent = sites.length;
    }

    // --- 2. 选项卡切换逻辑 ---
    function handleTabs() {
        console.log('[DIAGNOSTIC] handleTabs() called.');
        const tabButtons = document.querySelectorAll('.tab-button');
        const tabContents = document.querySelectorAll('.tab-content');
        console.log(`[DIAGNOSTIC] Found ${tabButtons.length} tab buttons.`);

        tabButtons.forEach(button => {
            button.addEventListener('click', () => {
                console.log(`[DIAGNOSTIC] Tab button clicked: ${button.getAttribute('data-tab')}`);
                tabButtons.forEach(btn => btn.classList.remove('active'));
                tabContents.forEach(content => content.classList.remove('active'));

                button.classList.add('active');
                const tabId = button.getAttribute('data-tab');
                const activeTab = document.getElementById(tabId);
                if (activeTab) activeTab.classList.add('active');

                if (tabId === 'tab-notifications' && !notificationsLoaded) {
                    fetchNotifications();
                    notificationsLoaded = true;
                }
                
                if (tabId === 'tab-weather' && !weatherLoaded) {
                    fetchWeatherData();
                    weatherLoaded = true;
                }
            });
        });
    }

    // --- 3. 我的通知功能 ---
    function showNotificationStatus(message, type = 'info') {
        const statusEl = document.getElementById('notifications-status-message');
        if (statusEl) {
            statusEl.innerHTML = `<div class="status-msg ${type}">${message}</div>`;
            if (type === 'success') {
                setTimeout(() => { statusEl.innerHTML = ''; }, 5000);
            }
        }
    }

    async function fetchNotifications() {
        const listEl = document.getElementById('notifications-list');
        if (!listEl) return;
        listEl.innerHTML = `<div class="loading-state"><div class="loading-spinner"></div><div>正在刷新...</div></div>`;
        try {
            const response = await fetch(NOTIFICATIONS_API);
            if (!response.ok) throw new Error(`HTTP错误! 状态码: ${response.status}`);
            const data = await response.json();
            if (data.success === false) throw new Error(`API返回错误: ${data.error || '未知错误'}`);
            if (data.notifications && data.notifications.length > 0) {
                listEl.innerHTML = '';
                data.notifications.forEach(item => {
                    const div = document.createElement('div');
                    div.className = 'notification-item';
                    const date = new Date(item.timestamp);
                    div.innerHTML = `<span class="notification-content">${item.content}</span><span class="notification-timestamp">${date.toLocaleString('zh-CN', { year: '2-digit', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>`;
                    listEl.appendChild(div);
                });
                showNotificationStatus(`成功加载 ${data.notifications.length} 条通知`, 'success');
            } else {
                listEl.innerHTML = `<div class="empty-state"><p>暂无通知或短信</p></div>`;
            }
        } catch (error) {
            console.error('获取通知失败:', error);
            listEl.innerHTML = `<div class="error-state"><p>加载失败: ${error.message}</p></div>`;
            showNotificationStatus(`加载失败: ${error.message}`, 'error');
        }
    }

    // --- 4. 服务监控功能 ---
    const STATUS_MAP = { 0: { text: '暂停中', class: 'status-warning', icon: 'fa-pause-circle' }, 1: { text: '未检查', class: 'status-warning', icon: 'fa-question-circle' }, 2: { text: '运行中', class: 'status-up', icon: 'fa-check-circle' }, 8: { text: '疑似故障', class: 'status-warning', icon: 'fa-exclamation-circle' }, 9: { text: '服务中断', class: 'status-down', icon: 'fa-times-circle' } };
    
    function renderMonitoringPage(data) {
        if (!data) { showMonitoringError("未能从API获取到有效的监控数据。"); return; }
        const container = document.getElementById('monitoring-container');
        if (!container) return;
        container.innerHTML = '';
        if (data.nas_stats || data.nas_history) {
            const nasSection = document.createElement('div');
            nasSection.className = 'nas-section';
            nasSection.innerHTML = `<h2 class="section-title"><i class="fas fa-server"></i><span>NAS 系统状态</span></h2> <div class="nas-info-grid"> <div class="nas-info-card"><i class="fas fa-power-off nas-info-icon"></i><div class="nas-info-details"><div class="nas-info-label">启动于</div><div id="nas-boot-time" class="nas-info-value">...</div></div></div> <div class="nas-info-card"><i class="fas fa-history nas-info-icon"></i><div class="nas-info-details"><div class="nas-info-label">已运行</div><div id="nas-uptime" class="nas-info-value">...</div></div></div> </div> <div class="nas-stats-grid" id="nas-realtime-stats"></div> <div class="charts-grid"> <div class="chart-container"><div class="chart-header"><h3 class="chart-title">CPU 使用率</h3></div><div class="nas-chart-wrapper"><canvas id="nasCpuHistoryChart"></canvas></div></div> <div class="chart-container"><div class="chart-header"><h3 class="chart-title">网络流量</h3></div><div class="nas-chart-wrapper"><canvas id="nasNetworkHistoryChart"></canvas></div></div> </div>`;
            container.appendChild(nasSection);
            if (data.nas_stats) renderNasProgressBars(data.nas_stats);
            if (data.nas_history) renderNasHistoryCharts(data.nas_history);
        }
        if (data.monitors) {
            const monitors = data.monitors.filter(m => m.type === 1 || m.type === 2);
            monitorDataCache = monitors;
            let upCount = 0, downCount = 0, warningCount = 0, totalUptime = 0;
            monitors.forEach(m => {
                const statusClass = (STATUS_MAP[m.status] || {}).class || 'status-warning';
                if (statusClass === 'status-up') upCount++;
                else if (statusClass === 'status-down') downCount++;
                else warningCount++;
                totalUptime += parseFloat(m.custom_uptime_ratios?.split('-')[0] || m.all_time_uptime_ratio || 0);
            });
            const servicesHTML = monitors.map(monitor => {
                const status = STATUS_MAP[monitor.status] || { text: '未知', class: 'status-warning', icon: 'fa-question-circle' };
                return `<div class="service-card" id="monitor-card-${monitor.id}"> <div class="service-card-header" onclick="toggleDetailChart(${monitor.id})"> <div class="service-header"> <div class="service-name">${monitor.friendly_name} <i class="fas fa-chevron-down"></i></div> <div class="service-status ${status.class}"><i class="fas ${status.icon}"></i> ${status.text}</div> </div> </div> <div class="service-details"> <div class="service-details-content"> <div class="detail-chart-container"><canvas id="detail-chart-${monitor.id}"></canvas></div> </div> </div> </div>`;
            }).join('');
            const uptimeContainer = document.createElement('div');
            uptimeContainer.id = 'uptime-robot-container';
            uptimeContainer.innerHTML = `<header> <div class="logo"><i class="fas fa-heartbeat"></i><div class="logo-text">服务状态监控</div></div> <p class="subtitle">基于 UptimeRobot API 的实时监控仪表盘</p> </header> <div class="status-summary"> <div class="summary-card status"><div class="card-icon"><i class="fas fa-check-circle"></i></div><div class="card-title">正常运行</div><div class="card-value">${upCount}</div></div> <div class="summary-card uptime"><div class="card-icon"><i class="fas fa-chart-line"></i></div><div class="card-title">平均运行率</div><div class="card-value">${monitors.length > 0 ? (totalUptime / monitors.length).toFixed(2) : '0'}%</div></div> <div class="summary-card incidents"><div class="card-icon"><i class="fas fa-times-circle"></i></div><div class="card-title">当前故障</div><div class="card-value">${downCount}</div></div> </div> <div class="services-grid"> <div class="services-header"><span>网站监控列表 (点击展开图表)</span></div> <div id="services-list">${servicesHTML || '<p style="padding: 20px;">没有找到网站监控服务。</p>'}</div> </div> <div class="charts-section"> <h2 class="section-title"><i class="fas fa-chart-bar"></i><span>网站状态总览</span></h2> <div class="charts-grid"> <div class="chart-container"><div class="chart-header"><h3 class="chart-title">服务状态分布</h3></div><div class="chart-wrapper"><canvas id="statusChart"></canvas></div></div> <div class="chart-container"><div class="chart-header"><h3 class="chart-title">平均响应时间</h3></div><div class="chart-wrapper"><canvas id="responseTimeChart"></canvas></div></div> </div> </div>`;
            container.appendChild(uptimeContainer);
            renderOverviewCharts(monitors, { up: upCount, down: downCount, warning: warningCount });
        } else if (!data.nas_stats && !data.nas_history) { showMonitoringError("没有找到任何监控服务数据。"); }
    }
    function renderNasProgressBars(stats) {
        document.getElementById('nas-boot-time').textContent = stats.system_time?.boot_time || 'N/A';
        document.getElementById('nas-uptime').textContent = stats.system_time?.uptime || 'N/A';
        const container = document.getElementById('nas-realtime-stats');
        let html = '';
        const items = [{ icon: 'fa-microchip', label: 'CPU', data: stats.cpu }, { icon: 'fa-memory', label: '内存', data: stats.memory }, { icon: 'fa-compact-disc', label: '磁盘', data: stats.disk }];
        items.forEach(item => {
            if (item.data) {
                 html += `<div class="nas-info-card"> <div class="progress-bar-info" style="width:100%"><span class="progress-bar-label"><i class="fas ${item.icon}"></i> ${item.label}</span><span>${item.data.percent}%</span></div> <div class="progress-bar-bg" style="width:100%"><div class="progress-bar-fill" style="width: ${item.data.percent}%;"></div></div> </div>`;
            }
        });
        if (container) container.innerHTML = html;
    }
    function renderNasHistoryCharts(history) {
        if (nasCpuHistoryChart) nasCpuHistoryChart.destroy();
        if (nasNetworkHistoryChart) nasNetworkHistoryChart.destroy();
        const cpuCtx = document.getElementById('nasCpuHistoryChart')?.getContext('2d');
        if (cpuCtx && history.cpu && history.cpu.length > 0) {
            nasCpuHistoryChart = new Chart(cpuCtx, { type: 'line', data: { datasets: [{ label: 'CPU Usage (%)', data: history.cpu.map(d => ({x: d.timestamp * 1000, y: d.usage})), borderColor: 'rgba(30, 136, 229, 0.7)', backgroundColor: 'rgba(30, 136, 229, 0.1)', borderWidth: 1.5, pointRadius: 0, tension: 0.4, fill: true }] }, options: { responsive: true, maintainAspectRatio: false, scales: { x: { type: 'time', time: { unit: 'day' }, ticks: { font: { size: 10 } } }, y: { beginAtZero: true, max: 100, ticks: { font: { size: 10 } } } }, plugins: { legend: { display: false }, tooltip: { enabled: !isMobile } } } });
        }
        const netCtx = document.getElementById('nasNetworkHistoryChart')?.getContext('2d');
        if (netCtx && history.network && history.network.length > 0) {
            const datasets = [{ iface: 'eth0', recv: 'eth0_recv', sent: 'eth0_sent', color: 'rgba(76, 175, 80, 0.7)'}, { iface: 'wlan0', recv: 'wlan0_recv', sent: 'wlan0_sent', color: 'rgba(255, 152, 0, 0.7)'}, { iface: 'docker0', recv: 'docker0_recv', sent: 'docker0_sent', color: 'rgba(156, 39, 176, 0.7)'}].map(config => ({ label: config.iface, data: history.network.map(d => ({ x: d.timestamp * 1000, y: ((d[config.recv] || 0) + (d[config.sent] || 0)) / 1024**3 })), borderColor: config.color, borderWidth: 1.5, pointRadius: 0, tension: 0.4, fill: false })).filter(ds => ds.data.some(d => d.y > 0));
            nasNetworkHistoryChart = new Chart(netCtx, { type: 'line', data: { datasets: datasets }, options: { responsive: true, maintainAspectRatio: false, scales: { x: { type: 'time', time: { unit: 'day' }, ticks: { font: { size: 10 } } }, y: { beginAtZero: true, title: { display: !isMobile, text: 'GB' }, ticks: { font: { size: 10 } } } }, plugins: { legend: { display: !isMobile, position: 'bottom', labels: { font: { size: 10 } } }, tooltip: { enabled: !isMobile } } } });
        }
    }
    window.toggleDetailChart = function(monitorId) {
        const card = document.getElementById(`monitor-card-${monitorId}`);
        if (!card) return;
        const isExpanded = card.classList.toggle('expanded');
        if (isExpanded) {
            const monitor = monitorDataCache.find(m => m.id === monitorId);
            if (monitor && monitor.response_times) createDetailChart(monitor);
        }
    }
    function createDetailChart(monitor) {
        const canvasId = `detail-chart-${monitor.id}`, ctx = document.getElementById(canvasId)?.getContext('2d');
        if (!ctx) return;
        if (Chart.getChart(ctx)) Chart.getChart(ctx).destroy();
        const chartData = monitor.response_times.map(rt => ({ x: rt.datetime * 1000, y: rt.value })).reverse();
        new Chart(ctx, { type: 'line', data: { datasets: [{ label: '响应时间 (ms)', data: chartData, borderColor: 'rgba(30, 136, 229, 0.5)', backgroundColor: 'rgba(30, 136, 229, 0.1)', borderWidth: 1, tension: 0.3, fill: true, pointRadius: 0 }] }, options: { responsive: true, maintainAspectRatio: false, scales: { x: { type: 'time', time: { unit: 'hour' }, ticks: { font: { size: 10 } } }, y: { beginAtZero: true, ticks: { font: { size: 10 } } } }, plugins: { legend: { display: false }, tooltip: { enabled: !isMobile } } } });
    }
    function renderOverviewCharts(monitors, counts) {
        const statusCtx = document.getElementById('statusChart')?.getContext('2d');
        if (statusCtx) {
            if (Chart.getChart(statusCtx)) Chart.getChart(statusCtx).destroy();
            new Chart(statusCtx, { type: 'doughnut', data: { labels: ['正常', '警告', '故障'], datasets: [{ data: [counts.up, counts.warning, counts.down], backgroundColor: [ 'rgba(76, 175, 80, 0.8)', 'rgba(255, 152, 0, 0.8)', 'rgba(244, 67, 54, 0.8)' ], borderWidth: 1.5 }] }, options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: !isMobile, position: 'bottom', labels: { font: { size: 10 } } } } } });
        }
        const rtCtx = document.getElementById('responseTimeChart')?.getContext('2d');
        if (rtCtx) {
            if (Chart.getChart(rtCtx)) Chart.getChart(rtCtx).destroy();
            new Chart(rtCtx, { type: 'bar', data: { labels: monitors.map(m => m.friendly_name.substring(0, isMobile ? 5 : 12) + (m.friendly_name.length > (isMobile ? 5 : 12) ? '...' : '')), datasets: [{ label: '响应时间 (ms)', data: monitors.map(m => m.response_times?.[0]?.value || 0), backgroundColor: 'rgba(30, 136, 229, 0.7)' }] }, options: { responsive: true, maintainAspectRatio: false, scales: { x: { ticks: { font: { size: 10 } } }, y: { beginAtZero: true, ticks: { font: { size: 10 } } } }, plugins: { legend: { display: false }, tooltip: { enabled: !isMobile } } } });
        }
    }
    async function fetchMonitoringData() {
        try {
            const response = await fetch(MONITORING_PROXY_API, { method: 'POST', cache: 'no-cache' });
            if (!response.ok) throw new Error(`API代理请求失败: ${response.status}`);
            const data = await response.json();
            if (!data || (data.stat !== 'ok' && !data.nas_stats)) throw new Error(`API 返回错误: ${(data.error || {}).message || '未知'}`);
            return data;
        } catch (error) { console.error('获取监控数据失败:', error); showMonitoringError(error.message); return null; }
    }
    function showMonitoringError(message) {
        const container = document.getElementById('monitoring-container');
        if (container) container.innerHTML = `<div class="error-state"><h2>加载数据失败</h2><p>${message}</p></div>`;
    }
    async function initMonitoring() {
        const container = document.getElementById('monitoring-container');
        if (container && !container.innerHTML.trim()) { container.innerHTML = `<div class="loading-state"><div class="loading-spinner"></div><p>正在加载全部监控数据...</p></div>`; }
        const data = await fetchMonitoringData();
        if (data) renderMonitoringPage(data);
    }

    // --- 5. 天气仪表盘功能 ---
    const sourceStyles = { 'HefengAPI': { label: 'API', tempColor: 'rgb(255, 99, 132)', humidColor: 'rgb(255, 159, 64)' }, 'ESP8266':   { label: '设备', tempColor: 'rgb(54, 162, 235)', humidColor: 'rgb(75, 192, 192)' }, 'default':   { label: '其他', tempColor: 'rgb(201, 203, 207)', humidColor: 'rgb(153, 102, 255)' } };
    async function fetchWeatherData() {
        const loadingMessage = document.getElementById('weather-loading-message');
        const cardsContainer = document.getElementById('latest-weather-cards');
        const chartsContainer = document.getElementById('weather-charts-container');
        try {
            const response = await fetch(WEATHER_API);
            if (!response.ok) throw new Error(`无法从 Worker 获取数据，状态码: ${response.status}`);
            const data = await response.json();
            if (loadingMessage) loadingMessage.style.display = 'none';
            if (cardsContainer) cardsContainer.style.display = 'flex';
            if (chartsContainer) chartsContainer.style.display = 'flex';
            displayLatestWeather(data.latest);
            displayTrendCharts(data.history);
        } catch (error) {
            console.error('加载天气数据时发生错误:', error);
            if (loadingMessage) loadingMessage.innerHTML = `<div class="error-state"><h2>加载天气数据失败</h2><p>${error.message}</p></div>`;
        }
    }
    function displayLatestWeather(latestData) {
        const container = document.getElementById('latest-weather-cards');
        if (!container) return;
        container.innerHTML = ''; 
        if (!latestData || latestData.length === 0) { container.innerHTML = "<p>暂无最新的天气数据。</p>"; return; }
        for (const cityData of latestData) {
            const card = document.createElement('div');
            card.className = 'weather-card';
            card.innerHTML = `<h2>${cityData.city_name}</h2> <p class="weather-text">${cityData.weather_text}</p> <p><strong>温度:</strong> ${cityData.temperature}°C (体感 ${cityData.feels_like}°C)</p> <p><strong>相对湿度:</strong> ${cityData.humidity}%</p> <p class="timestamp">更新于: ${new Date(cityData.observation_time).toLocaleString()}</p>`;
            container.appendChild(card);
        }
    }
    function displayTrendCharts(historyData) {
        const container = document.getElementById('weather-charts-container');
        if (!container) return;
        container.innerHTML = '';
        if (!historyData || historyData.length === 0) return;
        const cities = {};
        for (const record of historyData) {
            if (!cities[record.city_name]) cities[record.city_name] = [];
            cities[record.city_name].push(record);
        }
        for (const cityName in cities) {
            const chartContainer = document.createElement('div');
            chartContainer.className = 'weather-chart-container';
            const canvas = document.createElement('canvas');
            chartContainer.appendChild(canvas);
            container.appendChild(chartContainer);
            const datasets = [];
            const cityHistory = cities[cityName];
            const sources = {};
            for (const record of cityHistory) {
                if (!sources[record.source]) sources[record.source] = [];
                sources[record.source].push(record);
            }
            for (const sourceName in sources) {
                const style = sourceStyles[sourceName] || sourceStyles.default;
                const sourceData = sources[sourceName];
                datasets.push({ label: `温度 - ${style.label}`, data: sourceData.map(d => ({ x: new Date(d.observation_time), y: d.temperature })), borderColor: style.tempColor, backgroundColor: style.tempColor.replace('rgb', 'rgba').replace(')', ', 0.5)'), yAxisID: 'y', tension: 0.1, borderWidth: 1.5, pointRadius: 0 });
                datasets.push({ label: `湿度 - ${style.label}`, data: sourceData.map(d => ({ x: new Date(d.observation_time), y: d.humidity })), borderColor: style.humidColor, backgroundColor: style.humidColor.replace('rgb', 'rgba').replace(')', ', 0.5)'), yAxisID: 'y1', borderDash: [5, 5], tension: 0.1, borderWidth: 1.5, pointRadius: 0 });
            }
            new Chart(canvas, {
                type: 'line',
                data: { datasets: datasets },
                options: {
                    responsive: true,
                    interaction: { mode: 'x', intersect: false, },
                    plugins: { title: { display: true, text: `${cityName} - 24小时趋势`, font: { size: isMobile ? 14 : 18 } }, legend: { display: !isMobile, position: 'bottom', labels: { font: { size: 10 } } } },
                    scales: {
                        x: { type: 'time', time: { unit: 'hour', tooltipFormat: 'HH:mm', displayFormats: { hour: 'HH:mm' } }, title: { display: false }, ticks: { font: { size: 10 } } },
                        y: { type: 'linear', display: true, position: 'left', title: { display: !isMobile, text: '温度 (°C)' }, ticks: { font: { size: 10 } } },
                        y1: { type: 'linear', display: true, position: 'right', title: { display: !isMobile, text: '湿度 (%)' }, grid: { drawOnChartArea: false }, ticks: { font: { size: 10 } } }
                    }
                }
            });
        }
    }

    // --- 初始化函数 ---
    function initialize() {
        console.log('[DIAGNOSTIC] Initializing application...');
        updateTime();
        setInterval(updateTime, 1000);
        countSites();
        handleTabs();
        initMonitoring();
        const refreshBtn = document.getElementById('refresh-notifications-btn');
        if (refreshBtn) {
            refreshBtn.addEventListener('click', fetchNotifications);
        }
        console.log('[DIAGNOSTIC] Application initialized.');
    }

    initialize();
});


/*
 * =======================================================
 * ===       【最终修正版】NAS 实时状态监控 (顶部模块)     ===
 * =======================================================
 */
(() => {
    console.log('[DIAGNOSTIC-NAS] NAS monitoring script started.');
    // --- 配置区 ---
    const WORKER_URL = 'https://nas-hook.111312.xyz';
    
    // --- 辅助函数 (已重命名) ---
    function nas_formatBytes(bytes, decimals = 1) {
        if (bytes === undefined || bytes === null || bytes <= 0) return '0 Bytes';
        const k = 1024;
        const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB', 'PB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(decimals)) + ' ' + sizes[i];
    }
    function nas_formatSpeed(bytesPerSecond, decimals = 2) {
         if (bytesPerSecond === undefined || bytesPerSecond === null || bytesPerSecond < 1) return '0 B/s';
        const k = 1024;
        const sizes = ['B/s', 'KB/s', 'MB/s', 'GB/s', 'TB/s'];
        const i = Math.floor(Math.log(bytesPerSecond) / Math.log(k));
        return parseFloat((bytesPerSecond / Math.pow(k, i)).toFixed(decimals)) + ' ' + sizes[i];
    }
    function nas_formatUptime(totalSeconds) {
        if (!totalSeconds || totalSeconds <= 0) return '计算中...';
        totalSeconds = Math.floor(totalSeconds);
        const days = Math.floor(totalSeconds / 86400);
        totalSeconds %= 86400;
        const hours = Math.floor(totalSeconds / 3600);
        totalSeconds %= 3600;
        const minutes = Math.floor(totalSeconds / 60);
        let parts = [];
        if (days > 0) parts.push(`${days} 天`);
        if (hours > 0) parts.push(`${hours} 小时`);
        if (minutes > 0) parts.push(`${minutes} 分钟`);
        if (parts.length === 0 && totalSeconds > 0) return `${totalSeconds} 秒`;
        return parts.join(' ');
    }
    
    // --- 核心数据更新函数 ---
    async function updateNasDisplay() {
        console.log('[DIAGNOSTIC-NAS] updateNasDisplay() called.');
        const statusText = document.getElementById('nas-status-text');
        const errorText = document.getElementById('nas-error-text');
        
        try {
            const response = await fetch(WORKER_URL);
            console.log(`[DIAGNOSTIC-NAS] Fetch response status: ${response.status}`);
            if (!response.ok) {
                const errorData = await response.json().catch(() => ({ error: `请求失败: ${response.status}` }));
                throw new Error(errorData.error || `请求失败: ${response.status}`);
            }
            const data = await response.json();
            console.log('[DIAGNOSTIC-NAS] Parsed data from worker:', data);

            if (data.error) throw new Error(data.error);
            
            // 使用 document.getElementById 安全地更新每个元素
            const updateElementText = (id, text) => {
                const el = document.getElementById(id);
                if (el) el.textContent = text;
                else console.warn(`[DIAGNOSTIC-NAS] Element with ID "${id}" not found.`);
            };
            
            updateElementText('nas-cpu-usage', `${data.cpu_usage || '0.0'}%`);
            updateElementText('nas-mem-usage', `${data.mem_usage || '0.0'}%`);
            
            const memDetails = data.mem_details || {};
            updateElementText('nas-mem-details', `${memDetails.used || 0}/${memDetails.total || 0}MB`);
            
            updateElementText('nas-net-down', nas_formatSpeed(data.net_down_speed));
            updateElementText('nas-net-up', nas_formatSpeed(data.net_up_speed));

            const progressBar = document.getElementById('nas-disk-progress');
            const diskDetailsEl = document.getElementById('nas-disk-details');
            if (progressBar && diskDetailsEl) {
                const diskDetailsData = data.disk_details || {};
                progressBar.style.width = `${data.disk_usage_percent || 0}%`;
                diskDetailsEl.textContent = `${data.disk_usage_percent || '0.0'}% (${nas_formatBytes(diskDetailsData.used)} / ${nas_formatBytes(diskDetailsData.total)})`;
            }

            if (data.boot_time) {
                const uptimeSeconds = (Date.now() / 1000) - data.boot_time;
                updateElementText('nas-system-uptime', nas_formatUptime(uptimeSeconds));
                const bootDate = new Date(data.boot_time * 1000);
                updateElementText('nas-boot-time', `开机于: ${bootDate.toLocaleString('zh-CN', { month:'numeric', day:'numeric', hour:'2-digit', minute:'2-digit' })}`);
            }

            if (statusText && data.last_updated) {
                statusText.textContent = `上次更新: ${new Date(data.last_updated).toLocaleTimeString()}`;
            }
            if (errorText) errorText.textContent = '';

        } catch (error) {
            console.error('[DIAGNOSTIC-NAS] FATAL ERROR in updateNasDisplay:', error);
            if (errorText) errorText.textContent = `错误: ${error.message}`;
        }
    }
    
    // --- 启动监控 ---
    // 确保在主脚本初始化后执行，以防 DOM 未就绪
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => {
             console.log('[DIAGNOSTIC-NAS] DOM fully loaded. Starting NAS monitor.');
             updateNasDisplay();
             setInterval(updateNasDisplay, 5000);
        });
    } else {
        console.log('[DIAGNOSTIC-NAS] DOM already loaded. Starting NAS monitor.');
        updateNasDisplay();
        setInterval(updateNasDisplay, 5000);
    }
})();
