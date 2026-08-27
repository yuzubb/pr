const express = require('express');
const fetch = require('node-fetch');
const https = require('https');

const app = express();

// ==========================================
// Worker
// ==========================================

const WORKER_CONFIGS = [
    'https://aniwaves.ru'
];

const workers = WORKER_CONFIGS.map(url => ({
    url: url.replace(/\/$/, ''),
    isAlive: true,
    failCount: 0
}));

let rrIndex = 0;

// ==========================================
// HTTPS Agent
// ==========================================

const proxyAgent = new https.Agent({
    keepAlive: true,
    maxSockets: 600,
    timeout: 60000
});

// ==========================================
// Worker選択
// ==========================================

function getActiveWorker() {

    const active = workers.filter(
        worker => worker.isAlive
    );

    if (active.length === 0) {

        console.warn(
            '⚠️ ALL WORKERS DOWN - RESETTING'
        );

        workers.forEach(worker => {
            worker.isAlive = true;
            worker.failCount = 0;
        });

        return workers[0];
    }

    const worker =
        active[rrIndex % active.length];

    rrIndex++;

    return worker;
}

// ==========================================
// Worker失敗
// ==========================================

function markWorkerFailure(worker) {

    worker.failCount++;

    console.warn(
        `⚠️ Worker ${worker.url} failed ` +
        `(${worker.failCount}/3)`
    );

    if (worker.failCount >= 3) {

        worker.isAlive = false;

        console.error(
            `🚨 Worker ${worker.url} isolated`
        );
    }
}

// ==========================================
// Worker成功
// ==========================================

function markWorkerSuccess(worker) {

    worker.failCount = 0;
    worker.isAlive = true;
}

// ==========================================
// Worker自動復旧
// ==========================================

setInterval(async () => {

    for (const worker of workers) {

        if (worker.isAlive) {
            continue;
        }

        try {

            const response = await fetch(
                worker.url + '/favicon.ico',
                {
                    method: 'GET',
                    agent: proxyAgent,
                    timeout: 5000,
                    headers: {
                        'User-Agent':
                            'Mozilla/5.0'
                    }
                }
            );

            if (
                response.ok ||
                response.status === 404 ||
                response.status === 302
            ) {

                console.log(
                    `✅ Worker ${worker.url} recovered`
                );

                markWorkerSuccess(worker);
            }

        } catch {
            // まだ復旧していない
        }
    }

}, 30000);

// ==========================================
// Express Body
// ==========================================

app.use(
    express.raw({
        type: '*/*',
        limit: '50mb'
    })
);

// ==========================================
// Proxy
// ==========================================

app.all('*', async (req, res) => {

    // favicon
    if (req.path === '/favicon.ico') {
        return res.status(204).end();
    }

    const maxRetries =
        Math.max(workers.length, 1);

    let attempt = 0;

    while (attempt < maxRetries) {

        attempt++;

        const worker =
            getActiveWorker();

        const targetUrl =
            worker.url + req.originalUrl;

        // ======================================
        // Browser → Worker Header
        // ======================================

        const headers = {
            ...req.headers
        };

        // --------------------------------------
        // プロキシで不要なヘッダーを削除
        // --------------------------------------

        delete headers.host;
        delete headers.connection;
        delete headers['content-length'];

        // 元サイトの圧縮をnode-fetchに任せる
        delete headers['accept-encoding'];

        // --------------------------------------
        // yuzu3da.com の Origin を送らない
        // --------------------------------------

        delete headers.origin;

        // --------------------------------------
        // yuzu3da.com の Referer を送らない
        // --------------------------------------

        delete headers.referer;

        // --------------------------------------
        // Forwarded系も送らない
        // --------------------------------------

        delete headers['x-forwarded-host'];
        delete headers['x-forwarded-proto'];
        delete headers['x-forwarded-for'];

        // ======================================
        // Workerへ送る情報
        // ======================================

        if (!headers['user-agent']) {

            headers['user-agent'] =
                'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) ' +
                'AppleWebKit/605.1.15 ' +
                '(KHTML, like Gecko) ' +
                'Version/18.0 Mobile/15E148 Safari/604.1';
        }

        try {

            console.log(
                `➡️ ${req.method} ${targetUrl}`
            );

            const response = await fetch(
                targetUrl,
                {
                    method: req.method,

                    headers,

                    agent: proxyAgent,

                    compress: true,

                    redirect: 'follow',

                    timeout: 20000,

                    body:
                        req.method !== 'GET' &&
                        req.method !== 'HEAD'
                            ? req.body
                            : undefined
                }
            );

            console.log(
                `⬅️ ${response.status} ${targetUrl}`
            );

            // ==================================
            // Workerエラー
            // ==================================

            if (response.status >= 500) {

                markWorkerFailure(worker);

                continue;
            }

            markWorkerSuccess(worker);

            // ==================================
            // Response Headers
            // ==================================

            const blockedHeaders = new Set([
                'content-encoding',
                'content-length',
                'transfer-encoding',
                'content-security-policy',
                'content-security-policy-report-only'
            ]);

            response.headers.forEach(
                (value, key) => {

                    if (
                        blockedHeaders.has(
                            key.toLowerCase()
                        )
                    ) {
                        return;
                    }

                    res.set(
                        key,
                        value
                    );
                }
            );

            // ==================================
            // Content-Type
            // ==================================

            const contentType =
                response.headers.get(
                    'content-type'
                ) || '';

            // ==================================
            // HTML
            // ==================================

            if (
                contentType
                    .toLowerCase()
                    .includes('text/html')
            ) {

                const html =
                    await response.text();

                console.log(
                    `📄 HTML ${html.length} bytes`
                );

                // ==================================
                // HTMLは完全にそのまま返す
                // 広告削除なし
                // JS注入なし
                // HTML書き換えなし
                // ==================================

                res.set(
                    'Content-Type',
                    response.headers.get(
                        'content-type'
                    ) ||
                    'text/html; charset=utf-8'
                );

                return res
                    .status(response.status)
                    .send(html);
            }

            // ==================================
            // 静的ファイル
            // ==================================

            if (
                req.originalUrl.includes('_p_')
            ) {

                res.set(
                    'Cache-Control',
                    'public, max-age=31536000, immutable'
                );
            }

            // ==================================
            // Streaming
            // ==================================

            res.status(
                response.status
            );

            return response.body.pipe(res);

        } catch (error) {

            console.error(
                `❌ Attempt ${attempt} failed:`,
                error.message
            );

            markWorkerFailure(worker);
        }
    }

    // ==========================================
    // 全Worker失敗
    // ==========================================

    console.error(
        '❌ All workers failed'
    );

    if (!res.headersSent) {

        return res
            .status(502)
            .send(
                'Proxy Service Unavailable'
            );
    }
});

// ==========================================
// Start
// ==========================================

const PORT =
    process.env.PORT || 8000;

app.listen(
    PORT,
    () => {

        console.log(
            '======================================'
        );

        console.log(
            '   PROXY ENGINE ONLINE'
        );

        console.log(
            `   PORT: ${PORT}`
        );

        console.log(
            '   WORKER: https://aniwaves.ru'
        );

        console.log(
            '   HTML REWRITE: OFF'
        );

        console.log(
            '   AD CLEANER: OFF'
        );

        console.log(
            '======================================'
        );
    }
);
