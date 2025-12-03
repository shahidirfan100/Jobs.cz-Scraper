// Jobs.cz scraper - CheerioCrawler implementation
import { Actor, log } from 'apify';
import { CheerioCrawler, Dataset } from 'crawlee';
import { load as cheerioLoad } from 'cheerio';

Actor.main(async () => {
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

        // Remove CSS-like garbage
        if (/[{};]/.test(t)) return null;
        if (/^[-_a-z0-9.#>]+$/i.test(t)) return null;

        // Navigation / chrome / global actions
        if (/(menu|navigation|nav|cookies?|privacy|terms|home|jobs\.cz|Pro firmy|Přihlásit|Nabídky práce|Brigády|Inspirace|Zaměstnavatelé|Vytvořit si životopis)/i.test(t)) {
            return null;
        }

        if (t.length < 2 || t.length > 120) return null;
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

    const extractFromJsonLd = ($) => {
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
    };

    const findJobLinks = ($, base) => {
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
    };

    const hasNextPage = ($) => {
        const nextBtn = $('a[rel="next"]').length > 0;
        const paginationLinks = $('a[href*="page="]').length > 0;
        const disabledNext =
            $('.pagination .disabled:contains("›")').length > 0 ||
            $('.pagination .disabled:contains("Další")').length > 0;
        return (nextBtn || paginationLinks) && !disabledNext;
    };

    const findNextPage = (baseUrl, currentPage) => {
        const nextPage = currentPage + 1;
        try {
            const urlObj = new URL(baseUrl);
            urlObj.searchParams.set('page', String(nextPage));
            return urlObj.href;
        } catch (err) {
            log.warning(`Failed to construct next page URL from ${baseUrl}: ${err.message}`);
            return null;
        }
    };

    // Focused job-body extractor that avoids header/nav/footer and modals
    const extractDescriptionHtml = ($) => {
        // Remove obvious non-description areas before we pick any content
        $(
            'header, nav, footer, form, aside, ' +
                '.Header, .HeaderNav, .HeaderNavItem, [class*="Header"], [class*="Nav"], ' +
                '.Footer, [class*="footer"], ' +
                '.Alert, ' +
                '[role="dialog"], [class*="Modal"], [id*="modal"], ' +
                '.JobDescriptionSendAdToEmailModal, .TextField, .TextArea, ' +
                '.Cookie, [class*="cookie"]',
        ).remove();

        let descriptionHtml = null;

        // 1) Czech pattern: Úvodní představení / Pracovní nabídka -> Informace o pozici
        const start = $('*:contains("Úvodní představení"), *:contains("Pracovní nabídka")')
            .filter((i, el) =>
                /Úvodní představení|Pracovní nabídka/i.test($(el).text()),
            )
            .first();
        const end = $('*:contains("Informace o pozici")')
            .filter((i, el) => /Informace o pozici/i.test($(el).text()))
            .first();

        if (start.length && end.length) {
            const parts = [];
            let current = start.next();
            while (current.length && current[0] !== end[0]) {
                parts.push($.html(current));
                current = current.next();
            }
            descriptionHtml = parts.join('\n').trim() || null;
        }

        // 2) English-ish fallback: Job description / Job offer -> Position information
        if (!descriptionHtml) {
            const startEn = $('*:contains("Job description"), *:contains("Job offer")')
                .filter((i, el) =>
                    /Job description|Job offer/i.test($(el).text()),
                )
                .first();
            const endEn = $('*:contains("Position information"), *:contains("About the position")')
                .filter((i, el) =>
                    /Position information|About the position/i.test(
                        $(el).text(),
                    ),
                )
                .first();

            if (startEn.length && endEn.length) {
                const parts = [];
                let current = startEn.next();
                while (current.length && current[0] !== endEn[0]) {
                    parts.push($.html(current));
                    current = current.next();
                }
                descriptionHtml = parts.join('\n').trim() || null;
            }
        }

        // 3) Heuristic fallback: biggest "job-looking" content block
        if (!descriptionHtml) {
            const jobKeywords = /(Náplň práce|Požadujeme|Co nabízíme|Co u nás získáte|Co vás čeká|Job description|Responsibilities|We offer|Requirements)/i;
            const headerWords = /(Nabídky práce|Brigády|Inspirace|Zaměstnavatelé|Vytvořit si životopis|Pro firmy)/i;

            const candidates = [];
            $('main, article, section, div').each((i, el) => {
                const html = $(el).html();
                if (!html) return;
                const text = cleanText(html);
                const len = text.length;
                if (len < 300) return; // ignore tiny blocks
                if (headerWords.test(text)) return; // looks like nav
                if (!jobKeywords.test(text)) return; // doesn't look like job body

                const depth = $(el).parents().length;
                const score = len - depth * 40; // prefer deeper but big content
                candidates.push({ el, score });
            });

            if (candidates.length) {
                candidates.sort((a, b) => b.score - a.score);
                const best = candidates[0].el;
                descriptionHtml = $(best).html()?.trim() || null;
            }
        }

        if (!descriptionHtml) return null;

        // 4) Whitelist only the tags we care about
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

        $$('*').each((_, el) => {
            const tagName = (el.tagName || el.name || '').toLowerCase();
            if (!allowedTags.has(tagName)) {
                $$(el).replaceWith($$(el).contents());
            }
        });

        return $$.root().html()?.trim() || null;
    };

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
                    const uniqueLinks = dedupe
                        ? links.filter((l) => !seenUrls.has(l))
                        : links;
                    uniqueLinks.forEach((l) => seenUrls.add(l));
                    const toPush = uniqueLinks
                        .slice(0, Math.max(0, remaining))
                        .map((u) => ({ url: u, _source: 'jobs.cz' }));
                    if (toPush.length) {
                        await Dataset.pushData(toPush);
                        saved += toPush.length;
                    }
                }

                if (saved < RESULTS_WANTED && pageNo < MAX_PAGES && links.length > 0) {
                    const more = hasNextPage($);
                    if (more) {
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

            // DETAIL handler
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
                        // microdata
                        data.job_type =
                            $('[itemprop="employmentType"]')
                                .first()
                                .text()
                                .trim() || null;

                        // dt/dd: "Employment form" / "Forma spolupráce" / "Typ úvazku"
                        if (!data.job_type) {
                            const dt = $('dt:contains("Employment form"), dt:contains("Forma spolupráce"), dt:contains("Typ úvazku"), dt:contains("Úvazek")')
                                .filter((i, el) =>
                                    /Employment form|Forma spolupráce|Typ úvazku|Úvazek/i.test(
                                        $(el).text(),
                                    ),
                                )
                                .first();
                            if (dt.length) {
                                const dd = dt.nextAll('dd')
                                    .filter((i, el) => $(el).text().trim().length)
                                    .first();
                                if (dd.length) {
                                    data.job_type = dd.text().trim();
                                }
                            }
                        }

                        // Generic label + next text
                        if (!data.job_type) {
                            const labelEl = $('*:contains("Employment form"), *:contains("Forma spolupráce"), *:contains("Typ úvazku"), *:contains("Úvazek")')
                                .filter((i, el) =>
                                    /Employment form|Forma spolupráce|Typ úvazku|Úvazek/i.test(
                                        $(el).text(),
                                    ),
                                )
                                .first();
                            if (labelEl.length) {
                                const valEl = labelEl
                                    .nextAll()
                                    .filter(
                                        (i, el) =>
                                            $(el).text().trim().length > 0,
                                    )
                                    .first();
                                if (valEl.length) {
                                    data.job_type = valEl.text().trim();
                                }
                            }
                        }

                        // Heuristic: look for typical job-type words
                        if (!data.job_type) {
                            const jtCandidate = $('*')
                                .filter((i, el) => {
                                    const txt = $(el).text().trim();
                                    if (!txt || txt.length > 80) return false;
                                    return /(full[- ]?time|part[- ]?time|brigáda|HPP|DPP|DPČ|plný úvazek|zkrácený úvazek|remote|home office|stáž|internship)/i.test(
                                        txt,
                                    );
                                })
                                .first()
                                .text()
                                .trim();
                            if (jtCandidate) data.job_type = jtCandidate;
                        }
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
                                /(full[- ]?time|part[- ]?time|intern|temporary|contract|freelance|brigáda|HPP|DPP|DPČ|remote|home[- ]?office|plný úvazek|zkrácený úvazek|stáž)/i;
                            const filtered = parts.filter((p) =>
                                allowedRe.test(p),
                            );
                            if (filtered.length) jt = filtered.join(', ');
                        }
                        data.job_type = jt || null;
                    }

                    // DESCRIPTION HTML + TEXT (main job body, no header/nav/modal)
                    if (!data.description_html) {
                        data.description_html = extractDescriptionHtml($);
                    }
                    data.description_text = data.description_html
                        ? cleanText(data.description_html)
                        : null;

                    // Date posted
                    if (!data.date_posted) {
                        data.date_posted =
                            $('[itemprop="datePosted"]').attr('content') ||
                            $('[itemprop="datePosted"]')
                                .first()
                                .text()
                                .trim() ||
                            $('time[datetime]')
                                .first()
                                .attr('datetime') ||
                            $('time')
                                .filter((i, el) =>
                                    /Datum zveřejnění|Zveřejněno|Posted/i.test(
                                        $(el).text(),
                                    ),
                                )
                                .first()
                                .attr('datetime') ||
                            $('time')
                                .first()
                                .text()
                                .trim() ||
                            null;

                        // Extra CZ pattern: "Datum zveřejnění: 12.05.2025"
                        if (!data.date_posted) {
                            const dateEl = $('*:contains("Datum zveřejnění")')
                                .filter((i, el) =>
                                    /Datum zveřejnění/i.test($(el).text()),
                                )
                                .first();
                            if (dateEl.length) {
                                const text = dateEl.text();
                                const m =
                                    text.match(
                                        /(\d{1,2}\.\s*\d{1,2}\.\s*\d{4})/,
                                    ) || text.match(/(\d{4}-\d{2}-\d{2})/);
                                if (m) data.date_posted = m[1];
                            }
                        }
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
                                    .replace(/.*Listed in:?\s*/i, '')
                                    .trim();
                                if (txt) jobCategory = txt;
                            }
                        }

                        if (!jobCategory) {
                            const catEl = $(
                                '[class*="category"], [class*="Category"]',
                            ).first();
                            if (catEl.length) {
                                jobCategory = catEl.text().trim() || null;
                            }
                        }
                    }

                    jobCategory = cleanLabel(jobCategory);

                    // Optional: light cleanup on company/location
                    data.company = cleanLabel(data.company) || data.company;
                    data.location = cleanLabel(data.location) || data.location;

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
});
