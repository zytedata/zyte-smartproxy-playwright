# Zyte SmartProxy Playwright
[![made-with-javascript](https://img.shields.io/badge/Made%20with-JavaScript-1f425f.svg)](https://www.javascript.com)
[![npm](https://img.shields.io/npm/v/zyte-smartproxy-playwright)](https://www.npmjs.com/package/zyte-smartproxy-playwright)

Use [Playwright](https://playwright.dev) with
[Smart Proxy Manager](https://www.zyte.com/smart-proxy-manager/) easily!

A wrapper over Playwright to provide Zyte Smart Proxy Manager specific functionalities.

## QuickStart

1. **Install Zyte SmartProxy Playwright**

```
npm install zyte-smartproxy-playwright
```

2. **Create a file `sample.js` with following content and replace `<SPM_APIKEY>` with your SPM Apikey**

``` javascript
const { chromium } = require('zyte-smartproxy-playwright'); // Or 'firefox' or 'webkit'

(async () => {
    const browser = await chromium.launch({
        spm_apikey: '<SPM_APIKEY>',
        headless: false,
    });
    console.log('Before new page');
    const page = await browser.newPage({ignoreHTTPSErrors: true});

    console.log('Opening page ...');
    try {
        await page.goto('https://toscrape.com/', {timeout: 180000});
    } catch(err) {
        console.log(err);
    }

    console.log('Taking a screenshot ...');
    await page.screenshot({path: 'screenshot.png'});
    await browser.close();
})();
```

Make sure that you're able to make `https` requests using Smart Proxy Manager by following this guide [Fetching HTTPS pages with Zyte Smart Proxy Manager](https://docs.zyte.com/smart-proxy-manager/next-steps/fetching-https-pages-with-smart-proxy.html)

3. **Run `sample.js` using Node**

``` bash
node sample.js
```

## API

`launch` accepts all the arguments accepted by `firefox.launch` or `launch` methods of other browser types
and some additional arguments defined below:

| Argument | Default Value | Description |
|----------|---------------|-------------|
| `spm_apikey` | `undefined` | Zyte Smart Proxy Manager API key that can be found on your zyte.com account. |
| `spm_host` | `http://proxy.zyte.com:8011` | Zyte Smart Proxy Manager proxy host. |
| `static_bypass` | `true` | When `true` Zyte SmartProxy Playwright will skip proxy use for static assets defined by `static_bypass_regex` or pass `false` to use proxy. |
| `static_bypass_regex` | `/.*?\.(?:txt\|json\|css\|less\|js\|mjs\|cjs\|gif\|ico\|jpe?g\|svg\|png\|webp\|mkv\|mp4\|mpe?g\|webm\|eot\|ttf\|woff2?)$/` | Regex to use filtering URLs for `static_bypass`. |
| `block_ads` | `true` | When `true` Zyte SmartProxy Playwright will block ads defined by `block_list` using `@cliqz/adblocker-playwright` package. |
| `block_list` | `['https://easylist.to/easylist/easylist.txt', 'https://easylist.to/easylist/easyprivacy.txt']` | Block list to be used by Zyte SmartProxy Playwright in order to initiate blocker enginer using `@cliqz/adblocker-playwright` and block ads |
| `headers` | `{'X-Crawlera-No-Bancheck': '1', 'X-Crawlera-Profile': 'pass', 'X-Crawlera-Cookies': 'disable'}` | List of headers to be appended to requests |

### Notes
Some websites may not work with `block_ads` and `static_bypass` enabled (default). Try to disable them if you encounter any issues.