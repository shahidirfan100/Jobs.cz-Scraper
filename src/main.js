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

        const cleanLabel = (txt) => {
            if (!txt) return null;
            let t = String(txt).replace(/\s+/g, ' ').trim();
            if (!t) return null;

            // Filter obvious garbage: CSS snippets, selectors, chrome text
            if (/[{};]/.test(t)) return null;                     // style blocks
            if (/^[-_a-z0-9.#>]+$/i.test(t)) return null;         // pure selector-like text (classes/ids)

            if (/(menu|navigation|nav|cookies?|privacy|terms|home|back to search|jobs\.cz)/i.test(t)) {
                return null;
            }

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
                const catStr = String(cat).trim();
                u.searchParams.set('field[]', catStr);
                log.info(`Filtering by category: "${catStr}"`);
            }

            return u.href;
        };

        function findJobLinks($, base) {
            const links = new Set();
            $('a[href]').each((_, a) => {
                const href = $(a).attr('href');
                if (!href) return;
                const abs = toAbs(href, base);
                if (!abs) return;
                // Jobs.cz job detail URLs look like /rpd/NUMBER/
                if (/\/rpd\/\d+/i.test(abs)) {
                    links.add(abs.split('?')[0]);
                }
            });
            return Array.from(links);
        }

        function hasNextPage($) {
            // Basic detection: any link with ?page=2,3,... present
            const paginationLinks = $('a[href*="page="]');
            if (paginationLinks.length > 0) return true;

            // If there is some explicit "next" disabled element, detect that
            const disabled = $('.pagination .disabled, .pagination-disabled')
                .filter((i, el) => /next/i.test($(el).text()))
                .length > 0;

            return !disabled;
        }

        function buildNextPageUrl(currentUrl, nextPage) {
            try {
                const urlObj = new URL(currentUrl);
                urlObj.searchParams.set('page', String(nextPage));
                return urlObj.href;
            } catch {
                return null;
            }
        }

        function extractFromJsonLd($) {
            const scripts = $('script[type="application/ld+json"]');
            for (let i = 0; i < scripts.length; i++) {
                try {
                    const raw = $(scripts[i]).html() || '';
                    const parsed = JSON.parse(raw);
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
                                (e.jobLocation.address?.addressLocality ||
                                    e.jobLocation.address?.addressRegion)) ||
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
                            salary: salary,
                            job_type: e.employmentType || null,
                        };
                    }
                } catch {
                    // ignore JSON-LD parsing errors
                }
            }
            return null;
        }

        // Resolve initial URLs
        const initial = [];
        if (Array.isArray(startUrls) && startUrls.length) {
            for (const u of startUrls) {
                if (typeof u === 'string') {
                    initial.push(u);
                } else if (u && typeof u.url === 'string') {
                    initial.push(u.url);
                }
            }
        } else if (startUrl) {
            initial.push(startUrl);
        } else if (url) {
            initial.push(url);
        } else {
            initial.push(buildStartUrl(keyword, location, category));
        }

        log.info(`Starting URLs: ${JSON.stringify(initial)}`);

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
            useSessionPool: true,
            maxRequestRetries: 3,
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

                    if (!links.length && pageNo === 1) {
                        crawlerLog.warning(
                            'LIST page 1 returned 0 job links – selectors may be broken or page is JS-only.',
                        );
                    }

                    if (collectDetails) {
                        await enqueueDetail(crawler, links);
                    } else {
                        // If not collecting details, just save the URLs
                        for (const link of links) {
                            if (saved >= RESULTS_WANTED) break;
                            await Dataset.pushData({ url: link });
                            saved++;
                        }
                    }

                    if (saved >= RESULTS_WANTED) {
                        crawlerLog.info(
                            `Reached requested results_wanted (${RESULTS_WANTED}). Not paginating further.`,
                        );
                        return;
                    }

                    if (pageNo >= MAX_PAGES) {
                        crawlerLog.info(
                            `Reached max_pages (${MAX_PAGES}) at ${request.url}. Stopping pagination.`,
                        );
                        return;
                    }

                    if (hasNextPage($)) {
                        const nextPageNo = pageNo + 1;
                        const nextUrl = buildNextPageUrl(request.url, nextPageNo);
                        if (nextUrl) {
                            crawlerLog.info(
                                `Enqueuing LIST page ${nextPageNo} -> ${nextUrl}`,
                            );
                            await crawler.addRequests([
                                {
                                    url: nextUrl,
                                    userData: { label: 'LIST', pageNo: nextPageNo },
                                },
                            ]);
                        }
                    } else {
                        crawlerLog.info(
                            `No next page detected from ${request.url} (page ${pageNo}).`,
                        );
                    }

                    return;
                }

                // DETAIL handler
                if (label === 'DETAIL') {
                    crawlerLog.debug(`DETAIL page at ${request.url}`);

                    let data = extractFromJsonLd($) || {};

                    // Title
                    if (!data.title) {
                        data.title =
                            $('h1')
                                .first()
                                .text()
                                .trim() ||
                            $('[class*="job-title"]')
                                .first()
                                .text()
                                .trim() ||
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
                            $('[class*="company-name"]')
                                .first()
                                .text()
                                .trim() ||
                            null;
                    }

                    // Location
                    if (!data.location) {
                        data.location =
                            $('[itemprop="jobLocation"] [itemprop="addressLocality"]')
                                .first()
                                .text()
                                .trim() ||
                            $('[itemprop="jobLocation"] [itemprop="addressRegion"]')
                                .first()
                                .text()
                                .trim() ||
                            $('[class*="location"]')
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
                            $('[class*="salary"]')
                                .first()
                                .text()
                                .trim() ||
                            null;

                        if (!data.salary) {
                            // Heuristic: look for something with Kč and range
                            const salaryCandidate = $('*')
                                .filter((i, el) => {
                                    const txt = $(el).text();
                                    return /\d+\s*(?:000)?\s*(?:-|–|až)\s*\d+\s*(?:000)?\s*Kč/i.test(
                                        txt,
                                    );
                                })
                                .first()
                                .text()
                                .trim();
                            if (salaryCandidate) data.salary = salaryCandidate;
                        }
                    }

                    // Job type / Employment form extraction
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

                            const filtered = parts.filter((p) => allowedRe.test(p));

                            if (filtered.length) {
                                jt = filtered.join(', ');
                            }
                        }

                        data.job_type = jt || null;
                    }

                    // Description
                    if (!data.description_html) {
                        const descSelectors = [
                            '[itemprop="description"]',
                            '.job-description',
                            '[class*="description"]',
                            '[class*="job-detail"]',
                            'article',
                            '.content',
                        ];

                        for (const sel of descSelectors) {
                            const el = $(sel).first();
                            if (el.length) {
                                data.description_html = el.html() || el.text();
                                break;
                            }
                        }

                        if (!data.description_html) {
                            // Fallback: main content area
                            const mainEl = $('main').first();
                            if (mainEl.length) {
                                data.description_html = mainEl.html() || mainEl.text();
                            }
                        }
                    }

                    data.description_text = cleanText(data.description_html || $.html());

                    // Date posted
                    if (!data.date_posted) {
                        const dateCandidates = [
                            $('[itemprop="datePosted"]').attr('content'),
                            $('[itemprop="datePosted"]').text().trim(),
                            $('time[datetime]').attr('datetime'),
                            $('time').first().text().trim(),
                        ].filter(Boolean);

                        if (dateCandidates.length) {
                            data.date_posted = dateCandidates[0];
                        }
                    }

                    // Category extraction from page if not provided
                    let jobCategory = category;
                    if (!jobCategory) {
                        // Prefer structured microdata if present
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

                        // Fallback: textual "Listed in: Something" patterns
                        if (!jobCategory) {
                            const listedEl = $('*:contains("Listed in")')
                                .filter((i, el) =>
                                    /Listed in/i.test($(el).text()),
                                )
                                .first();

                            if (listedEl.length) {
                                const txt = listedEl
                                    .text()
                                    .replace(/.*Listed in:?\s*/i, '')
                                    .trim();
                                if (txt) jobCategory = txt;
                            }
                        }

                        // Last resort: generic category-like containers
                        if (!jobCategory) {
                            const catEl = $('[class*="category"], [class*="Category"]').first();
                            if (catEl.length) {
                                jobCategory = catEl.text().trim() || null;
                            }
                        }
                    }

                    // Final cleanup of category label
                    jobCategory = cleanLabel(jobCategory);

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
                        `Saved job ${saved}/${RESULTS_WANTED} from ${request.url}`,
                    );

                    if (saved >= RESULTS_WANTED) {
                        crawlerLog.info(
                            `Reached requested results_wanted (${RESULTS_WANTED}).`,
                        );
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
