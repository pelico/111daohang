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
    // ... [此模块代码保持不变] ...
    async function fetchNotifications() {
        // ...
    }
    function showNotificationStatus(message, type = 'info') {
        // ...
    }

    // --- 4. 服务监控功能 (UptimeRobot + NAS History) ---
    const STATUS_MAP = { /* ... */ };
    
    // 【已修改】服务监控页面的渲染逻辑
    async function initMonitoring() {
        const container = document.getElementById('monitoring-container');
        if (container && !container.innerHTML.trim()) { 
            container.innerHTML = `<div class="loading-state"><div class="loading-spinner"></div><p>正在加载服务监控数据...</p></div>`; 
        }
        
        // 并行获取 UptimeRobot 和 NAS 历史数据
        try {
            const [uptimeResponse, nasResponse] = await Promise.all([
                fetch(MONITORING_PROXY_API, { method: 'POST', cache: 'no-cache' }),
                fetch(NAS_API) // NAS 历史数据也从这个接口获取
            ]);

            if (!uptimeResponse.ok) throw new Error(`UptimeRobot API 请求失败: ${uptimeResponse.status}`);
            if (!nasResponse.ok) throw new Error(`NAS API 请求失败: ${nasResponse.status}`);

            const uptimeData = await uptimeResponse.json();
            const nasTextData = await nasResponse.text();

            if (uptimeData.stat !== 'ok') throw new Error(`UptimeRobot API 返回错误: ${(uptimeData.error || {}).message || '未知'}`);
            
            const nasMetrics = parseNasMetrics(nasTextData); // 复用解析函数
            
            renderCombinedMonitoringPage(uptimeData, nasMetrics.history); // 新的渲染函数

        } catch (error) {
            console.error('获取监控数据失败:', error);
            showMonitoringError(error.message);
        }
    }

    function renderCombinedMonitoringPage(uptimeData, nasHistory) {
        const container = document.getElementById('monitoring-container');
        if (!container) return;
        container.innerHTML = ''; // 清空加载动画

        // A. 渲染 NAS 图表
        if (nasHistory) {
            // ... [NAS 图表渲染逻辑，与之前版本相同] ...
        }

        // B. 渲染 UptimeRobot 部分
        if (uptimeData.monitors) {
            // ... [UptimeRobot 渲染逻辑，与之前版本相同] ...
        }
    }
    // ... [其他服务监控函数 toggleDetailChart, createDetailChart, renderOverviewCharts, showMonitoringError 保持不变] ...

    // --- 5. 天气仪表盘功能 ---
    // ... [此模块代码保持不变，但图表选项会根据 isMobile 调整] ...
    function displayTrendCharts(historyData){
        // ... 内部 new Chart({...}) 的 options 部分增加移动端判断
    }

    // --- 6. NAS 实时监控模块 (顶部) ---
    (() => {
        let previousCpuData = null, previousNetData = null, lastFetchTime = null, bootTimestamp = 0;
        
        function nas_formatBytes(bytes, decimals = 1) { /* ... */ }
        function nas_formatSpeed(bytes, decimals = 2) { /* ... */ }
        function nas_formatUptime(seconds) { /* ... */ }
        function parseNasMetrics(text) {
            // 【已修改】增加对历史数据的解析
            const metrics = {
                realtime: { cpu: { total: 0, idle: 0 }, memory: { total: 0, available: 0 }, network: { received: 0, transmitted: 0 }, bootTime: 0, temp: null, filesystems: {} },
                history: { cpu: [], network: [], temp: [] } // 假设历史数据也从这里解析
            };
            // ... 解析逻辑 ...
            return metrics;
        }

        async function updateNasDisplay() {
            try {
                const response = await fetch(NAS_API);
                if (!response.ok) throw new Error(`请求失败: ${response.status}`);
                const text = await response.text();
                const now = Date.now();
                const currentMetrics = parseNasMetrics(text).realtime; // 只取实时数据
                
                // --- 计算 & 更新 UI ---
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
                if (diskData) {
                    const diskUsed = diskData.size - diskData.avail;
                    const diskPercent = (100 * diskUsed / diskData.size).toFixed(1);
                    document.getElementById('nas-disk-usage').textContent = `${diskPercent}%`; // 【已修改】更新新的元素
                    document.getElementById('nas-disk-details').textContent = `(${nas_formatBytes(diskUsed)}/${nas_formatBytes(diskData.size)})`;
                }

                if (currentMetrics.bootTime > 0) {
                    bootTimestamp = currentMetrics.bootTime;
                    document.getElementById('nas-boot-time').textContent = `开机于: ${new Date(bootTimestamp * 1000).toLocaleDateString()}`;
                }

                previousCpuData = currentMetrics.cpu;
                previousNetData = currentMetrics.network;
                lastFetchTime = now;
                
                const statusText = document.getElementById('nas-status-text');
                if (statusText) statusText.textContent = `上次更新: ${new Date().toLocaleTimeString()}`;
            } catch (error) {
                // ...
            }
        }
        
        function updateUptime() { /* ... */ }

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
        initMonitoring(); // 现在这个函数会处理所有服务监控的加载
        const refreshBtn = document.getElementById('refresh-notifications-btn');
        if (refreshBtn) refreshBtn.addEventListener('click', fetchNotifications);
    }

    initialize();
});
