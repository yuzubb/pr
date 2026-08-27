const express = require('express');
const fetch = require('node-fetch');
const https = require('https');
const { pipeline } = require('stream');

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
    console.log(`Worker failure ${worker.failCount}/3: ${worker.url}`);
    if (worker.failCount >= 3) {
        worker.isAlive = false;
    }
}

app.use(
    express.raw({
        type: '*/*',
        limit: '50mb'
    })
);

function rewriteHtml(html, publicOrigin) {
    // 絶対URL・プロトコル相対URLの置換
    html = html.replace(/https?:\/\/aniwaves\.ru/gi, publicOrigin);
    html = html.replace(/\/\/aniwaves\.ru/gi, publicOrigin.replace(/^https?:/, ''));
    return html;
}

function rewriteLocation(location, publicOrigin) {
    if (!location) return location;
    if (location.startsWith(WORKER_URL)) {
        return publicOrigin + location.substring(WORKER_URL.length);
    }
    if (location.startsWith('//aniwaves.ru')) {
        return publicOrigin.replace(/^https?:/, '') + location.substring('//aniwaves.ru'.length);
    }
    return location;
}

// Service Worker の無効化
app.get(['/sw.js', '/service-worker.js'], (req, res) => {
    res.set('Cache-Control', 'no-store');
    return res.status(404).send('Not Found');
});

app.get('/favicon.ico', (req, res) => {
    res.status(204).end();
});

app.all('*', async (req, res) => {
    const worker = getWorker();
    const publicOrigin = `${req.protocol}://${req.get('host')}`;
    const targetUrl = worker.url + req.originalUrl;

    console.log(`➡️ ${req.method} ${targetUrl}`);

    const headers = { ...req.headers };

    delete headers.host;
    delete headers.connection;
    delete headers['content-length'];

    // Worker側のOriginチェック回避
    headers.origin = worker.url;
    headers.referer = worker.url + '/';
    headers['x-forwarded-host'] = req.get('host') || '';
    headers['x-forwarded-proto'] = req.protocol;

    try {
        const fetchOptions = {
            method: req.method,
            headers,
            agent: proxyAgent,
            redirect: 'follow',
            compress: true,
            timeout: 20000
        };

        if (req.method !== 'GET' && req.method !== 'HEAD' && req.body && req.body.length > 0) {
            fetchOptions.body = req.body;
        }

        const response = await fetch(targetUrl, fetchOptions);

        console.log(`⬅️ ${response.status} ${targetUrl}`);

        if (response.status >= 500) {
            workerFailure(worker);
            return res.status(response.status).send(`Worker returned ${response.status}`);
        }

        workerSuccess(worker);

        const contentType = response.headers.get('content-type') || '';
        
        // 不要・害になるレスポンスヘッダーを除去
        const blockedHeaders = new Set([
            'content-length',
            'content-encoding',
            'transfer-encoding',
            'content-security-policy',
            'content-security-policy-report-only'
        ]);

        response.headers.forEach((value, key) => {
            const lower = key.toLowerCase();
            if (blockedHeaders.has(lower)) return;

            if (lower === 'location') {
                res.set('Location', rewriteLocation(value, publicOrigin));
                return;
            }
            if (lower === 'set-cookie') return;

            res.set(key, value);
        });

        // Set-Cookie のドメイン書き換え
        if (response.headers.raw && typeof response.headers.raw === 'function') {
            const raw = response.headers.raw();
            const cookies = raw['set-cookie'];
            if (cookies && cookies.length) {
                const rewrittenCookies = cookies.map(cookie =>
                    cookie.replace(/;\s*Domain=[^;]+/gi, '')
                );
                res.setHeader('Set-Cookie', rewrittenCookies);
            }
        }

        res.status(response.status);

        // HTMLの場合はテキストとして取得して置換後に送信
        if (contentType.toLowerCase().includes('text/html')) {
            let html = await response.text();
            html = rewriteHtml(html, publicOrigin);
            res.set('Content-Type', contentType);
            return res.send(html);
        }

        // HTML以外（CSS, JS, 画像, 動画など）はストリーム処理
        return pipeline(response.body, res, (err) => {
            if (err && !res.headersSent) {
                console.error('Pipeline error:', err);
            }
        });

    } catch (error) {
        console.error('PROXY ERROR:', error.message);
        workerFailure(worker);

        if (!res.headersSent) {
            return res.status(502).send('Proxy error: ' + error.message);
        }
    }
});

const PORT = process.env.PORT || 8000;
app.listen(PORT, () => {
    console.log(`====================================`);
    console.log(`PROXY ENGINE ONLINE`);
    console.log(`PORT: ${PORT}`);
    console.log(`WORKER: ${WORKER_URL}`);
    console.log(`====================================`);
});
