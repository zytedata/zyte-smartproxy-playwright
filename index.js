const { chromium, devices, errors, firefox, request, selectors, webkit } = require('playwright');
const fetch = require('cross-fetch');
const adBlockerPlaywright = require('@cliqz/adblocker-playwright');
const { version } = require('./package.json');

const defaultSPMHost = 'http://proxy.zyte.com:8011';
const defaultStaticBypassRegex = /.*?\.(?:txt|json|css|less|gif|ico|jpe?g|svg|png|webp|mkv|mp4|mpe?g|webm|eot|ttf|woff2?)$/;
const defaultBlockList = [
    'https://secure.fanboy.co.nz/easylist.txt',
    'https://secure.fanboy.co.nz/easyprivacy.txt',
];
const defaultHeaders = {
    'X-Crawlera-No-Bancheck': '1',
    'X-Crawlera-Profile': 'pass',
    'X-Crawlera-Cookies': 'disable',
};

class ZyteSPP {
    constructor(browserType) {
        this.browserType = browserType;
    }

    async launch(options) {
        await this._init(options)

        const browser = await this.browserType.launch(options);
        if (this.apikey)
            this._patchPageCreation(browser);
            this._patchContextCreation(browser);

        return browser;
    }

    async connect(wsEndpoint, options) {
        await this._init(options)

        const browser = await this.browserType.connect(wsEndpoint, options);
        if (this.apikey)
            this._patchPageCreation(browser);
            this._patchContextCreation(browser);

        return browser;
    }

    async connectOverCDP(endpointURL, options) {
        await this._init(options)

        const browser = await this.browserType.connectOverCDP(endpointURL, options);
        if (this.apikey)
            this._patchPageCreation(browser);
            this._patchContextCreation(browser);

        return browser;
    }

    executablePath() {
        return this.browserType.executablePath();
    }

    name() {
        return this.browserType.name();
    }

    async launchServer(options) {
        return this.browserType.launchServer(options);
    }

    async _init(options) {
        if (options === undefined)
            return;

        this.apikey = options.spm_apikey;
        this.spmHost = options.spm_host || defaultSPMHost;

        this.staticBypass = options.static_bypass !== false;
        this.staticBypassRegex = options.static_bypass_regex || defaultStaticBypassRegex;

        this.blockAds = options.block_ads !== false;
        this.blockList = options.block_list || defaultBlockList;

        if (this.apikey)
            options.proxy = {server: this.spmHost};

        this.headers = options.headers || defaultHeaders;
    }

    async _createSPMSession() {
        let sessionId = '';

        const url = this.spmHost + '/sessions';
        const auth = 'Basic ' + Buffer.from(this.apikey + ":").toString('base64');
        const headers = {
            'Authorization': auth,
            'X-Crawlera-Client': 'zyte-smartproxy-playwright/' + version,
        };

        const response = await fetch(url, {method: 'POST', headers: headers});

        if (response.ok)
            sessionId = await response.text();
        else
            throw new Error(`Error creating SPM session. Response: ${response.status} ${response.statusText} ${await response.text()}`);

        return sessionId;
    }
}

class ZyteSPPChromium extends ZyteSPP {
    async _init(options) {
        super._init(options)

        if (this.blockAds)
            this.adBlocker = await ZyteSPPChromiumAdBlocker.fromLists(fetch, this.blockList);

        // without this argument Chromium requests from embedded iframes are not intercepted
        // https://bugs.chromium.org/p/chromium/issues/detail?id=924937#c10
        const spmArgs = ['--disable-site-isolation-trials'];

        if ('args' in options) 
            options.args = options.args.concat(spmArgs);
        else 
            options.args = spmArgs;

    }

    async _createCDPSession(context, page) {
        const cdpSession = await context.newCDPSession(page);
        await cdpSession.send('Fetch.enable', {
            patterns: [{requestStage: 'Request'}, {requestStage: 'Response'}],
            handleAuthRequests: true,
        });

        cdpSession.on('Fetch.requestPaused', async (event) => {
            if (this._isResponse(event)){
                this._verifyResponseSessionId(event.responseHeaders);
                await this._continueResponse(cdpSession, event);
            } 
            else {
                if (this.blockAds && this.adBlocker.isAd(event, page))
                    await this._blockRequest(cdpSession, event)
                else if (this.staticBypass && this._isStaticContent(event))
                    try {
                        await this._bypassRequest(cdpSession, event);
                    } catch(err) {
                        await this._continueRequest(cdpSession, event);
                    }
                else 
                    await this._continueRequest(cdpSession, event);
            }
        });

        cdpSession.on('Fetch.authRequired', async (event) => {
            await this._respondToAuthChallenge(cdpSession, event)
        });
    }

    _patchPageCreation(browser) {
        browser.newPage = (
            function(originalMethod, originalBrowser, zyteSPP) {
                return async function() {
                    const page = await originalMethod.apply(originalBrowser, arguments);
                    await zyteSPP._createCDPSession(page.context(), page)
                    return page;
                }
            }
        )(browser.newPage, browser, this);
    }

    _patchContextCreation(browser) {
        browser.newContext = (
            function(originalMethod, originalBrowser, zyteSPP) {
                return async function() {
                    const context = await originalMethod.apply(originalBrowser, arguments);
                    context.newPage = (
                        function(originalMethod, originalContext, zyteSPP) {
                            return async function() {
                                const page = await originalMethod.apply(originalContext, arguments);
                                await zyteSPP._createCDPSession(originalContext, page)
                                return page;
                            }
                        }
                    )(context.newPage, context, zyteSPP);

                    return context;
                }
            }
        )(browser.newContext, browser, this);
    }

    _isResponse(event){
        return event.responseStatusCode || event.responseErrorReason;
    }

    _verifyResponseSessionId(responseHeaders) {
        if (responseHeaders) {
            for (const header of responseHeaders) {
                if (header.name === 'X-Crawlera-Error' &&
                    header.value === 'bad_session_id'
                )
                    this.spmSessionId = undefined;
            }
        }
    }

    async _continueResponse(cdpSession, event) {
        try {
            await cdpSession.send('Fetch.continueRequest', {
                requestId: event.requestId,
            });
        } catch(err) {}
    }

    async _blockRequest(cdpSession, event) {
        try {
            await cdpSession.send('Fetch.failRequest', {
                requestId: event.requestId,
                errorReason: 'BlockedByClient',
            });
        } catch(err) {}
    }

    _isStaticContent(event) {
        return this.staticBypassRegex.test(event.request.url)
    }

    async _bypassRequest(cdpSession, event) {
        const headers = event.request.headers;
        const response = await fetch(event.request.url, {headers})

        if (response.status == 200)
        {
            const response_body = (await response.buffer()).toString('base64');

            const response_headers = []
            for (const pair of response.headers.entries()) {
                if (pair[1] !== undefined)
                    response_headers.push({name: pair[0], value: pair[1] + ''});
            }
            
            try {
                await cdpSession.send('Fetch.fulfillRequest', {
                    requestId: event.requestId,
                    responseCode: response.status,
                    responseHeaders: response_headers,
                    body: response_body,
                });
            } catch(err) {}
        } else {
            throw 'Proxy bypass failed';
        }
    }

    async _continueRequest(cdpSession, event) {
        const headers = event.request.headers;
        if (this.spmSessionId === undefined)
            this.spmSessionId = await this._createSPMSession();

        headers['X-Crawlera-Session'] = this.spmSessionId;
        headers['X-Crawlera-Client'] = 'zyte-smartproxy-playwright/' + version;
        const newHeaders = {...headers, ...this.headers}
        
        try {
            await cdpSession.send('Fetch.continueRequest', {
                requestId: event.requestId,
                headers: headersArray(newHeaders),
            });
        } catch(err) {}
    }

    async _respondToAuthChallenge(cdpSession, event){
        const parameters = {requestId: event.requestId}

        if (this._isSPMAuthChallenge(event)) 
            parameters.authChallengeResponse = {
                response: 'ProvideCredentials',
                username: this.apikey,
                password: '',
            };
        else 
            parameters.authChallengeResponse = {response: 'Default'};
        
        try {
            await cdpSession.send('Fetch.continueWithAuth', parameters);
        } catch(err) {}
    }

    _isSPMAuthChallenge(event) {
        return event.authChallenge.source === 'Proxy' && 
            event.authChallenge.origin === this.spmHost
    }
}

class ZyteSPPChromiumAdBlocker extends adBlockerPlaywright.PlaywrightBlocker {
    isAd(event, page){
        const sourceUrl = page.mainFrame().url();
        const url = event.request.url;
        const type = event.resourceType.toLowerCase();

        const request = adBlockerPlaywright.makeRequest({
            requestId: `${type}-${url}-${sourceUrl}`,
            sourceUrl,
            type,
            url,
        });

        const { match } = this.match(request);
        return match === true;
    }
}

class ZyteSPPWebkit extends ZyteSPP {
    async _init(options) {
        super._init(options);

        if (this.blockAds)
            this.adBlocker = await ZyteSPPWebkitAdBlocker.fromLists(fetch, this.blockList);

        if (this.apikey) {
            options.proxy.username = this.apikey;
            options.proxy.password = '';
        }
    }

    _patchPageCreation(browser) {
        browser.newPage = (
            function(originalMethod, originalBrowser, zyteSPP) {
                return async function() {
                    const page = await originalMethod.apply(originalBrowser, arguments);

                    await page.route(_url => true, async (route, request) => {
                        if (zyteSPP.blockAds) 
                            if (zyteSPP.adBlocker.isRequestBlocked(route)) 
                                return;

                        if (zyteSPP.staticBypass && zyteSPP._isStaticContent(request))
                            try {
                                await zyteSPP._bypassRequest(route, request);
                            } catch(err) {
                                await zyteSPP._continueRequest(route, request);
                            }
                        else 
                            await zyteSPP._continueRequest(route, request);
                    });

                    page.on('response', async (response) => {
                        zyteSPP._verifyResponseSessionId(response)
                    });

                    return page;
                }
            }
        )(browser.newPage, browser, this);
    }

    _patchContextCreation(browser) {
        browser.newContext = (
            function(originalMethod, originalBrowser, zyteSPP) {
                return async function() {
                    const context = await originalMethod.apply(originalBrowser, arguments);

                    await context.route(_url => true, async (route, request) => {
                        if (zyteSPP.blockAds) 
                            if (zyteSPP.adBlocker.isRequestBlocked(route)) 
                                return;

                        if (zyteSPP.staticBypass && zyteSPP._isStaticContent(request))
                            try {
                                await zyteSPP._bypassRequest(route, request);
                            } catch(err) {
                                await zyteSPP._continueRequest(route, request);
                            }
                        else 
                            await zyteSPP._continueRequest(route, request);
                    });

                    context.on('response', async (response) => {
                        zyteSPP._verifyResponseSessionId(response)
                    });

                    return context;
                }
            }
        )(browser.newContext, browser, this);
    }

    _isStaticContent(request) {
        return this.staticBypassRegex.test(request.url())
    }

    async _bypassRequest(route, request){
        const headers = {};
        for (const h of await request.headersArray())
            headers[h.name] = h.value;

        const response = await fetch(request.url(), {headers});

        if (response.status == 200) {
            const headers = {};
            for (var pair of response.headers.entries())
                headers[pair[0]] = pair[1];

            const response_body = await response.buffer();
            
            route.fulfill({
                status: response.status,
                contentType: response.headers.get('content-type'),
                headers: headers,
                body: response_body,
            });
        } else {
            throw 'Proxy bypass failed';
        }
    }

    async _continueRequest(route, request){
        const headers = {};
        for (const h of await request.headersArray())
            headers[h.name] = h.value

        if (this.spmSessionId === undefined)
            this.spmSessionId = await this._createSPMSession();

        headers['X-Crawlera-Session'] = this.spmSessionId;
        headers['X-Crawlera-Client'] = 'zyte-smartproxy-playwright/' + version;

        const newHeaders = {...headers, ...this.headers}

        route.continue({ headers: newHeaders });
    }

    _verifyResponseSessionId(response) {
        const headers = response.headers();
        if (headers['x-crawlera-error'] === 'bad_session_id')
            this.spmSessionId = undefined;
    }
}

class ZyteSPPWebkitAdBlocker extends adBlockerPlaywright.PlaywrightBlocker {
    isRequestBlocked(route){
        const details = route.request();
        const request = adBlockerPlaywright.fromPlaywrightDetails(details);
        if (this.config.guessRequestTypeFromUrl === true && request.type === 'other')
            request.guessTypeOfRequest();

        const frame = details.frame();
        if (request.isMainFrame() ||
            (request.type === 'document' && frame !== null && frame.parentFrame() === null)
        )
            return false;

        const { redirect, match } = this.match(request);
        if (redirect !== undefined) {
            if (redirect.contentType.endsWith(';base64'))
                route.fulfill({
                  body: Buffer.from(redirect.body, 'base64'),
                  contentType: redirect.contentType.slice(0, -7),
                });
            else
                route.fulfill({
                  body: redirect.body,
                  contentType: redirect.contentType,
                });
            
            return true;
        }
        if (match === true) {
            route.abort('blockedbyclient');
            return true;
        }
        return false;
    };
}

class ZyteSPPFirefox extends ZyteSPPWebkit {}

function headersArray(headers) {
    const result = [];
    for (const name in headers)
        if (headers[name] !== undefined)
            result.push({name, value: headers[name] + ''});

    return result;
}

module.exports = {
    chromium: new ZyteSPPChromium(chromium),
    devices,
    errors,
    firefox: new ZyteSPPFirefox(firefox),
    request,
    selectors,
    webkit: new ZyteSPPWebkit(webkit),
};
