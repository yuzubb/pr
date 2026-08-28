const express = require('express');
const fetch = require('node-fetch');
const https = require('https');
const { pipeline } = require('stream');

const app = express();

const WORKER_URL = 'https://www.youtube.com';

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

// HTML / JS テキストの置換処理
function rewriteTextContent(content, publicOrigin) {
    // 1. ドメインの置き換え
    let rewritten = content.replace(/https?:\/\/aniwaves\.ru/gi, publicOrigin);
    rewritten = rewritten.replace(/\/\/aniwaves\.ru/gi, publicOrigin.replace(/^https?:/, ''));

    // 2. Service Worker 登録文を無効化（SecurityError による動作停止の防止）
    rewritten = rewritten.replace(/navigator\.serviceWorker\.register\s*\([^)]+\)/g, 'Promise.reject("Disabled")');

    // 3. 構文を壊さない安全な debugger の無効化 (単体キーワード文のみ空白化)
    rewritten = rewritten.replace(/(^|[\s;{}])debugger\s*(;|\n|$)/g, '$1/* debugger */$2');

    return rewritten;
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

// Service Worker リクエストには空のJSを返す
app.get(['/sw.js', '/service-worker.js'], (req, res) => {
    res.set('Content-Type', 'application/javascript');
    res.set('Cache-Control', 'no-store');
    return res.send('// Service Worker Disabled');
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

        // Set-Cookie の Domain 除去
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

        const isHtml = contentType.toLowerCase().includes('text/html');
        const isJs = contentType.toLowerCase().includes('javascript') || contentType.toLowerCase().includes('ecmascript');

        // HTML・JS はテキスト置換を実施
        if (isHtml || isJs) {
            let text = await response.text();
            text = rewriteTextContent(text, publicOrigin);
            res.set('Content-Type', contentType);
            return res.send(text);
        }

        // その他の静的ファイルはストリーム転送
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
    console.log(`PROXY ENGINE ONLINE PORT: ${PORT}`);
});
