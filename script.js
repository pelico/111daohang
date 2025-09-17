document.addEventListener('DOMContentLoaded', function() {
    
    const isMobile = window.innerWidth <= 768;

    // --- API Endpoints ---
    const NOTIFICATIONS_API = 'https://jy-api.111312.xyz/notifications';
    const MONITORING_PROXY_API = 'https://up-api.111312.xyz/';
    const WEATHER_API = 'https://tq-api.111312.xyz';
    const NAS_API = 'https://nas-hook.111312.xyz/';

    // --- 全局变量和状态 ---
    let monitorDataCache = [];
    let notificationsLoaded = false;
    let weatherLoaded = false;
    let nasCpuHistoryChart, nasNetworkHistoryChart, nasTempHistoryChart;

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
            if (type === 'success') { setTimeout(() => { statusEl.innerHTML = ''; }, 5000); }
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

    // --- 4. 服务监控功能 (UptimeRobot + NAS History) ---
    const STATUS_MAP = { 0: { text: '暂停中', class: 'status-warning', icon: 'fa-pause-circle' }, 1: { text: '未检查', class: 'status-warning', icon: 'fa-question-circle' }, 2: { text: '运行中', class: 'status-up', icon: 'fa-check-circle' }, 8: { text: '疑似故障', class: 'status-warning', icon: 'fa-exclamation-circle' }, 9: { text: '服务中断', class: 'status-down', icon: 'fa-times-circle' } };
    
    function showMonitoringError(message) {
        const container = document.getElementById('monitoring-container');
        if (container) container.innerHTML = `<div class="error-state"><h2>加载数据失败</h2><p>${message}</p></div>`;
    }
    
    // 【已修正】清理并简化 initMonitoring 函数
    async function initMonitoring() {
        const container = document.getElementById('monitoring-container');
        if (container && !container.innerHTML.trim()) { 
            container.innerHTML = `<div class="loading-state"><div class="loading-spinner"></div><p>正在加载服务监控数据...</p></div>`; 
        }
        
        try {
            // 只发起一次请求到我们的“数据中心”Worker
            const response = await fetch(MONITORING_PROXY_API, { method: 'POST', cache: 'no-cache' });
            if (!response.ok) throw new Error(`API 请求失败: ${response.status}`);
            
            const data = await response.json();
            if (data.stat === 'fail') throw new Error(`API 返回错误: ${(data.error || {}).message || '未知'}`);
            
            // 直接将获取到的完整 data 对象传递给渲染函数
            renderCombinedMonitoringPage(data);

        } catch (error) {
            console.error('获取监控数据失败:', error);
            showMonitoringError(error.message);
        }
    }

    function renderCombinedMonitoringPage(data) {
        const container = document.getElementById('monitoring-container');
        if (!container) return;
        container.innerHTML = '';

        const hasNasHistory = data.nas_history && (data.nas_history.cpu?.length > 0 || data.nas_history.network?.length > 0 || data.nas_history.temp?.length > 0);
        const hasMonitors = data.monitors && data.monitors.length > 0;

        if (!hasNasHistory && !hasMonitors) {
            showMonitoringError("未能加载任何监控数据。");
            return;
        }

        if (hasNasHistory) {
            const nasSection = document.createElement('div');
            nasSection.className = 'nas-section';
            nasSection.innerHTML = `
                <h2 class="section-title"><i class="fas fa-server"></i><span>NAS 历史趋势 (7天)</span></h2>
                <div class="charts-grid">
                    <div class="chart-container"><div class="chart-header"><h3 class="chart-title">CPU 使用率</h3></div><div class="nas-chart-wrapper"><canvas id="nasCpuHistoryChart"></canvas></div></div>
                    <div class="chart-container"><div class="chart-header"><h3 class="chart-title">网络总流量</h3></div><div class="nas-chart-wrapper"><canvas id="nasNetworkHistoryChart"></canvas></div></div>
                    <div class="chart-container" id="nas-temp-history-chart-container" style="display: none;"><div class="chart-header"><h3 class="chart-title">温度变化</h3></div><div class="nas-chart-wrapper"><canvas id="nasTempHistoryChart"></canvas></div></div>
                </div>`;
            container.appendChild(nasSection);
            renderNasHistoryCharts(data.nas_history);
        }

        if (hasMonitors) {
            const monitors = data.monitors;
            monitorDataCache = monitors;
            let totalUptime = 0;
            monitors.forEach(m => {
                totalUptime += parseFloat(m.custom_uptime_ratios?.split('-')[0] || m.all_time_uptime_ratio || 0);
            });
            const servicesHTML = monitors.map(monitor => {
                const status = STATUS_MAP[monitor.status] || { text: '未知', class: 'status-warning', icon: 'fa-question-circle' };
                return `<div class="service-card" id="monitor-card-${monitor.id}"> <div class="service-card-header" onclick="toggleDetailChart(${monitor.id})"> <div class="service-header"> <div class="service-name">${monitor.friendly_name} <i class="fas fa-chevron-down"></i></div> <div class="service-status ${status.class}"><i class="fas ${status.icon}"></i> ${status.text}</div> </div> </div> <div class="service-details"> <div class="service-details-content"> <div class="detail-chart-container"><canvas id="detail-chart-${monitor.id}"></canvas></div> </div> </div> </div>`;
            }).join('');
            
            const uptimeContainer = document.createElement('div');
            uptimeContainer.id = 'uptime-robot-container';
            uptimeContainer.innerHTML = `
                <h2 class="section-title"><i class="fas fa-network-wired"></i><span>网站服务监控 (UptimeRobot)</span></h2>
                <div class="charts-grid">
                    <div class="summary-card uptime"><div class="card-icon"><i class="fas fa-chart-line"></i></div><div class="card-title">平均正常率 (7天)</div><div class="card-value">${monitors.length > 0 ? (totalUptime / monitors.length).toFixed(2) : '0'}%</div></div>
                    <div class="chart-container"><div class="chart-header"><h3 class="chart-title">平均响应时间 (24小时)</h3></div><div class="chart-wrapper"><canvas id="responseTimeChart"></canvas></div></div>
                </div>
                <div class="services-grid" style="margin-top: 30px;">
                    <div id="services-list">${servicesHTML}</div>
                </div>`;
            container.appendChild(uptimeContainer);
            renderOverviewCharts(monitors);
        }
    }
    
    function renderNasHistoryCharts(history) {
        if (nasCpuHistoryChart) nasCpuHistoryChart.destroy();
        if (nasNetworkHistoryChart) nasNetworkHistoryChart.destroy();
        if (nasTempHistoryChart) nasTempHistoryChart.destroy();
        
        const cpuCtx = document.getElementById('nasCpuHistoryChart')?.getContext('2d');
        if (cpuCtx && history.cpu && history.cpu.length > 0) {
            nasCpuHistoryChart = new Chart(cpuCtx, { type: 'line', data: { datasets: [{ label: 'CPU Usage (%)', data: history.cpu.map(d => ({x: d.timestamp * 1000, y: d.usage})), borderColor: 'rgba(30, 136, 229, 0.7)', backgroundColor: 'rgba(30, 136, 229, 0.1)', borderWidth: 1.5, pointRadius: 0, tension: 0.4, fill: true }] }, options: { responsive: true, maintainAspectRatio: false, scales: { x: { type: 'time', time: { unit: 'day' }, ticks: { font: { size: 10 } } }, y: { beginAtZero: true, max: 100, ticks: { font: { size: 10 } } } }, plugins: { legend: { display: false }, tooltip: { enabled: !isMobile, mode: 'x', intersect: false } } } });
        }
        const netCtx = document.getElementById('nasNetworkHistoryChart')?.getContext('2d');
        if (netCtx && history.network && history.network.length > 0) {
            nasNetworkHistoryChart = new Chart(netCtx, { type: 'line', data: { datasets: [{ label: '总接收 (GB)', data: history.network.map(d => ({ x: d.timestamp * 1000, y: d.total_recv / 1024**3 })), borderColor: 'rgba(76, 175, 80, 0.7)', fill: false, borderWidth: 1.5, pointRadius: 0, tension: 0.4 }, { label: '总发送 (GB)', data: history.network.map(d => ({ x: d.timestamp * 1000, y: d.total_sent / 1024**3 })), borderColor: 'rgba(255, 152, 0, 0.7)', fill: false, borderWidth: 1.5, pointRadius: 0, tension: 0.4 }] }, options: { responsive: true, maintainAspectRatio: false, scales: { x: { type: 'time', time: { unit: 'day' }, ticks: { font: { size: 10 } } }, y: { beginAtZero: true, title: { display: !isMobile, text: 'GB' }, ticks: { font: { size: 10 } } } }, plugins: { legend: { display: !isMobile, position: 'bottom', labels: { font: { size: 10 } } }, tooltip: { enabled: !isMobile, mode: 'x', intersect: false } } } });
        }
        if (history.temp && history.temp.length > 0) {
            const tempContainer = document.getElementById('nas-temp-history-chart-container');
            if (tempContainer) tempContainer.style.display = 'block';
            const tempCtx = document.getElementById('nasTempHistoryChart')?.getContext('2d');
            if(tempCtx) {
                nasTempHistoryChart = new Chart(tempCtx, { type: 'line', data: { datasets: [{ label: '温度 (°C)', data: history.temp.map(d => ({ x: d.timestamp * 1000, y: d.temperature })), borderColor: 'rgba(244, 67, 54, 0.7)', backgroundColor: 'rgba(244, 67, 54, 0.1)', borderWidth: 1.5, pointRadius: 0, tension: 0.4, fill: true }] }, options: { responsive: true, maintainAspectRatio: false, scales: { x: { type: 'time', time: { unit: 'day' }, ticks: { font: { size: 10 } } }, y: { beginAtZero: false, title: { display: !isMobile, text: '°C' }, ticks: { font: { size: 10 } } } }, plugins: { legend: { display: false }, tooltip: { enabled: !isMobile, mode: 'x', intersect: false } } } });
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
        }
    };
    function createDetailChart(monitor) {
        const canvasId = `detail-chart-${monitor.id}`, ctx = document.getElementById(canvasId)?.getContext('2d');
        if (!ctx) return;
        if (Chart.getChart(ctx)) Chart.getChart(ctx).destroy();
        const chartData = monitor.response_times.map(rt => ({ x: rt.datetime * 1000, y: rt.value })).reverse();
        new Chart(ctx, { type: 'line', data: { datasets: [{ label: '响应时间 (ms)', data: chartData, borderColor: 'rgba(30, 136, 229, 0.5)', backgroundColor: 'rgba(30, 136, 229, 0.1)', borderWidth: 1, tension: 0.3, fill: true, pointRadius: 0 }] }, options: { responsive: true, maintainAspectRatio: false, scales: { x: { type: 'time', time: { unit: 'hour' }, ticks: { font: { size: 10 } } }, y: { beginAtZero: true, ticks: { font: { size: 10 } } } }, plugins: { legend: { display: false }, tooltip: { enabled: !isMobile, mode: 'x', intersect: false } } } });
    }
    function renderOverviewCharts(monitors) {
        const rtCtx = document.getElementById('responseTimeChart')?.getContext('2d');
        if (rtCtx) {
            if (Chart.getChart(rtCtx)) Chart.getChart(rtCtx).destroy();
            new Chart(rtCtx, { type: 'bar', data: { labels: monitors.map(m => m.friendly_name.substring(0, isMobile ? 5 : 12) + (m.friendly_name.length > (isMobile ? 5 : 12) ? '...' : '')), datasets: [{ label: '响应时间 (ms)', data: monitors.map(m => m.average_response_time || 0), backgroundColor: 'rgba(30, 136, 229, 0.7)' }] }, options: { responsive: true, maintainAspectRatio: false, scales: { x: { ticks: { font: { size: 10 } } }, y: { beginAtZero: true, ticks: { font: { size: 10 } } } }, plugins: { legend: { display: false }, tooltip: { enabled: !isMobile, mode: 'x', intersect: false } } } });
        }
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
            new Chart(canvas, { type: 'line', data: { datasets: datasets }, options: { responsive: true, interaction: { mode: 'x', intersect: false, }, plugins: { title: { display: true, text: `${cityName} - 24小时趋势`, font: { size: isMobile ? 14 : 18 } }, legend: { display: !isMobile, position: 'bottom', labels: { font: { size: 10 } } } }, scales: { x: { type: 'time', time: { unit: 'hour', tooltipFormat: 'HH:mm', displayFormats: { hour: 'HH:mm' } }, title: { display: false }, ticks: { font: { size: 10 } } }, y: { type: 'linear', display: true, position: 'left', title: { display: !isMobile, text: '温度 (°C)' }, ticks: { font: { size: 10 } } }, y1: { type: 'linear', display: true, position: 'right', title: { display: !isMobile, text: '湿度 (%)' }, grid: { drawOnChartArea: false }, ticks: { font: { size: 10 } } } } } });
        }
    }

    // --- 6. NAS 实时监控模块 (顶部) ---
    (() => {
        let previousCpuData = null, previousNetData = null, lastFetchTime = null, bootTimestamp = 0;
        
        function nas_formatBytes(bytes, decimals = 1) {
            if (bytes === undefined || bytes === null || bytes <= 0) return '0 B';
            const k = 1024;
            const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
            const i = Math.floor(Math.log(bytes) / Math.log(k));
            return `${parseFloat((bytes / Math.pow(k, i)).toFixed(decimals))} ${sizes[i]}`;
        }
        function nas_formatSpeed(bytesPerSecond, decimals = 2) {
             if (bytesPerSecond === undefined || bytesPerSecond === null || bytesPerSecond < 1) return `0 KB/s`;
            const k = 1024;
            const sizes = ['B/s', 'KB/s', 'MB/s', 'GB/s'];
            const i = Math.floor(Math.log(bytesPerSecond) / Math.log(k));
            return `${parseFloat((bytesPerSecond / Math.pow(k, i)).toFixed(decimals))} ${sizes[i]}`;
        }
        function nas_formatUptime(seconds) {
            if (!seconds || seconds <= 0) return '--';
            seconds = Math.floor(seconds);
            const d = Math.floor(seconds / 86400);
            const h = Math.floor(seconds % 86400 / 3600);
            const m = Math.floor(seconds % 3600 / 60);
            return `${d}天 ${h}小时 ${m}分钟`;
        }

        function parseNasRealtimeMetrics(text) {
            const metrics = { cpu: { total: 0, idle: 0 }, memory: { total: 0, available: 0 }, network: { received: 0, transmitted: 0 }, bootTime: 0, temp: null, filesystems: {} };
            const targetInterfaces = ['eth0', 'wlan0'];
            const targetMountpoint = '/etc/hostname';
            const lines = text.split('\n');
            for (const line of lines) {
                if (line.startsWith('#')) continue;
                const parts = line.split(' ');
                const value = parseFloat(parts[1]);
                if (line.startsWith('node_cpu_seconds_total')) {
                    metrics.cpu.total += value;
                    if (line.includes('mode="idle"')) metrics.cpu.idle += value;
                } else if (line.startsWith('node_memory_MemTotal_bytes')) metrics.memory.total = value;
                else if (line.startsWith('node_memory_MemAvailable_bytes')) metrics.memory.available = value;
                else if (line.startsWith('node_network_receive_bytes_total') || line.startsWith('node_network_transmit_bytes_total')) {
                    const isReceive = line.startsWith('node_network_receive_bytes_total');
                    const interfaceMatch = line.match(/device="([^"]+)"/);
                    if (interfaceMatch && targetInterfaces.includes(interfaceMatch[1])) {
                        if (isReceive) metrics.network.received += value;
                        else metrics.network.transmitted += value;
                    }
                } else if (line.startsWith('node_boot_time_seconds')) metrics.bootTime = value;
                else if (line.startsWith('node_thermal_zone_temp') || line.startsWith('node_hwmon_temp_input')) {
                     if (metrics.temp === null) metrics.temp = value;
                }
                else if (line.startsWith('node_filesystem_size_bytes') || line.startsWith('node_filesystem_avail_bytes')) {
                    const mountpointMatch = line.match(/mountpoint="([^"]+)"/);
                    if (mountpointMatch && mountpointMatch[1] === targetMountpoint) {
                        const mountpoint = mountpointMatch[1];
                        if (!metrics.filesystems[mountpoint]) metrics.filesystems[mountpoint] = { size: 0, avail: 0 };
                        if (line.startsWith('node_filesystem_size_bytes')) metrics.filesystems[mountpoint].size = value;
                        if (line.startsWith('node_filesystem_avail_bytes')) metrics.filesystems[mountpoint].avail = value;
                    }
                }
            }
            return metrics;
        }

        async function updateNasDisplay() {
            const statusText = document.getElementById('nas-status-text');
            const errorText = document.getElementById('nas-error-text');
            try {
                const response = await fetch(NAS_API);
                if (!response.ok) throw new Error(`请求失败: ${response.status}`);
                const text = await response.text();
                const now = Date.now();
                const currentMetrics = parseNasRealtimeMetrics(text);
                
                if (previousCpuData) {
                    const totalDiff = currentMetrics.cpu.total - previousCpuData.total;
                    const idleDiff = currentMetrics.cpu.idle - previousCpuData.idle;
                    document.getElementById('nas-cpu-usage').textContent = `${(totalDiff > 0 ? 100 * (1 - (idleDiff / totalDiff)) : 0).toFixed(1)}%`;
                }
                
                const memUsed = currentMetrics.memory.total - currentMetrics.memory.available;
                document.getElementById('nas-mem-usage').textContent = `${(100 * memUsed / currentMetrics.memory.total).toFixed(1)}%`;
                document.getElementById('nas-mem-details').textContent = `${nas_formatBytes(memUsed, 2)}/${nas_formatBytes(currentMetrics.memory.total, 2)}`;
                
                if (currentMetrics.temp !== null) {
                    document.getElementById('nas-temp-card').style.display = 'flex';
                    document.getElementById('nas-temp-value').textContent = `${currentMetrics.temp.toFixed(1)}°C`;
                }

                if (previousNetData && lastFetchTime) {
                    const timeDelta = (now - lastFetchTime) / 1000;
                    const downSpeed = (currentMetrics.network.received - previousNetData.received) / timeDelta;
                    const upSpeed = (currentMetrics.network.transmitted - previousNetData.transmitted) / timeDelta;
                    document.getElementById('nas-net-speed').textContent = `${nas_formatSpeed(upSpeed)} / ${nas_formatSpeed(downSpeed)}`;
                }

                const diskData = currentMetrics.filesystems['/etc/hostname'];
                if (diskData && diskData.size > 0) {
                    const diskUsed = diskData.size - diskData.avail;
                    const diskPercent = (100 * diskUsed / diskData.size).toFixed(1);
                    document.getElementById('nas-disk-usage').textContent = `${diskPercent}%`;
                    document.getElementById('nas-disk-details').textContent = `(${nas_formatBytes(diskUsed)}/${nas_formatBytes(diskData.size)})`;
                }

                if (currentMetrics.bootTime > 0) {
                    bootTimestamp = currentMetrics.bootTime;
                    document.getElementById('nas-boot-time').textContent = `开机于: ${new Date(bootTimestamp * 1000).toLocaleDateString()}`;
                }

                previousCpuData = currentMetrics.cpu;
                previousNetData = currentMetrics.network;
                lastFetchTime = now;
                if (statusText) statusText.textContent = `上次更新: ${new Date().toLocaleTimeString()}`;
                if (errorText) errorText.textContent = '';
            } catch (error) {
                console.error('更新NAS状态失败:', error);
                if (errorText) errorText.textContent = `错误: ${error.message}`;
            }
        }
        
        function updateUptime() {
            if (bootTimestamp > 0) {
                const uptimeEl = document.getElementById('nas-system-uptime');
                if (uptimeEl) uptimeEl.textContent = nas_formatUptime((Date.now() / 1000) - bootTimestamp);
            }
        }

        updateNasDisplay();
        setInterval(updateNasDisplay, 10000);
        setInterval(updateUptime, 1000);
    })();

    // --- 初始化函数 ---
    function initialize() {
        updateTime();
        setInterval(updateTime, 1000);
        countSites();
        handleTabs();
        initMonitoring();
        const refreshBtn = document.getElementById('refresh-notifications-btn');
        if (refreshBtn) refreshBtn.addEventListener('click', fetchNotifications);
    }

    initialize();
});
