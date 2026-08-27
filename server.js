const express = require('express');
const fetch = require('node-fetch');
const https = require('https');

const app = express();

// ==========================================
// 1. Worker設定
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
// 2. HTTPS Agent
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

        rrIndex = 0;

        return workers[0];
    }

    const worker =
        active[rrIndex % active.length];

    rrIndex++;

    return worker;
}

// ==========================================
// 4. Worker失敗
// ==========================================

function markWorkerFailure(worker) {

    worker.failCount++;

    console.warn(
        `⚠️ Worker failed: ${worker.url} ` +
        `(${worker.failCount}/3)`
    );

    if (worker.failCount >= 3) {

        worker.isAlive = false;

        console.error(
            `🚨 Worker isolated: ${worker.url}`
        );
    }
}

// ==========================================
// 5. Worker成功
// ==========================================

function markWorkerSuccess(worker) {

    worker.failCount = 0;
    worker.isAlive = true;
}

// ==========================================
// 6. Worker自動復旧
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
                    timeout: 5000
                }
            );

            if (
                response.ok ||
                response.status === 404 ||
                response.status === 302
            ) {

                console.log(
                    `✅ Worker recovered: ${worker.url}`
                );

                markWorkerSuccess(worker);
            }

        } catch {
            // まだ復旧していない
        }
    }

}, 30000);

// ==========================================
// 7. Request Body
// ==========================================

app.use(
    express.raw({
        type: '*/*',
        limit: '50mb'
    })
);

// ==========================================
// 8. メインProxy
// ==========================================

app.all('*', async (req, res) => {

    // ======================================
    // Service Workerは絶対にプロキシしない
    // ======================================

    if (
        req.path === '/sw.js' ||
        req.path === '/service-worker.js' ||
        req.path.endsWith('/sw.js') ||
        req.path.endsWith('/service-worker.js')
    ) {

        console.log(
            `BLOCK SW: ${req.method} ${req.url}`
        );

        res.set(
            'Cache-Control',
            'no-store, no-cache, must-revalidate'
        );

        return res
            .status(404)
            .send('Not Found');
    }

    // ======================================
    // favicon
    // ======================================

    if (req.path === '/favicon.ico') {
        return res.status(204).end();
    }

    // ======================================
    // Worker
    // ======================================

    const maxRetries = workers.length;

    let attempt = 0;

    while (attempt < maxRetries) {

        attempt++;

        const worker = getActiveWorker();

        const targetUrl =
            worker.url + req.url;

        console.log(
            `➡️ ${req.method} ${targetUrl}`
        );

        // ==================================
        // Request Headers
        // ==================================

        const headers = {
            ...req.headers
        };

        // プロキシ先へそのまま送ると
        // 壊れやすいヘッダーを削除
        delete headers.host;
        delete headers.connection;
        delete headers['content-length'];

        // ==================================
        // Forward情報
        // ==================================

        headers['x-forwarded-host'] =
            req.get('host') || '';

        headers['x-forwarded-proto'] =
            'https';

        // ==================================
        // Proxy Request
        // ==================================

        try {

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

            // ==================================
            // Worker Server Error
            // ==================================

            if (response.status >= 500) {

                console.warn(
                    `⚠️ Worker returned ${response.status}`
                );

                markWorkerFailure(worker);

                continue;
            }

            // ==================================
            // Worker成功
            // ==================================

            markWorkerSuccess(worker);

            // ==================================
            // Response Headers
            // ==================================

            const blockedHeaders = new Set([
                'content-encoding',
                'transfer-encoding',
                'content-length',
                'content-security-policy',
                'content-security-policy-report-only'
            ]);

            response.headers.forEach(
                (value, key) => {

                    const lower =
                        key.toLowerCase();

                    if (
                        blockedHeaders.has(lower)
                    ) {
                        return;
                    }

                    // Set-Cookieは後で処理
                    if (lower === 'set-cookie') {
                        return;
                    }

                    res.set(key, value);
                }
            );

            // ==================================
            // Cookie処理
            // ==================================

            if (
                response.headers.raw &&
                typeof response.headers.raw === 'function'
            ) {

                const cookies =
                    response.headers
                        .raw()['set-cookie'];

                if (
                    cookies &&
                    cookies.length > 0
                ) {

                    const rewrittenCookies =
                        cookies.map(cookie => {

                            // aniwaves.ruのDomainを
                            // ブラウザ側ドメインに固定しない
                            return cookie.replace(
                                /;\s*Domain=[^;]*/gi,
                                ''
                            );
                        });

                    res.setHeader(
                        'Set-Cookie',
                        rewrittenCookies
                    );
                }
            }

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
            //
            // ★重要
            // HTMLは一切書き換えない
            //
            // 広告削除もしない
            // script注入もしない
            // DOM変更もしない
            //
            // これで黒画面の原因になる
            // HTML破壊を完全に避ける
            // ==================================

            if (
                contentType
                    .toLowerCase()
                    .includes('text/html')
            ) {

                const html =
                    await response.text();

                console.log(
                    `HTML ${Buffer.byteLength(
                        html,
                        'utf8'
                    )} bytes`
                );

                res.set(
                    'Content-Type',
                    contentType
                );

                return res
                    .status(response.status)
                    .send(html);
            }

            // ==================================
            // 静的ファイル
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
            // その他のファイル
            // ==================================

            res.status(response.status);

            return response.body.pipe(res);

        } catch (error) {

            console.error(
                `❌ Attempt ${attempt} failed`,
                error.message
            );

            markWorkerFailure(worker);
        }
    }

    // ==========================================
    // 全Worker失敗
    // ==========================================

    console.error(
        '🚨 ALL WORKERS FAILED'
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
// 9. 起動
// ==========================================

const PORT =
    process.env.PORT || 8000;

app.listen(
    PORT,
    () => {

        console.log('');
        console.log(
            '=========================================='
        );
        console.log(
            '        PROXY ENGINE ONLINE'
        );
        console.log(
            '=========================================='
        );
        console.log(
            `PORT: ${PORT}`
        );
        console.log(
            `WORKER: ${WORKER_CONFIGS.join(', ')}`
        );
        console.log(
            'HTML REWRITE: OFF'
        );
        console.log(
            'AD CLEANER: OFF'
        );
        console.log(
            'SERVICE WORKER: BLOCKED'
        );
        console.log(
            '=========================================='
        );
        console.log('');
    }
);
