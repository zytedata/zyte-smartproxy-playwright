const { chromium, devices, errors, firefox, request, selectors, webkit } = require('playwright');
const cross_fetch = require('cross-fetch');
const { PlaywrightBlocker } = require('@cliqz/adblocker-playwright');
const { version } = require('./package.json');

class ZyteSmartProxyPlaywright {
    constructor(browser_type) {
        this.browser_type = browser_type;
    }

    async _configure_zyte_smartproxy_playwright(options) {
        options = options || {}
        this.apikey = options.spm_apikey;
        this.spm_host = options.spm_host || 'http://proxy.zyte.com:8011';
        this.static_bypass = options.static_bypass !== false;
        this.static_bypass_regex = options.static_bypass_regex || /.*?\.(?:txt|json|css|less|js|mjs|cjs|gif|ico|jpe?g|svg|png|webp|mkv|mp4|mpe?g|webm|eot|ttf|woff2?)$/;
        this.block_ads = options.block_ads !== false;
        this.block_list = options.block_list || [
            'https://easylist.to/easylist/easylist.txt',
            'https://easylist.to/easylist/easyprivacy.txt',
        ];
        if (this.block_ads) {
            this.blocker = await PlaywrightBlocker.fromLists(cross_fetch.fetch, this.block_list);
        }
    }

    _patchPageCreation(browser) {
        browser.newPage = (
            function(originalMethod, context, module_context) {
                return async function() {
                    const page = await originalMethod.apply(context, arguments);
                    if (module_context.block_ads) {
                        module_context.blocker.enableBlockingInPage(page);
                    }
                    await page.route(_url => true, async (route, request) => {
                        try {
                            var headers = request.headers();
                            if (
                                module_context.static_bypass &&
                                module_context.static_bypass_regex.test(request.url())
                            ) {
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
                                headers['X-Crawlera-Client'] = 'zyte-smartproxy-playwright/' + version;
                                headers['X-Crawlera-No-Bancheck'] = '1';
                                headers['X-Crawlera-Profile'] = 'pass';
                                headers['X-Crawlera-Cookies'] = 'disable';
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
                        else if (headers['x-crawlera-error'] === 'bad_session_id') {
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
        if (this.apikey) {
            options.proxy = {
                server: this.spm_host,
                username: this.apikey,
                password: '',
            }
        }
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
