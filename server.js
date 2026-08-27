const express = require('express');
const fetch = require('node-fetch');
const https = require('https');

const app = express();

// ==========================================
// 1. Worker設定
// ==========================================

const WORKER_CONFIGS = [
    "https://aniwaves.ru",
];

const workers = WORKER_CONFIGS.map(url => ({
    url: url.replace(/\/$/, ''),
    isAlive: true,
    failCount: 0
}));

let rrIndex = 0;

// ==========================================
// 2. 通信エージェント
// ==========================================

const proxyAgent = new https.Agent({
    keepAlive: true,
    maxSockets: 600,
    timeout: 60000
});

// ==========================================
// 3. Worker選択
// ==========================================

function getActiveWorker() {
    const active = workers.filter(w => w.isAlive);

    if (active.length === 0) {
        console.warn('⚠️ ALL WORKERS DOWN! Resetting pool...');

        workers.forEach(w => {
            w.isAlive = true;
            w.failCount = 0;
        });

        return workers[0];
    }

    return active[rrIndex++ % active.length];
}

function markWorkerFailure(worker) {
    worker.failCount++;

    console.warn(
        `⚠️ Worker [${worker.url}] failed (${worker.failCount}/3)`
    );

    if (worker.failCount >= 3) {
        worker.isAlive = false;

        console.error(
            `🚨 Worker [${worker.url}] IS ISOLATED`
        );
    }
}

function markWorkerSuccess(worker) {
    worker.failCount = 0;
    worker.isAlive = true;
}

// ==========================================
// 4. Worker自動復旧
// ==========================================

setInterval(async () => {
    for (const worker of workers) {
        if (!worker.isAlive) {
            try {
                const response = await fetch(
                    worker.url + '/favicon.ico',
                    {
                        method: 'GET',
                        agent: proxyAgent,
                        timeout: 5000
                    }
                );

                if (
                    response.ok ||
                    response.status === 404 ||
                    response.status === 302
                ) {
                    console.log(
                        `✅ Worker [${worker.url}] recovered`
                    );

                    markWorkerSuccess(worker);
                }

            } catch {
                // まだ死んでいるので何もしない
            }
        }
    }
}, 30000);

// ==========================================
// 5. Express Body
// ==========================================

app.use(
    express.raw({
        type: '*/*',
        limit: '50mb'
    })
);

// ==========================================
// 6. リクエスト処理
// ==========================================

app.all('*', async (req, res) => {

    if (req.url === '/favicon.ico') {
        return res.status(204).end();
    }

    const maxRetries = workers.length;
    let attempt = 0;

    while (attempt < maxRetries) {

        attempt++;

        const worker = getActiveWorker();
        const targetUrl = worker.url + req.url;

        const headers = {
            ...req.headers
        };

        delete headers.host;
        delete headers.connection;

        headers['X-Forwarded-Host'] = req.get('host');
        headers['X-Forwarded-Proto'] = 'https';

        try {

            const response = await fetch(
                targetUrl,
                {
                    method: req.method,
                    headers: headers,
                    agent: proxyAgent,
                    compress: true,
                    redirect: 'follow',
                    timeout: 12000,
                    body:
                        req.method !== 'GET' &&
                        req.method !== 'HEAD'
                            ? req.body
                            : undefined
                }
            );

            // ==================================
            // Workerエラー
            // ==================================

            if (response.status >= 500) {

                console.warn(
                    `⚠️ Worker [${worker.url}] returned ${response.status}`
                );

                markWorkerFailure(worker);
                continue;
            }

            markWorkerSuccess(worker);

            // ==================================
            // Response Header
            // ==================================

            response.headers.forEach((value, key) => {

                const blockedHeaders = [
                    'content-encoding',
                    'transfer-encoding',
                    'content-length',
                    'content-security-policy'
                ];

                if (
                    !blockedHeaders.includes(
                        key.toLowerCase()
                    )
                ) {
                    res.set(key, value);
                }
            });

            const contentType =
                response.headers.get(
                    'content-type'
                ) || '';

            // ==================================
            // HTML
            // ==================================

            if (
                contentType.toLowerCase().includes(
                    'text/html'
                )
            ) {

                const html =
                    await response.text();

                // ==================================
                // HTMLを一切加工せず、そのまま返す
                // ==================================

                res.set(
                    'Content-Type',
                    'text/html; charset=utf-8'
                );

                return res
                    .status(response.status)
                    .send(html);
            }

            // ==================================
            // 静的ファイルキャッシュ
            // ==================================

            if (
                req.url.includes('_p_')
            ) {

                res.set(
                    'Cache-Control',
                    'public, max-age=31536000, immutable'
                );
            }

            // ==================================
            // ストリーミング
            // ==================================

            res.status(response.status);

            return response.body.pipe(res);

        } catch (error) {

            console.error(
                `Attempt ${attempt} failed on [${worker.url}]:`,
                error.message
            );

            markWorkerFailure(worker);
        }
    }

    // ==========================================
    // 全Worker失敗
    // ==========================================

    console.error(
        'Fatal Error: All Workers failed.'
    );

    if (!res.headersSent) {

        res
            .status(502)
            .send(
                'Proxy Service Unavailable (All workers unreachable)'
            );
    }
});

// ==========================================
// 7. 起動
// ==========================================

const PORT =
    process.env.PORT || 8000;

app.listen(
    PORT,
    () => {
        console.log(
            '--- PROXY ENGINE ONLINE ---'
        );
    }
);
