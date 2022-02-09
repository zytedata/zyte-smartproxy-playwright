const { chromium, devices, errors, firefox, request, selectors, webkit } = require('playwright');
const cross_fetch = require('cross-fetch');
const adblocker = require('@cliqz/adblocker-playwright');
const { version } = require('./package.json');

class PlaywrightBlocker extends adblocker.PlaywrightBlocker {
    isRequestBlocked(route){
        const details = route.request();
        const request = adblocker.fromPlaywrightDetails(details);
        if (this.config.guessRequestTypeFromUrl === true && request.type === 'other') {
            request.guessTypeOfRequest();
        }
        const frame = details.frame();
        if (request.isMainFrame() ||
            (request.type === 'document' && frame !== null && frame.parentFrame() === null)) {
            return false;
        }
        const { redirect, match } = this.match(request);
        if (redirect !== undefined) {
            if (redirect.contentType.endsWith(';base64')) {
                route.fulfill({
                  body: Buffer.from(redirect.body, 'base64'),
                  contentType: redirect.contentType.slice(0, -7),
                });
            } else {
                route.fulfill({
                  body: redirect.body,
                  contentType: redirect.contentType,
                });
            }
            return true;
        }
        if (match === true) {
            route.abort('blockedbyclient');
            return true;
        }
        return false;
    };
}

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
                    await page.route(_url => true, async (route, request) => {
                        try {
                            if (module_context.block_ads) 
                                if (module_context.blocker.isRequestBlocked(route)) 
                                    return;

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
                                const headers = {};
                                for (const h of await request.headersArray()){
                                    headers[h.name] = h.value
                                }

                                if (module_context.SPMSessionId === undefined){
                                    module_context.SPMSessionId = await module_context._createSPMSession();
                                }
                                headers['X-Crawlera-Session'] = module_context.SPMSessionId;
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
                        if (headers['x-crawlera-error'] === 'bad_session_id') {
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

    async _createSPMSession() {
        let sessionId = '';

        const url = this.spm_host + '/sessions';
        const auth = 'Basic ' + Buffer.from(this.apikey + ":").toString('base64');

        const response = await cross_fetch(
            url,
            {method: 'POST', headers: {'Authorization': auth}}
        );

        if (response.ok)
            sessionId = await response.text();
        else
            throw new Error(`Error creating SPM session. Response: ${response.status} ${response.statusText} ${await response.text()}`);

        return sessionId;
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
