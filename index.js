const { chromium, devices, errors, firefox, request, selectors, webkit } = require('playwright');
const cross_fetch = require('cross-fetch');
const { PlaywrightBlocker } = require('@cliqz/adblocker-playwright');

class ZyteSmartProxyPlaywright {
    constructor(browser_type) {
        this.browser_type = browser_type;
    }

    async _configure_zyte_smartproxy_playwright(options) {
        options = options || {}
        this.apikey = options.spm_apikey;
        this.spm_host = options.spm_host || 'http://proxy.zyte.com:8011';
        this.static_bypass = options.static_bypass || true;
        this.static_bypass_regex = options.static_bypass_regex || /.*?\.(?:txt|css|eot|gif|ico|jpe?g|js|less|mkv|mp4|mpe?g|png|ttf|webm|webp|woff2?)$/;
        this.block_ads = options.block_ads === true ? true : false;
        this.block_list = options.block_list || [
            'https://easylist.to/easylist/easylist.txt',
            'https://easylist.to/easylist/easyprivacy.txt',
        ];
        this.blocker = await PlaywrightBlocker.fromLists(cross_fetch.fetch, this.block_list);
    }

    _patchPageCreation(browser) {
        browser.newPage = (
            function(originalMethod, context, module_context) {
                return async function() {
                    const page = await originalMethod.apply(context);
                    module_context.blocker.enableBlockingInPage(page);
                    await page.route('**/*', async (route, request) => {
                        try {
                            var headers = request.headers();
                            if (
                                module_context.static_bypass &&
                                module_context.static_bypass_regex.test(
                                    request.url()
                                )
                            )   {
                                const response = await cross_fetch.fetch(request.url());
                                const headers = {};
                                for (var pair of response.headers.entries()) {
                                    headers[pair[0]] = pair[1];
                                }
                                var response_body = await response.arrayBuffer();
                                response_body = new Buffer.from(response_body);
                                route.fulfill({
                                    status: response.status,
                                    contentType: response.headers.get('content-type'),
                                    headers: headers,
                                    body: response_body,
                                });
                            }
                            else {
                                if (module_context.SPMSessionId) {
                                    headers['X-Crawlera-Session'] = module_context.SPMSessionId;
                                }
                                else {
                                    headers['X-Crawlera-Session'] = 'create';
                                }
                                headers['X-Crawlera-Client'] = 'playwright';
                                route.continue({ headers });
                            }
                        }
                        catch (e) {
                            // Uncomment to debug the issue with failed request.
                            console.log('Error while interception', e);
                            route.continue();
                        }
                    });
                    page.on('response', async (response) => {
                        const headers = response.headers();
                        if (response.ok() && headers['x-crawlera-session']) {
                            module_context.SPMSessionId = headers['x-crawlera-session'];
                        }
                        else if (headers['x-crawlera-error'] === 'banned') {
                            module_context.SPMSessionId = undefined;
                        }
                    });
                    return page;
                }
            }
        )(browser.newPage, browser, this);
    }

    async launch(options) {
        await this._configure_zyte_smartproxy_playwright(options)
        let args = [
            '--no-sandbox',
            '--auto-open-devtools-for-tabs',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--disable-gpu',
            '--disable-web-security',
            '--ignore-certificate-errors',
            '--ignore-certificate-errors-spki-list'
        ]
        var necessary_options = {
            ignoreHTTPSErrors: true,
            args: args,
            firefoxUserPrefs: {
                'network.websocket.allowInsecureFromHTTPS': true,
                'security.cert_pinning.enforcement_level': 0,
            },
            bypassCSP: true,
        }
        if (this.apikey) {
            necessary_options['proxy'] = {
                server: this.spm_host,
                username: this.apikey,
                password: '',
            }
        }
        options = {...necessary_options, ...options}
        const browser = await this.browser_type.launch(options);
        if (this.apikey) {
            this._patchPageCreation(browser);
        }
        return browser;
    }
}

module.exports = {
    chromium: new ZyteSmartProxyPlaywright(chromium),
    devices,
    errors,
    firefox: new ZyteSmartProxyPlaywright(firefox),
    request,
    selectors,
    webkit: new ZyteSmartProxyPlaywright(webkit),
};
