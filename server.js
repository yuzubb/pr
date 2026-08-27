const express = require('express');
const fetch = require('node-fetch');
const https = require('https');

const app = express();

const WORKER_URL = 'https://aniwaves.ru';

const workers = [
    {
        url: WORKER_URL,
        isAlive: true,
        failCount: 0
    }
];

let rrIndex = 0;

const proxyAgent = new https.Agent({
    keepAlive: true,
    maxSockets: 600,
    timeout: 60000
});

// ==========================================
// Worker
// ==========================================

function getWorker() {
    const active = workers.filter(w => w.isAlive);

    if (!active.length) {
        workers.forEach(w => {
            w.isAlive = true;
            w.failCount = 0;
        });

        return workers[0];
    }

    return active[rrIndex++ % active.length];
}

function workerSuccess(worker) {
    worker.failCount = 0;
    worker.isAlive = true;
}

function workerFailure(worker) {
    worker.failCount++;

    console.log(
        `Worker failure ${worker.failCount}/3: ${worker.url}`
    );

    if (worker.failCount >= 3) {
        worker.isAlive = false;
    }
}

// ==========================================
// Body
// ==========================================

app.use(
    express.raw({
        type: '*/*',
        limit: '50mb'
    })
);

// ==========================================
// HTML URL rewrite
// ==========================================

function rewriteHtml(html, publicOrigin) {

    // 絶対URL
    html = html.replace(
        /https?:\/\/aniwaves\.ru/gi,
        publicOrigin
    );

    // //aniwaves.ru
    html = html.replace(
        /\/\/aniwaves\.ru/gi,
        publicOrigin.replace(/^https?:/, '')
    );

    return html;
}

// ==========================================
// Location rewrite
// ==========================================

function rewriteLocation(location, publicOrigin) {

    if (!location) {
        return location;
    }

    if (
        location.startsWith(WORKER_URL)
    ) {
        return (
            publicOrigin +
            location.substring(WORKER_URL.length)
        );
    }

    if (
        location.startsWith('//aniwaves.ru')
    ) {
        return (
            publicOrigin.replace(/^https?:/, '') +
            location.substring('//aniwaves.ru'.length)
        );
    }

    return location;
}

// ==========================================
// Service Worker
// ==========================================

app.get(
    ['/sw.js', '/service-worker.js'],
    (req, res) => {

        console.log(
            `BLOCK SERVICE WORKER: ${req.url}`
        );

        res.set(
            'Cache-Control',
            'no-store'
        );

        return res
            .status(404)
            .send('Not Found');
    }
);

// ==========================================
// favicon
// ==========================================

app.get(
    '/favicon.ico',
    (req, res) => {
        res.status(204).end();
    }
);

// ==========================================
// Proxy
// ==========================================

app.all('*', async (req, res) => {

    const worker = getWorker();

    const publicOrigin =
        `${req.protocol}://${req.get('host')}`;

    const targetUrl =
        worker.url + req.originalUrl;

    console.log(
        `➡️ ${req.method} ${targetUrl}`
    );

    const headers = {
        ...req.headers
    };

    // ======================================
    // 不要なHost系
    // ======================================

    delete headers.host;
    delete headers.connection;
    delete headers['content-length'];

    // ======================================
    // Workerへ正しいOrigin/Refererを送る
    // ======================================

    headers.origin = worker.url;

    headers.referer =
        worker.url + '/';

    // ======================================
    // Forward
    // ======================================

    headers['x-forwarded-host'] =
        req.get('host') || '';

    headers['x-forwarded-proto'] =
        'https';

    try {

        const response = await fetch(
            targetUrl,
            {
                method: req.method,

                headers,

                agent: proxyAgent,

                redirect: 'follow',

                compress: true,

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
        // Worker failure
        // ==================================

        if (response.status >= 500) {

            workerFailure(worker);

            return res
                .status(response.status)
                .send(
                    `Worker returned ${response.status}`
                );
        }

        workerSuccess(worker);

        // ==================================
        // Response headers
        // ==================================

        const contentType =
            response.headers.get(
                'content-type'
            ) || '';

        const blockedHeaders = new Set([
            'content-length',
            'content-encoding',
            'transfer-encoding',
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

                if (lower === 'location') {

                    const newLocation =
                        rewriteLocation(
                            value,
                            publicOrigin
                        );

                    res.set(
                        'Location',
                        newLocation
                    );

                    return;
                }

                if (lower === 'set-cookie') {
                    return;
                }

                res.set(
                    key,
                    value
                );
            }
        );

        // ==================================
        // Cookies
        // ==================================

        if (
            response.headers.raw &&
            typeof response.headers.raw === 'function'
        ) {

            const raw =
                response.headers.raw();

            const cookies =
                raw['set-cookie'];

            if (
                cookies &&
                cookies.length
            ) {

                const rewrittenCookies =
                    cookies.map(cookie => {

                        return cookie
                            .replace(
                                /;\s*Domain=[^;]+/gi,
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
        // HTML
        // ==================================

        if (
            contentType
                .toLowerCase()
                .includes('text/html')
        ) {

            let html =
                await response.text();

            console.log(
                `HTML SIZE: ${Buffer.byteLength(
                    html,
                    'utf8'
                )} bytes`
            );

            // ==================================
            // Worker URL → Proxy URL
            // ==================================

            html =
                rewriteHtml(
                    html,
                    publicOrigin
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
        // その他
        // ==================================

        res.status(response.status);

        return response.body.pipe(res);

    } catch (error) {

        console.error(
            'PROXY ERROR:',
            error.message
        );

        workerFailure(worker);

        if (!res.headersSent) {

            return res
                .status(502)
                .send(
                    'Proxy error: ' +
                    error.message
                );
        }
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
            '===================================='
        );

        console.log(
            'PROXY ENGINE ONLINE'
        );

        console.log(
            `PORT: ${PORT}`
        );

        console.log(
            `WORKER: ${WORKER_URL}`
        );

        console.log(
            'HTML REWRITE: URL ONLY'
        );

        console.log(
            'AD CLEANER: OFF'
        );

        console.log(
            'SERVICE WORKER: BLOCKED'
        );

        console.log(
            '===================================='
        );
    }
);
