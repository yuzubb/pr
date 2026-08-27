const express = require('express');
const fetch = require('node-fetch');
const https = require('https');

const app = express();

// ==========================================
// 1. Worker設定
// ==========================================

const WORKER_CONFIGS = [
    "https://aniwaves.nu",
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
// 6. サーバー側広告判定
// ==========================================

const AD_URL_PATTERN = new RegExp(
    [
        'doubleclick',
        'googlesyndication',
        'googleadservices',
        'googletagservices',
        'adservice',
        'adserver',
        'adnetwork',
        'advertising',
        'advertisement',
        'adsystem',
        'adserver',
        'adnxs',
        'taboola',
        'outbrain',
        'popunder',
        'popup',
        'interstitial',
        'banner'
    ].join('|'),
    'i'
);

const AD_CLASS_PATTERN = new RegExp(
    [
        '(^|[-_])ad([s]?)([-_]|$)',
        'advert',
        'advertisement',
        'advertising',
        'adsbygoogle',
        'ad-container',
        'ad-wrapper',
        'ad-banner',
        'ad-slot',
        'ad-unit',
        'ad-box',
        'ad-overlay',
        'popup',
        'popunder',
        'interstitial',
        'sponsored'
    ].join('|'),
    'i'
);

// ==========================================
// 7. サーバー側HTML広告除去
// ==========================================

function removeServerAds(html) {

    // --------------------------------------
    // script
    // --------------------------------------

    html = html.replace(
        /<script\b[^>]*(?:src|data-src)\s*=\s*["'][^"']*(?:doubleclick|googlesyndication|googleadservices|googletagservices|adservice|adserver|advertising|adsystem|adnxs|taboola|outbrain)[^"']*["'][^>]*>[\s\S]*?<\/script>/gi,
        ''
    );

    // --------------------------------------
    // iframe
    // --------------------------------------

    html = html.replace(
        /<iframe\b[^>]*(?:src|data-src)\s*=\s*["'][^"']*(?:doubleclick|googlesyndication|googleadservices|googlead|adservice|adserver|advertising|popup|popunder)[^"']*["'][^>]*>[\s\S]*?<\/iframe>/gi,
        ''
    );

    // --------------------------------------
    // Google Adsense
    // --------------------------------------

    html = html.replace(
        /<ins\b[^>]*class=["'][^"']*adsbygoogle[^"']*["'][^>]*>[\s\S]*?<\/ins>/gi,
        ''
    );

    html = html.replace(
        /<script\b[^>]*>[\s\S]*?adsbygoogle[\s\S]*?<\/script>/gi,
        ''
    );

    // --------------------------------------
    // data-ad系
    // --------------------------------------

    html = html.replace(
        /<[^>]+(?:data-ad-slot|data-ad-client|data-ad-format|data-ad-unit|data-advertisement|data-advertising)\s*=\s*["'][^"']*["'][^>]*>[\s\S]*?<\/[^>]+>/gi,
        ''
    );

    // --------------------------------------
    // class / id 広告
    // --------------------------------------

    html = html.replace(
        /<div\b[^>]*(?:class|id)\s*=\s*["'][^"']*(?:ad-container|ad-wrapper|ad-banner|ad-slot|ad-unit|advertisement|advertising|popup-ad|popunder-ad|interstitial-ad)[^"']*["'][^>]*>[\s\S]*?<\/div>/gi,
        ''
    );

    // --------------------------------------
    // 広告リンク
    // --------------------------------------

    html = html.replace(
        /<a\b[^>]*(?:href|data-href)\s*=\s*["'][^"']*(?:doubleclick|googlesyndication|googleadservices|adservice|adserver|advertising|popup|popunder)[^"']*["'][^>]*>[\s\S]*?<\/a>/gi,
        ''
    );

    return html;
}

// ==========================================
// 8. ブラウザ側広告クリーナー
// ==========================================

const INJECT_CODE = `
<style id="proxy-ad-cleaner">

/* ==========================================
   動的広告をCSSでも即座に非表示
   ========================================== */

iframe[src*="doubleclick"],
iframe[src*="googlesyndication"],
iframe[src*="googleadservices"],
iframe[src*="adservice"],
iframe[src*="adserver"],
iframe[src*="advertising"],

ins.adsbygoogle,
.adsbygoogle,

[class*="advertisement"],
[class*="advertising"],
[class*="ad-container"],
[class*="ad-wrapper"],
[class*="ad-banner"],
[class*="ad-slot"],
[class*="ad-unit"],
[class*="popup-ad"],
[class*="popunder-ad"],
[class*="interstitial-ad"],

[id*="advertisement"],
[id*="advertising"],
[id*="ad-container"],
[id*="ad-wrapper"],
[id*="ad-banner"],
[id*="ad-slot"],
[id*="ad-unit"],

[data-ad],
[data-ad-slot],
[data-ad-client],
[data-ad-format],
[data-ad-unit],
[data-advertisement],
[data-advertising] {

    display: none !important;
    visibility: hidden !important;
    opacity: 0 !important;
    pointer-events: none !important;
}

</style>

<script id="proxy-ad-cleaner-script">
(function () {

    'use strict';

    // ==========================================
    // 広告URL判定
    // ==========================================

    const AD_URL_PATTERN =
        /doubleclick|googlesyndication|googleadservices|googletagservices|adservice|adserver|adnetwork|advertising|advertisement|adsystem|adnxs|taboola|outbrain|popup|popunder|interstitial/i;

    // ==========================================
    // class / id 判定
    // ==========================================

    const AD_NAME_PATTERN =
        /(^|[-_])ad(s)?($|[-_])|advert|advertisement|advertising|adsbygoogle|ad-container|ad-wrapper|ad-banner|ad-slot|ad-unit|popup-ad|popunder-ad|interstitial-ad|sponsored/i;

    // ==========================================
    // 要素判定
    // ==========================================

    function isAdvertisement(element) {

        if (!element || element.nodeType !== 1) {
            return false;
        }

        const tag = element.tagName.toLowerCase();

        // --------------------------------------
        // 広告属性
        // --------------------------------------

        const adAttributes = [
            'data-ad',
            'data-ad-slot',
            'data-ad-client',
            'data-ad-format',
            'data-ad-unit',
            'data-advertisement',
            'data-advertising'
        ];

        for (const attribute of adAttributes) {
            if (element.hasAttribute(attribute)) {
                return true;
            }
        }

        // --------------------------------------
        // ID
        // --------------------------------------

        if (
            element.id &&
            AD_NAME_PATTERN.test(element.id)
        ) {
            return true;
        }

        // --------------------------------------
        // CLASS
        // --------------------------------------

        if (
            typeof element.className === 'string' &&
            AD_NAME_PATTERN.test(element.className)
        ) {
            return true;
        }

        // --------------------------------------
        // iframe / script
        // --------------------------------------

        if (
            tag === 'iframe' ||
            tag === 'script' ||
            tag === 'object' ||
            tag === 'embed'
        ) {

            const src =
                element.src ||
                element.data ||
                element.getAttribute('src') ||
                element.getAttribute('data') ||
                '';

            if (
                src &&
                AD_URL_PATTERN.test(src)
            ) {
                return true;
            }
        }

        // --------------------------------------
        // リンク
        // --------------------------------------

        if (tag === 'a') {

            const href =
                element.href ||
                element.getAttribute('href') ||
                '';

            if (
                href &&
                AD_URL_PATTERN.test(href)
            ) {
                return true;
            }
        }

        return false;
    }

    // ==========================================
    // 広告削除
    // ==========================================

    function removeAds(root) {

        if (!root || !root.querySelectorAll) {
            return;
        }

        // root自身
        if (root.nodeType === 1) {
            if (isAdvertisement(root)) {
                root.remove();
                return;
            }
        }

        // 子要素
        const elements = root.querySelectorAll('*');

        for (const element of elements) {

            if (isAdvertisement(element)) {
                element.remove();
            }
        }

        // Google Adsense
        root.querySelectorAll(
            'ins.adsbygoogle, .adsbygoogle'
        ).forEach(element => {
            element.remove();
        });
    }

    // ==========================================
    // 初回クリーニング
    // ==========================================

    function cleanPage() {
        removeAds(document);
    }

    if (document.readyState === 'loading') {

        document.addEventListener(
            'DOMContentLoaded',
            cleanPage,
            { once: true }
        );

    } else {

        cleanPage();

    }

    // ==========================================
    // MutationObserver
    // ==========================================

    const observer = new MutationObserver(
        mutations => {

            for (const mutation of mutations) {

                if (
                    mutation.type !== 'childList'
                ) {
                    continue;
                }

                for (const node of mutation.addedNodes) {

                    if (
                        node.nodeType !== Node.ELEMENT_NODE
                    ) {
                        continue;
                    }

                    // 自身が広告
                    if (isAdvertisement(node)) {

                        node.remove();
                        continue;

                    }

                    // 内部に広告
                    removeAds(node);
                }
            }
        }
    );

    function startObserver() {

        if (!document.documentElement) {
            return;
        }

        observer.observe(
            document.documentElement,
            {
                childList: true,
                subtree: true
            }
        );
    }

    if (document.readyState === 'loading') {

        document.addEventListener(
            'DOMContentLoaded',
            startObserver,
            { once: true }
        );

    } else {

        startObserver();

    }

    // ==========================================
    // ポップアップ抑制
    // ==========================================

    window.open = function () {
        return null;
    };

    // ==========================================
    // beforeunload系ポップアップ抑制
    // ==========================================

    window.addEventListener(
        'beforeunload',
        function (event) {
            event.stopImmediatePropagation();
        },
        true
    );

})();
</script>
`;

// ==========================================
// 9. リクエスト処理
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

                let html =
                    await response.text();

                // --------------------------------
                // サーバー側広告除去
                // --------------------------------

                html = removeServerAds(html);

                // --------------------------------
                // Browser側クリーナー注入
                // --------------------------------

                if (/<head\b[^>]*>/i.test(html)) {

                    html = html.replace(
                        /<head\b[^>]*>/i,
                        match =>
                            match +
                            INJECT_CODE
                    );

                } else {

                    html =
                        INJECT_CODE +
                        html;
                }

                // --------------------------------
                // charset
                // --------------------------------

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
// 10. 起動
// ==========================================

const PORT =
    process.env.PORT || 3000;

app.listen(
    PORT,
    () => {
        console.log(
            '--- ULTIMATE PROXY ENGINE ONLINE ---'
        );
    }
);
