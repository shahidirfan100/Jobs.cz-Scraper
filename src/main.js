// Jobs.cz scraper - CheerioCrawler implementation
import { Actor, log } from 'apify';
import { CheerioCrawler, Dataset } from 'crawlee';
import { load as cheerioLoad } from 'cheerio';

// Single-entrypoint main
await Actor.init();

async function main() {
    try {
        const input = (await Actor.getInput()) || {};
        const {
            keyword = '',
            location = '',
            category = '',
            results_wanted: RESULTS_WANTED_RAW = 100,
            max_pages: MAX_PAGES_RAW = 999,
            collectDetails = true,
            startUrl,
            startUrls,
            url,
            proxyConfiguration,
            dedupe = true,
        } = input;

        const RESULTS_WANTED = Number.isFinite(+RESULTS_WANTED_RAW)
            ? Math.max(1, +RESULTS_WANTED_RAW)
            : Number.MAX_SAFE_INTEGER;
        const MAX_PAGES = Number.isFinite(+MAX_PAGES_RAW)
            ? Math.max(1, +MAX_PAGES_RAW)
            : 999;

        const toAbs = (href, base = 'https://www.jobs.cz') => {
            try {
                return new URL(href, base).href;
            } catch {
                return null;
            }
        };

        const cleanText = (html) => {
            if (!html) return '';
            const $ = cheerioLoad(html);
            $('script, style, noscript, iframe').remove();
            return $.root().text().replace(/\s+/g, ' ').trim();
        };

        // Generic label cleaner to avoid CSS selectors, nav, etc.
        const cleanLabel = (txt) => {
            if (!txt) return null;
            let t = String(txt).replace(/\s+/g, ' ').trim();
            if (!t) return null;

            // Kill obvious garbage: CSS snippets / pure selectors
            if (/[{};]/.test(t)) return null;
            if (/^[-_a-z0-9.#>]+$/i.test(t)) return null;

            // Typical chrome / nav
            if (/(menu|navigation|nav|cookies?|privacy|terms|home|back to search|jobs\.cz)/i.test(t)) {
                return null;
            }

            // Length sanity
            if (t.length < 2 || t.length > 80) return null;

            return t;
        };

        const buildStartUrl = (kw, loc, cat) => {
            const u = new URL('https://www.jobs.cz/prace/');

            if (kw) {
                const keywords = String(kw).trim();
                u.searchParams.set('q[]', keywords);
                log.info(`Searching for keyword: "${keywords}"`);
            }

            if (loc) {
                const locality = String(loc).trim();
                u.searchParams.set('locality[]', locality);
                log.info(`Filtering by location: "${locality}"`);
            }

            if (cat) {
                const categoryVal = String(cat).trim();
                u.searchParams.set('category[]', categoryVal);
                log.info(`Filtering by category: "${categoryVal}"`);
            }

            const finalUrl = u.href;
            log.info(`Built search URL: ${finalUrl}`);
            return finalUrl;
        };

        function extractFromJsonLd($) {
            const scripts = $('script[type="application/ld+json"]');
            for (let i = 0; i < scripts.length; i++) {
                try {
                    const parsed = JSON.parse($(scripts[i]).html() || '');
                    const arr = Array.isArray(parsed) ? parsed : [parsed];
                    for (const e of arr) {
                        if (!e) continue;
                        const t = e['@type'] || e.type;
                        const isJob =
                            t === 'JobPosting' ||
                            (Array.isArray(t) && t.includes('JobPosting')) ||
                            (typeof t === 'string' && /JobPosting/i.test(t));
                        if (!isJob) continue;

                        const loc =
                            (e.jobLocation &&
                                e.jobLocation.address &&
                                (e.jobLocation.address.addressLocality ||
                                    e.jobLocation.address.addressRegion)) ||
                            null;

                        let salary = null;
                        if (e.baseSalary) {
                            if (typeof e.baseSalary === 'string') {
                                salary = e.baseSalary;
                            } else if (e.baseSalary.value) {
                                salary = e.baseSalary.value;
                            } else if (
                                typeof e.baseSalary.minValue !== 'undefined' &&
                                typeof e.baseSalary.maxValue !== 'undefined'
                            ) {
                                salary = `${e.baseSalary.minValue} - ${e.baseSalary.maxValue}`;
                            }
                        }

                        return {
                            title: e.title || e.name || null,
                            company: e.hiringOrganization?.name || null,
                            date_posted: e.datePosted || null,
                            description_html: e.description || null,
                            location: loc,
                            salary,
                            job_type: e.employmentType || null,
                        };
                    }
                } catch {
                    // ignore JSON-LD errors
                }
            }
            return null;
        }

        function findJobLinks($, base) {
            const links = new Set();
            $('a[href]').each((_, a) => {
                const href = $(a).attr('href');
                if (!href) return;
                if (/\/rpd\/\d+/i.test(href)) {
                    const abs = toAbs(href, base);
                    if (!abs) return;
                    const cleanUrl = abs.split('?')[0];
                    links.add(cleanUrl);
                }
            });
            return [...links];
        }

        function findNextPage(baseUrl, currentPage) {
            const nextPage = currentPage + 1;
            try {
                const url = new URL(baseUrl);
                url.searchParams.set('page', String(nextPage));
                return url.href;
            } catch (err) {
                log.warning(`Failed to construct next page URL from ${baseUrl}: ${err.message}`);
                return null;
            }
        }

        function hasNextPage($) {
            const nextBtn = $('a[rel="next"]').length > 0;
            const paginationLinks = $('a[href*="page="]').length > 0;
            const disabledNext =
                $('.pagination .disabled:contains("›")').length > 0 ||
                $('.pagination .disabled:contains("Další")').length > 0;
            return (nextBtn || paginationLinks) && !disabledNext;
        }

        // Resolve initial URLs
        const initial = [];
        if (Array.isArray(startUrls) && startUrls.length) {
            initial.push(...startUrls);
            log.info(`Using ${startUrls.length} custom start URL(s)`);
        }
        if (startUrl) {
            initial.push(startUrl);
            log.info(`Using custom start URL: ${startUrl}`);
        }
        if (url) {
            initial.push(url);
            log.info(`Using custom URL: ${url}`);
        }
        if (!initial.length) {
            const builtUrl = buildStartUrl(keyword, location, category);
            initial.push(builtUrl);
        }

        const proxyConf = proxyConfiguration
            ? await Actor.createProxyConfiguration({ ...proxyConfiguration })
            : undefined;

        let saved = 0;
        const seenUrls = new Set();

        const enqueueDetail = async (crawler, links) => {
            const remaining = RESULTS_WANTED - saved;
            const uniqueLinks = dedupe ? links.filter((l) => !seenUrls.has(l)) : links;
            uniqueLinks.forEach((l) => seenUrls.add(l));
            const toTake = uniqueLinks.slice(0, Math.max(0, remaining));
            if (!toTake.length) return;
            await crawler.addRequests(
                toTake.map((u) => ({
                    url: u,
                    userData: { label: 'DETAIL' },
                })),
            );
        };

        const crawler = new CheerioCrawler({
            proxyConfiguration: proxyConf,
            maxRequestRetries: 3,
            useSessionPool: true,
            maxConcurrency: 10,
            requestHandlerTimeoutSecs: 90,
            async requestHandler({ request, $, log: crawlerLog }) {
                const label = request.userData?.label || 'LIST';
                const pageNo = request.userData?.pageNo || 1;

                if (label === 'LIST') {
                    const links = findJobLinks($, request.url);
                    crawlerLog.info(
                        `LIST page ${pageNo} -> ${links.length} job links at ${request.url}`,
                    );

                    if (collectDetails) {
                        await enqueueDetail(crawler, links);
                    } else {
                        const remaining = RESULTS_WANTED - saved;
                        const uniqueLinks = dedupe ? links.filter((l) => !seenUrls.has(l)) : links;
                        uniqueLinks.forEach((l) => seenUrls.add(l));
                        const toPush = uniqueLinks
                            .slice(0, Math.max(0, remaining))
                            .map((u) => ({ url: u, _source: 'jobs.cz' }));
                        if (toPush.length) {
                            await Dataset.pushData(toPush);
                            saved += toPush.length;
                        }
                    }

                    // Pagination control
                    if (saved < RESULTS_WANTED && pageNo < MAX_PAGES && links.length > 0) {
                        const hasMore = hasNextPage($);
                        if (hasMore) {
                            const next = findNextPage(request.url, pageNo);
                            if (next) {
                                crawlerLog.info(
                                    `Queueing next page ${pageNo + 1}: ${next}`,
                                );
                                await crawler.addRequests([
                                    {
                                        url: next,
                                        userData: { label: 'LIST', pageNo: pageNo + 1 },
                                    },
                                ]);
                            } else {
                                crawlerLog.warning(
                                    `Could not construct next page URL for page ${
                                        pageNo + 1
                                    }`,
                                );
                            }
                        } else {
                            crawlerLog.info(
                                `No more pages available after page ${pageNo}`,
                            );
                        }
                    } else if (saved >= RESULTS_WANTED) {
                        crawlerLog.info(
                            `Reached target of ${RESULTS_WANTED} results`,
                        );
                    } else if (pageNo >= MAX_PAGES) {
                        crawlerLog.info(
                            `Reached maximum pages limit: ${MAX_PAGES}`,
                        );
                    } else if (links.length === 0) {
                        crawlerLog.info(
                            `No job links found on page ${pageNo}`,
                        );
                    }
                    return;
                }

                if (label === 'DETAIL') {
                    if (saved >= RESULTS_WANTED) return;
                    try {
                        const json = extractFromJsonLd($);
                        const data = json || {};

                        // Title
                        if (!data.title) {
                            data.title =
                                $('h1').first().text().trim() ||
                                $('[itemprop="title"]').first().text().trim() ||
                                $('header h1').first().text().trim() ||
                                null;
                        }

                        // Company
                        if (!data.company) {
                            data.company =
                                $('[itemprop="hiringOrganization"] [itemprop="name"]')
                                    .first()
                                    .text()
                                    .trim() ||
                                $('[itemprop="hiringOrganization"]')
                                    .first()
                                    .text()
                                    .trim() ||
                                $('.company-name').first().text().trim() ||
                                $('a[href*="/spolecnosti/"]')
                                    .first()
                                    .text()
                                    .trim() ||
                                $('[class*="company"]')
                                    .filter((i, el) => {
                                        const txt = $(el).text().trim();
                                        return (
                                            txt.length > 0 &&
                                            txt.length < 100 &&
                                            !txt.includes('\n')
                                        );
                                    })
                                    .first()
                                    .text()
                                    .trim() ||
                                null;
                        }

                        // Location
                        if (!data.location) {
                            data.location =
                                $('[itemprop="jobLocation"] [itemprop="address"]')
                                    .first()
                                    .text()
                                    .trim() ||
                                $('[itemprop="jobLocation"]')
                                    .first()
                                    .text()
                                    .trim() ||
                                $('[class*="location"]')
                                    .first()
                                    .text()
                                    .trim() ||
                                $('a[href*="mapy.cz"]')
                                    .first()
                                    .text()
                                    .trim() ||
                                null;
                        }

                        // Salary
                        if (!data.salary) {
                            data.salary =
                                $('[itemprop="baseSalary"]')
                                    .first()
                                    .text()
                                    .trim() ||
                                $('.salary').first().text().trim() ||
                                $('[class*="salary"]')
                                    .first()
                                    .text()
                                    .trim() ||
                                $('*')
                                    .filter((i, el) => {
                                        const txt = $(el).text();
                                        return /\d+\s*(?:000)?\s*(?:-|–|až)\s*\d+\s*(?:000)?\s*Kč/i.test(
                                            txt,
                                        );
                                    })
                                    .first()
                                    .text()
                                    .trim() ||
                                null;
                        }

                        // Job type / employment form
                        if (!data.job_type) {
                            data.job_type =
                                $('[itemprop="employmentType"]')
                                    .first()
                                    .text()
                                    .trim() ||
                                $('*:contains("Employment form")')
                                    .next()
                                    .text()
                                    .trim() ||
                                $('*:contains("Position type")')
                                    .parent()
                                    .text()
                                    .replace(/Position type:?\s*/i, '')
                                    .trim() ||
                                $('dt:contains("Employment form")')
                                    .next('dd')
                                    .text()
                                    .trim() ||
                                $('*')
                                    .filter((i, el) => {
                                        const txt = $(el).text().toLowerCase();
                                        return (
                                            (txt.includes('full-time') ||
                                                txt.includes('full time') ||
                                                txt.includes('part-time') ||
                                                txt.includes('contract')) &&
                                            txt.length < 50
                                        );
                                    })
                                    .first()
                                    .text()
                                    .trim() ||
                                null;
                        }

                        // Sanitize and normalize job_type
                        if (data.job_type) {
                            let jt = cleanLabel(data.job_type);
                            if (jt) {
                                const parts = jt
                                    .split(/[,/|]/)
                                    .map((s) => s.trim())
                                    .filter(Boolean);
                                const allowedRe =
                                    /(full[- ]?time|part[- ]?time|intern|temporary|contract|freelance|brigáda|HPP|DPP|DPČ|remote|on[- ]site|hybrid)/i;
                                const filtered = parts.filter((p) =>
                                    allowedRe.test(p),
                                );
                                if (filtered.length) {
                                    jt = filtered.join(', ');
                                }
                            }
                            data.job_type = jt || null;
                        }

                        // DESCRIPTION HTML (clean, only job body)
                        if (!data.description_html) {
                            // 1) Remove obvious non-description UI like send-to-email modal, alerts, etc.
                            $(
                                '[id*="modal"], [class*="Modal"], .Alert, .JobDescriptionSendAdToEmailModal, .TextField, .TextArea',
                            ).remove();

                            // 2) Try to capture region between "Pracovní nabídka" and "Informace o pozici"
                            let descriptionHtml = null;
                            const start = $('*:contains("Pracovní nabídka")')
                                .filter((i, el) =>
                                    /Pracovní nabídka/i.test($(el).text()),
                                )
                                .first();
                            const end = $('*:contains("Informace o pozici")')
                                .filter((i, el) =>
                                    /Informace o pozici/i.test($(el).text()),
                                )
                                .first();

                            if (start.length && end.length) {
                                let parts = [];
                                let current = start.next();
                                while (current.length && current[0] !== end[0]) {
                                    parts.push($.html(current));
                                    current = current.next();
                                }
                                descriptionHtml = parts.join('\n').trim() || null;
                            }

                            // 3) Fallback: your old selector-based approach
                            if (!descriptionHtml) {
                                const descSelectors = [
                                    '[itemprop="description"]',
                                    '.job-description',
                                    '[class*="description"]',
                                    '[class*="job-detail"]',
                                    'article',
                                    '.content',
                                    'main',
                                ];

                                for (const sel of descSelectors) {
                                    const elem = $(sel).first();
                                    if (
                                        elem.length &&
                                        elem.text().trim().length > 100
                                    ) {
                                        descriptionHtml =
                                            String(elem.html()).trim();
                                        break;
                                    }
                                }

                                if (!descriptionHtml) {
                                    const mainContent = $('body')
                                        .find('*')
                                        .filter((i, el) => {
                                            const txt = $(el).text().trim();
                                            return (
                                                txt.length > 200 &&
                                                $(el).children().length > 2
                                            );
                                        })
                                        .first();
                                    if (mainContent.length) {
                                        descriptionHtml = String(
                                            mainContent.html(),
                                        ).trim();
                                    }
                                }
                            }

                            if (descriptionHtml) {
                                // 4) Whitelist allowed tags only
                                const $$ = cheerioLoad(descriptionHtml);
                                const allowedTags = new Set([
                                    'p',
                                    'br',
                                    'strong',
                                    'b',
                                    'i',
                                    'em',
                                    'ul',
                                    'ol',
                                    'li',
                                    'a',
                                    'h1',
                                    'h2',
                                    'h3',
                                    'h4',
                                ]);

                                $$('*').each((i, el) => {
                                    const tag =
                                        (el.tagName || el.name || '')
                                            .toLowerCase()
                                            .trim();
                                    if (!allowedTags.has(tag)) {
                                        $$(el).replaceWith(
                                            $$(el).contents(),
                                        );
                                    }
                                });

                                data.description_html =
                                    $$.root().html()?.trim() || null;
                            }
                        }

                        // Description text
                        data.description_text = data.description_html
                            ? cleanText(data.description_html)
                            : null;

                        // Date posted
                        if (!data.date_posted) {
                            data.date_posted =
                                $('[itemprop="datePosted"]').attr(
                                    'content',
                                ) ||
                                $('[itemprop="datePosted"]')
                                    .first()
                                    .text()
                                    .trim() ||
                                $('time[datetime]').attr('datetime') ||
                                $('time').first().text().trim() ||
                                $('[class*="date"]')
                                    .first()
                                    .text()
                                    .trim() ||
                                null;
                        }

                        // Category extraction
                        let jobCategory = category;
                        if (!jobCategory) {
                            jobCategory =
                                $('[itemprop="occupationalCategory"]')
                                    .first()
                                    .text()
                                    .trim() ||
                                $('[itemprop="jobCategory"]')
                                    .first()
                                    .text()
                                    .trim() ||
                                $('[itemprop="industry"]')
                                    .first()
                                    .text()
                                    .trim() ||
                                null;

                            if (!jobCategory) {
                                const listedEl = $('*:contains("Listed in")')
                                    .filter((i, el) =>
                                        /Listed in/i.test($(el).text()),
                                    )
                                    .first();
                                if (listedEl.length) {
                                    const txt = listedEl
                                        .text()
                                        .replace(
                                            /.*Listed in:?\s*/i,
                                            '',
                                        )
                                        .trim();
                                    if (txt) jobCategory = txt;
                                }
                            }

                            if (!jobCategory) {
                                const catEl = $(
                                    '[class*="category"], [class*="Category"]',
                                ).first();
                                if (catEl.length) {
                                    jobCategory =
                                        catEl.text().trim() || null;
                                }
                            }
                        }

                        jobCategory = cleanLabel(jobCategory);

                        // Optional: light cleanup on company/location
                        data.company = cleanLabel(data.company) || data.company;
                        data.location =
                            cleanLabel(data.location) || data.location;

                        const item = {
                            title: data.title || null,
                            company: data.company || null,
                            category: jobCategory || null,
                            location: data.location || null,
                            salary: data.salary || null,
                            job_type: data.job_type || null,
                            date_posted: data.date_posted || null,
                            description_html: data.description_html || null,
                            description_text: data.description_text || null,
                            url: request.url,
                        };

                        await Dataset.pushData(item);
                        saved++;
                        crawlerLog.info(
                            `Scraped job ${saved}/${RESULTS_WANTED}: ${item.title} at ${
                                item.company || 'Unknown'
                            }`,
                        );
                    } catch (err) {
                        crawlerLog.error(
                            `DETAIL ${request.url} failed: ${err.message}`,
                        );
                        crawlerLog.error(err.stack);
                    }
                }
            },
        });

        await crawler.run(
            initial.map((u) => ({
                url: u,
                userData: { label: 'LIST', pageNo: 1 },
            })),
        );
        log.info(`Finished. Saved ${saved} items`);
    } finally {
        await Actor.exit();
    }
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
